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

interface QueuedTurn {
  id: string
  content: ContentBlock[]
  cancelled: boolean
  active: boolean
}

interface TurnLane {
  turns: QueuedTurn[]
  latest: QueuedTurn | null
  active: QueuedTurn | null
  draining: boolean
}

// Owns the live AgentProcess for each session. Callers ask for a process
// by sessionId; supervisor lazily spawns one if none exists. Also owns
// turn identity: every prompt gets a turnId, and aborts are gated
// against the current turn so a stale abort can never cancel the turn
// that replaced its target (issue #36's "abort ricochet").
export class AgentSupervisor {
  private readonly processes = new Map<string, AgentProcess>()
  private readonly spawning = new Map<string, Promise<AgentProcess>>()
  private readonly processGenerations = new Map<string, symbol>()
  private readonly lanes = new Map<string, TurnLane>()
  private readonly closing = new Set<string>()

  constructor(private readonly deps: SupervisorDeps) {}

  // Submit a prompt as a new turn. Returns the minted turnId once the
  // prompt is handed to the adapter; the turn itself runs fire-and-forget
  // and its events stream over the bus.
  async prompt(sessionId: string, content: ContentBlock[]): Promise<{ turnId: string }> {
    await this.ensure(sessionId)
    if (this.closing.has(sessionId)) throw new Error(`session ${sessionId} is closing`)
    const turnId = randomUUID()
    const lane = this.lane(sessionId)
    const previous = lane.latest
    const turn: QueuedTurn = { id: turnId, content, cancelled: false, active: false }
    if (previous) {
      previous.cancelled = true
      if (previous.active) {
        const proc = this.processes.get(sessionId)
        if (proc) {
          proc.cancel(previous.id).catch((err) => {
            this.deps.log.warn({ err, sessionId, turnId: previous.id }, 'supersede failed')
          })
        }
      }
    }
    lane.turns.push(turn)
    lane.latest = turn
    // Flip to 'running' immediately so concurrent list readers see the
    // in-flight turn before the first event lands; the emit hook keeps
    // status in sync from here on.
    this.deps.sessionStore.applyStatus(sessionId, 'running')
    if (!lane.draining) void this.drainLane(sessionId, lane)
    return { turnId }
  }

  // Abort the in-flight turn. With a turnId, only that turn is targeted —
  // aborting a turn that already ended or was superseded is a no-op, so
  // clients can steer without racing the turn they're about to start.
  // Without a turnId, aborts whatever turn is currently in flight.
  async abort(sessionId: string, turnId?: string): Promise<AbortResult> {
    const lane = this.lanes.get(sessionId)
    const current = lane?.latest
    if (!current) return { status: 'no_active_turn' }
    if (turnId !== undefined && turnId !== current.id) return { status: 'turn_not_current' }
    current.cancelled = true
    if (!current.active) return { status: 'aborted', turnId: current.id }
    const proc = this.processes.get(sessionId)
    if (!proc) return { status: 'no_active_turn' }
    try {
      const accepted = await proc.cancel(current.id)
      return accepted
        ? { status: 'aborted', turnId: current.id }
        : { status: 'no_active_turn' }
    } catch (err) {
      this.deps.log.warn({ err, sessionId, turnId: current.id }, 'abort failed')
      return { status: 'no_active_turn' }
    }
  }

  private lane(sessionId: string): TurnLane {
    let lane = this.lanes.get(sessionId)
    if (!lane) {
      lane = { turns: [], latest: null, active: null, draining: false }
      this.lanes.set(sessionId, lane)
    }
    return lane
  }

  private async drainLane(sessionId: string, lane: TurnLane): Promise<void> {
    lane.draining = true
    try {
      while (lane.turns.length > 0) {
        if (this.closing.has(sessionId)) return
        const turn = lane.turns.shift()!
        turn.active = true
        lane.active = turn
        if (turn.cancelled) {
          this.emit(sessionId, turn.id, { kind: 'user_message_chunk', content: turn.content })
          this.emit(sessionId, turn.id, { kind: 'stop', reason: 'cancelled' })
        } else {
          let proc: AgentProcess
          try {
            proc = await this.ensure(sessionId)
          } catch (err) {
            this.deps.log.error({ err, sessionId, turnId: turn.id }, 'agent spawn failed')
            this.emit(sessionId, turn.id, { kind: 'user_message_chunk', content: turn.content })
            this.emit(sessionId, turn.id, { kind: 'stop', reason: 'error' })
            turn.active = false
            lane.active = null
            if (lane.latest === turn) lane.latest = null
            continue
          }
          if (turn.cancelled) {
            this.emit(sessionId, turn.id, { kind: 'user_message_chunk', content: turn.content })
            this.emit(sessionId, turn.id, { kind: 'stop', reason: 'cancelled' })
          } else {
            try {
              await proc.prompt(turn.id, turn.content)
            } catch (err) {
              this.deps.log.error({ err, sessionId, turnId: turn.id }, 'prompt failed')
              this.emit(sessionId, turn.id, { kind: 'user_message_chunk', content: turn.content })
              this.emit(sessionId, turn.id, { kind: 'stop', reason: 'error' })
            }
          }
        }
        turn.active = false
        lane.active = null
        if (lane.latest === turn) lane.latest = null
      }
    } finally {
      lane.draining = false
      if (lane.turns.length > 0 && !this.closing.has(sessionId)) void this.drainLane(sessionId, lane)
      else if (!lane.latest) this.lanes.delete(sessionId)
    }
  }

  private emit(sessionId: string, turnId: string | null, update: import('../types.js').SessionUpdate): void {
    const stamped = turnId === null ? update : { ...update, turnId }
    const latest = this.lanes.get(sessionId)?.latest
    const stale = turnId !== null && turnId !== latest?.id
    const event = this.deps.eventStore.append(sessionId, stamped)
    const nextStatus = stale ? null : statusFromEvent(event.kind)
    if (nextStatus) this.deps.sessionStore.applyStatus(sessionId, nextStatus)
    this.deps.bus.publish(event)
  }

  // Get an already-running process, or spawn one if needed.
  async ensure(sessionId: string): Promise<AgentProcess> {
    if (this.closing.has(sessionId)) throw new Error(`session ${sessionId} is closing`)
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

    const generation = Symbol(sessionId)
    this.processGenerations.set(sessionId, generation)
    const promise = (async () => {
      const proc = await factory.spawn(session, {
        log: this.deps.log.child({ sessionId, agent: session.agent }),
        delegate,
        emit: (turnId, update) => {
          if (this.processGenerations.get(sessionId) !== generation) return
          this.emit(sessionId, turnId, update)
        },
        markDead: (reason) => {
          if (this.processGenerations.get(sessionId) !== generation) return
          // Subprocess exited unexpectedly. Drop the handle so the
          // next prompt respawns; emit an event so clients render a
          // "agent crashed, send a prompt to restart" affordance.
          const dead = this.processes.get(sessionId)
          this.processes.delete(sessionId)
          this.processGenerations.delete(sessionId)
          this.deps.delegateTokens.revoke(sessionId)
          // Best-effort release of whatever the half-dead harness still
          // holds (subprocess trees, subscriptions, timers) — a dropped
          // handle would otherwise leak them for the daemon's lifetime.
          if (dead) {
            dead.close().catch((err) => {
              this.deps.log.warn({ err, sessionId }, 'close of dead agent failed')
            })
          }
          const current = this.lanes.get(sessionId)?.active
          const event = this.deps.eventStore.append(sessionId, {
            kind: 'subprocess_died',
            reason,
            ...(current ? { turnId: current.id } : {}),
          })
          this.deps.sessionStore.applyStatus(sessionId, 'error')
          this.deps.bus.publish(event)
          this.deps.log.warn({ sessionId, reason }, 'agent subprocess died unexpectedly')
        },
      })
      if (this.processGenerations.get(sessionId) !== generation || this.closing.has(sessionId)) {
        await proc.close().catch(() => {})
        throw new Error(`session ${sessionId} closed while agent was spawning`)
      }
      this.processes.set(sessionId, proc)
      return proc
    })()

    this.spawning.set(sessionId, promise)
    try {
      return await promise
    } finally {
      if (this.spawning.get(sessionId) === promise) this.spawning.delete(sessionId)
      if (!this.processes.has(sessionId) && this.processGenerations.get(sessionId) === generation) {
        this.processGenerations.delete(sessionId)
      }
    }
  }

  get(sessionId: string): AgentProcess | undefined {
    return this.processes.get(sessionId)
  }

  async closeOne(sessionId: string): Promise<void> {
    this.closing.add(sessionId)
    this.deps.delegateTokens.revoke(sessionId)
    const lane = this.lanes.get(sessionId)
    if (lane) {
      lane.turns.length = 0
      lane.latest = null
    }
    this.processGenerations.delete(sessionId)
    const spawning = this.spawning.get(sessionId)
    if (spawning) await spawning.catch(() => {})
    const proc = this.processes.get(sessionId)
    this.lanes.delete(sessionId)
    if (!proc) return
    this.processes.delete(sessionId)
    try {
      await proc.close()
    } catch (err) {
      this.deps.log.warn({ err, sessionId }, 'agent close failed')
    }
  }

  async closeAll(): Promise<void> {
    const ids = Array.from(new Set([...this.processes.keys(), ...this.spawning.keys()]))
    await Promise.allSettled(ids.map((id) => this.closeOne(id)))
  }
}
