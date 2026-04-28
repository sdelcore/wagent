import type { FastifyBaseLogger } from 'fastify'
import type { AgentFactory, AgentProcess } from './process.js'
import type { EventStore } from '../events/store.js'
import type { SessionStore } from '../sessions/store.js'
import type { SessionBus } from '../bus.js'
import type { AgentKind } from '../types.js'
import type { DelegateTokenStore } from './delegate_tokens.js'

export interface SupervisorDeps {
  sessionStore: SessionStore
  eventStore: EventStore
  bus: SessionBus
  log: FastifyBaseLogger
  factories: Partial<Record<AgentKind, AgentFactory>>
  delegateTokens: DelegateTokenStore
  // Loopback URL the daemon is reachable at (e.g. http://127.0.0.1:2468).
  // Used to build the delegate-MCP endpoint URL for harness MCP configs.
  delegateBaseUrl: string
}

// Owns the live AgentProcess for each session. Callers ask for a process
// by sessionId; supervisor lazily spawns one if none exists.
export class AgentSupervisor {
  private readonly processes = new Map<string, AgentProcess>()
  private readonly spawning = new Map<string, Promise<AgentProcess>>()

  constructor(private readonly deps: SupervisorDeps) {}

  // Get an already-running process, or spawn one if needed.
  async ensure(sessionId: string): Promise<AgentProcess> {
    const existing = this.processes.get(sessionId)
    if (existing) return existing

    const inFlight = this.spawning.get(sessionId)
    if (inFlight) return inFlight

    const session = this.deps.sessionStore.get(sessionId)
    if (!session) throw new Error(`session ${sessionId} not found`)
    if (session.destroyedAt !== null) {
      throw new Error(`session ${sessionId} is destroyed`)
    }

    const factory = this.deps.factories[session.agent]
    if (!factory) throw new Error(`no factory registered for agent ${session.agent}`)

    // Mint a delegate token for this session so it can spawn children
    // through the delegate-MCP endpoint. Token is revoked on closeOne.
    const token = this.deps.delegateTokens.mint(session.id, session.delegationDepth)
    const delegate = {
      url: `${this.deps.delegateBaseUrl}/mcp/delegate/${session.id}`,
      token,
    }

    const promise = (async () => {
      const proc = await factory.spawn(session, {
        log: this.deps.log.child({ sessionId, agent: session.agent }),
        delegate,
        emit: (update) => {
          // Persist first so SSE replay can find it, then publish live.
          const event = this.deps.eventStore.append(sessionId, update)
          this.deps.bus.publish(event)
        },
        markDead: (reason) => {
          // Subprocess exited unexpectedly. Drop the handle so the
          // next prompt respawns; emit an event so clients render a
          // "agent crashed, send a prompt to restart" affordance.
          this.processes.delete(sessionId)
          this.deps.delegateTokens.revoke(sessionId)
          const event = this.deps.eventStore.append(sessionId, {
            kind: 'subprocess_died',
            reason,
          })
          this.deps.bus.publish(event)
          this.deps.log.warn({ sessionId, reason }, 'agent subprocess died unexpectedly')
        },
      })
      this.processes.set(sessionId, proc)
      return proc
    })()

    this.spawning.set(sessionId, promise)
    try {
      return await promise
    } finally {
      this.spawning.delete(sessionId)
    }
  }

  get(sessionId: string): AgentProcess | undefined {
    return this.processes.get(sessionId)
  }

  async closeOne(sessionId: string): Promise<void> {
    const proc = this.processes.get(sessionId)
    this.deps.delegateTokens.revoke(sessionId)
    if (!proc) return
    this.processes.delete(sessionId)
    try {
      await proc.close()
    } catch (err) {
      this.deps.log.warn({ err, sessionId }, 'agent close failed')
    }
  }

  async closeAll(): Promise<void> {
    const ids = Array.from(this.processes.keys())
    await Promise.allSettled(ids.map((id) => this.closeOne(id)))
  }
}
