import { randomUUID } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'
import type { AgentFactory, AgentProcess } from './process.js'
import type { EventStore } from '../events/store.js'
import type { SessionStore } from '../sessions/store.js'
import type { SessionBus } from '../bus.js'
import type { AgentKind, ContentBlock } from '../types.js'
import { statusFromEvent } from '../types.js'
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

export type AbortResult =
  | { status: 'aborted'; turnId: string }
  | { status: 'no_active_turn' }
  | { status: 'turn_not_current' }

// Owns the live AgentProcess for each session. Callers ask for a process
// by sessionId; supervisor lazily spawns one if none exists. Also owns
// turn identity: every prompt gets a turnId, and aborts are gated
// against the current turn so a stale abort can never cancel the turn
// that replaced its target (issue #36's "abort ricochet").
export class AgentSupervisor {
  private readonly processes = new Map<string, AgentProcess>()
  private readonly spawning = new Map<string, Promise<AgentProcess>>()
  private readonly currentTurns = new Map<string, string>()

  constructor(private readonly deps: SupervisorDeps) {}

  // Submit a prompt as a new turn. Returns the minted turnId once the
  // prompt is handed to the adapter; the turn itself runs fire-and-forget
  // and its events stream over the bus.
  async prompt(sessionId: string, content: ContentBlock[]): Promise<{ turnId: string }> {
    const proc = await this.ensure(sessionId)
    const turnId = randomUUID()
    this.currentTurns.set(sessionId, turnId)
    // Flip to 'running' immediately so concurrent list readers see the
    // in-flight turn before the first event lands; the emit hook keeps
    // status in sync from here on.
    this.deps.sessionStore.applyStatus(sessionId, 'running')
    proc.prompt(turnId, content).catch((err) => {
      this.deps.log.error({ err, sessionId, turnId }, 'prompt failed')
      if (this.currentTurns.get(sessionId) === turnId) this.currentTurns.delete(sessionId)
    })
    return { turnId }
  }

  // Abort the in-flight turn. With a turnId, only that turn is targeted —
  // aborting a turn that already ended or was superseded is a no-op, so
  // clients can steer without racing the turn they're about to start.
  // Without a turnId, aborts whatever turn is currently in flight.
  async abort(sessionId: string, turnId?: string): Promise<AbortResult> {
    const proc = this.processes.get(sessionId)
    const current = this.currentTurns.get(sessionId)
    if (!proc || current === undefined) return { status: 'no_active_turn' }
    if (turnId !== undefined && turnId !== current) return { status: 'turn_not_current' }
    try {
      await proc.cancel(current)
    } catch (err) {
      this.deps.log.warn({ err, sessionId, turnId: current }, 'abort failed')
    }
    return { status: 'aborted', turnId: current }
  }

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
          const current = this.currentTurns.get(sessionId)
          // Adapters stamp the boundary events themselves; back-fill
          // everything else with the current turn so mid-turn events
          // (chunks, tool calls, permissions) are attributable.
          const stamped =
            update.turnId !== undefined || current === undefined
              ? update
              : { ...update, turnId: current }
          // A stop for a turn that is no longer current (superseded, or
          // the process already died) still terminates its turn on the
          // wire, but must not flip session status — a newer turn may be
          // live, or the session is in 'error' after subprocess_died.
          const staleStop = stamped.kind === 'stop' && stamped.turnId !== current
          if (stamped.kind === 'stop' && !staleStop) this.currentTurns.delete(sessionId)
          // Persist first so SSE replay can find it, then publish live.
          const event = this.deps.eventStore.append(sessionId, stamped)
          const nextStatus = staleStop ? null : statusFromEvent(event.kind)
          if (nextStatus) this.deps.sessionStore.applyStatus(sessionId, nextStatus)
          this.deps.bus.publish(event)
        },
        markDead: (reason) => {
          // Subprocess exited unexpectedly. Drop the handle so the
          // next prompt respawns; emit an event so clients render a
          // "agent crashed, send a prompt to restart" affordance.
          const dead = this.processes.get(sessionId)
          this.processes.delete(sessionId)
          this.deps.delegateTokens.revoke(sessionId)
          // Best-effort release of whatever the half-dead harness still
          // holds (subprocess trees, subscriptions, timers) — a dropped
          // handle would otherwise leak them for the daemon's lifetime.
          if (dead) {
            dead.close().catch((err) => {
              this.deps.log.warn({ err, sessionId }, 'close of dead agent failed')
            })
          }
          const current = this.currentTurns.get(sessionId)
          this.currentTurns.delete(sessionId)
          const event = this.deps.eventStore.append(sessionId, {
            kind: 'subprocess_died',
            reason,
            ...(current !== undefined ? { turnId: current } : {}),
          })
          this.deps.sessionStore.applyStatus(sessionId, 'error')
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
    this.currentTurns.delete(sessionId)
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
