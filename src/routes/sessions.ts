import type { FastifyInstance, FastifyReply } from 'fastify'
import type { SessionStore } from '../sessions/store.js'
import type { EventStore } from '../events/store.js'
import type { SessionBus } from '../bus.js'
import type { AgentSupervisor } from '../agent/supervisor.js'
import { probeAgent } from '../agent/availability.js'
import { buildForkSeed, VALID_FORK_MODES, type ForkMode } from '../sessions/fork.js'
import { validateSessionOptions } from '../sessions/options.js'
import {
  MAX_DELEGATION_DEPTH,
  type AgentKind,
  type ApiError,
  type DelegationMode,
  type EventEnvelope,
} from '../types.js'

const VALID_AGENTS: AgentKind[] = ['claude', 'pi', 'echo']
const VALID_DELEGATION_MODES: DelegationMode[] = ['sync', 'background']

// Cap the number of parent events we walk when building a fork seed.
// Forks are lossy by design; pulling unbounded history hurts both the
// summary signal and the response time on a long session. 4000 events
// is enough for the realistic conversational tail without risking the
// 2000-row default `EventStore.list` limit hiding the older context.
const MAX_FORK_EVENTS = 4000

// Page size used while walking parent events for a fork. Matches the
// EventStore.list default; multiple pages get glued together in order.
const FORK_EVENT_PAGE = 500

function bad(reply: FastifyReply, status: number, code: string, message: string): ApiError {
  reply.code(status)
  return { error: { code, message } }
}

function validateCwd(cwd: unknown): string | null {
  if (typeof cwd !== 'string') return null
  const trimmed = cwd.trim()
  if (trimmed.length === 0) return null
  if (trimmed.startsWith('~')) return null
  if (!trimmed.startsWith('/')) return null
  return trimmed
}

export interface SessionsDeps {
  sessionStore: SessionStore
  eventStore: EventStore
  bus: SessionBus
  supervisor: AgentSupervisor
}

export function registerSessionRoutes(app: FastifyInstance, deps: SessionsDeps) {
  const store = deps.sessionStore
  app.get('/v1/sessions', async (req) => {
    const q = (req.query as { destroyed?: string; parentSessionId?: string }) ?? {}
    const includeDestroyed = q.destroyed === 'true'
    const parentSessionId = typeof q.parentSessionId === 'string' ? q.parentSessionId : undefined
    return { sessions: store.list({ includeDestroyed, parentSessionId }) }
  })

  app.post<{
    Body: {
      agent?: string
      cwd?: string
      alias?: string | null
      model?: string | null
      parentSessionId?: string | null
      parentToolCallId?: string | null
      delegationMode?: string | null
      options?: unknown
    }
  }>('/v1/sessions', async (req, reply) => {
    const body = req.body ?? {}
    const agent = body.agent
    if (typeof agent !== 'string' || !VALID_AGENTS.includes(agent as AgentKind)) {
      return bad(reply, 400, 'invalid_agent', `agent must be one of ${VALID_AGENTS.join(', ')}`)
    }
    // Precheck: refuse early if the agent isn't available on this host
    // so the caller gets a meaningful error code instead of a 500 at
    // subprocess spawn time.
    const availability = await probeAgent(agent as AgentKind)
    if (!availability.installed) {
      return bad(
        reply,
        409,
        'agent_not_available',
        availability.notes ?? `agent ${agent} is not available on this host`,
      )
    }
    const cwd = validateCwd(body.cwd)
    if (!cwd) {
      return bad(
        reply,
        400,
        'invalid_cwd',
        'cwd must be an absolute path (no ~ expansion, no relative paths)',
      )
    }
    const optionsResult = validateSessionOptions(body.options)
    if (!optionsResult.ok) {
      return bad(reply, 400, optionsResult.code, optionsResult.message)
    }
    // Delegation fields. If parentSessionId is set, validate the parent
    // exists, isn't destroyed, and the resulting depth is within the cap.
    let delegationDepth = 0
    let parentSessionId: string | null = null
    let parentToolCallId: string | null = null
    let delegationMode: DelegationMode | null = null
    if (body.parentSessionId) {
      if (typeof body.parentSessionId !== 'string') {
        return bad(reply, 400, 'invalid_parent', 'parentSessionId must be a string')
      }
      const parent = store.get(body.parentSessionId)
      if (!parent) {
        return bad(reply, 404, 'parent_not_found', `parent session ${body.parentSessionId} not found`)
      }
      if (parent.destroyedAt !== null) {
        return bad(reply, 410, 'parent_destroyed', 'parent session is destroyed')
      }
      delegationDepth = parent.delegationDepth + 1
      if (delegationDepth > MAX_DELEGATION_DEPTH) {
        return bad(
          reply,
          400,
          'depth_cap_exceeded',
          `delegationDepth ${delegationDepth} exceeds cap ${MAX_DELEGATION_DEPTH}`,
        )
      }
      parentSessionId = parent.id
      parentToolCallId =
        typeof body.parentToolCallId === 'string' ? body.parentToolCallId : null
      if (body.delegationMode !== undefined && body.delegationMode !== null) {
        if (
          typeof body.delegationMode !== 'string' ||
          !VALID_DELEGATION_MODES.includes(body.delegationMode as DelegationMode)
        ) {
          return bad(
            reply,
            400,
            'invalid_delegation_mode',
            `delegationMode must be one of ${VALID_DELEGATION_MODES.join(', ')}`,
          )
        }
        delegationMode = body.delegationMode as DelegationMode
      } else {
        delegationMode = 'sync'
      }
    }
    const session = store.create({
      agent: agent as AgentKind,
      cwd,
      alias: typeof body.alias === 'string' ? body.alias : null,
      model: typeof body.model === 'string' ? body.model : null,
      parentSessionId,
      parentToolCallId,
      delegationDepth,
      delegationMode,
      options: optionsResult.value,
    })
    reply.code(201)
    return session
  })

  app.get<{
    Params: { id: string }
    Querystring: { include?: string }
  }>('/v1/sessions/:id', async (req, reply) => {
    const session = store.get(req.params.id)
    if (!session) return bad(reply, 404, 'not_found', `session ${req.params.id} not found`)
    const include = (req.query?.include ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    if (include.includes('descendants_cost')) {
      const descendants = store.listDescendants(req.params.id)
      const ownUsage = deps.eventStore.latestUsage(req.params.id)
      const usages = descendants.map((s) => deps.eventStore.latestUsage(s.id))
      // Sum every key present on any snapshot. Adapters that don't
      // report usage contribute nothing (null snapshots are skipped).
      const all = [ownUsage, ...usages].filter(
        (u): u is NonNullable<typeof u> => u != null,
      )
      const totals = {
        inputTokens: 0,
        outputTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
        thoughtTokens: 0,
        totalTokens: 0,
      }
      for (const u of all) {
        totals.inputTokens += u.inputTokens
        totals.outputTokens += u.outputTokens
        totals.cachedReadTokens += u.cachedReadTokens ?? 0
        totals.cachedWriteTokens += u.cachedWriteTokens ?? 0
        totals.thoughtTokens += u.thoughtTokens ?? 0
        totals.totalTokens += u.totalTokens ?? 0
      }
      return {
        ...session,
        descendantsCost: {
          // Sessions whose adapter reported any usage at all. Sessions
          // missing from this count are "unknown," not "zero."
          reportingSessionCount: all.length,
          totalSessionCount: descendants.length + 1,
          ...totals,
        },
      }
    }
    return session
  })

  // Subtree under a session, parents-first BFS order. Excludes the
  // root itself — callers already have it from GET /v1/sessions/:id.
  app.get<{ Params: { id: string } }>('/v1/sessions/:id/descendants', async (req, reply) => {
    if (!store.get(req.params.id)) {
      return bad(reply, 404, 'not_found', `session ${req.params.id} not found`)
    }
    return { sessions: store.listDescendants(req.params.id) }
  })

  // Fork: create a new session of the requested harness, linked to the
  // parent via parentSessionId, and seed its first user message with a
  // textual summary (or transcript) of the parent's conversation. The
  // new session is queryable via the existing descendants endpoint.
  //
  // Lossy by design — events do not replay, only context. If a caller
  // wants a fresh same-tree session with no carry-over context, they
  // should `POST /v1/sessions { parentSessionId }` instead.
  app.post<{
    Params: { id: string }
    Body: { agent?: string; model?: string | null; mode?: string }
  }>('/v1/sessions/:id/fork', async (req, reply) => {
    const body = req.body ?? {}
    const agent = body.agent
    if (typeof agent !== 'string' || !VALID_AGENTS.includes(agent as AgentKind)) {
      return bad(reply, 400, 'invalid_agent', `agent must be one of ${VALID_AGENTS.join(', ')}`)
    }
    let mode: ForkMode = 'summary'
    if (body.mode !== undefined) {
      if (typeof body.mode !== 'string' || !VALID_FORK_MODES.includes(body.mode as ForkMode)) {
        return bad(reply, 400, 'invalid_fork_mode', `mode must be one of ${VALID_FORK_MODES.join(', ')}`)
      }
      mode = body.mode as ForkMode
    }
    if (body.model !== undefined && body.model !== null && typeof body.model !== 'string') {
      return bad(reply, 400, 'invalid_model', 'model must be a string or null')
    }

    const parent = store.get(req.params.id)
    if (!parent) return bad(reply, 404, 'not_found', `session ${req.params.id} not found`)
    if (parent.destroyedAt !== null) {
      return bad(reply, 410, 'parent_destroyed', 'parent session is destroyed')
    }

    // Same depth-cap rule as a delegated child: a fork at depth N+1
    // counts toward the cap so a runaway failover loop can't outgrow
    // the tree.
    const delegationDepth = parent.delegationDepth + 1
    if (delegationDepth > MAX_DELEGATION_DEPTH) {
      return bad(
        reply,
        400,
        'depth_cap_exceeded',
        `delegationDepth ${delegationDepth} exceeds cap ${MAX_DELEGATION_DEPTH}`,
      )
    }

    // Refuse forks targeting a harness that isn't installed, same as
    // POST /v1/sessions, so the caller gets a clean 409 instead of a
    // spawn-time 500.
    const availability = await probeAgent(agent as AgentKind)
    if (!availability.installed) {
      return bad(
        reply,
        409,
        'agent_not_available',
        availability.notes ?? `agent ${agent} is not available on this host`,
      )
    }

    // Walk the parent's full event log in chronological order. We
    // bound the walk at MAX_FORK_EVENTS so a runaway parent doesn't
    // OOM the daemon when forked.
    const events: EventEnvelope[] = []
    let after: number | undefined
    while (events.length < MAX_FORK_EVENTS) {
      const page = deps.eventStore.list(parent.id, { afterIndex: after, limit: FORK_EVENT_PAGE })
      if (page.length === 0) break
      events.push(...page)
      after = page[page.length - 1]!.eventIndex
      if (page.length < FORK_EVENT_PAGE) break
    }

    const seed = buildForkSeed(events, mode, parent.id)

    // Create the child row first so it's queryable via descendants
    // even if the seed prompt fails downstream.
    //
    // delegationMode is left null on purpose: a fork is not a sync /
    // background delegation, just a parent-link for queryability. The
    // delegate-MCP path is what cares about that field.
    const child = store.create({
      agent: agent as AgentKind,
      cwd: parent.cwd,
      alias: null,
      model: typeof body.model === 'string' ? body.model : null,
      parentSessionId: parent.id,
      parentToolCallId: null,
      delegationDepth,
      delegationMode: null,
    })

    // Seed the new session with the leading user message before its
    // first turn fires, so any client subscribing to the child sees
    // the same `user_message_chunk` -> `agent_*` -> `stop` flow as a
    // normal session. Empty seed = parent had no convertible context;
    // we still return the child row so the caller can prompt it
    // manually, but skip the auto-prompt.
    if (seed.length > 0) {
      try {
        const proc = await deps.supervisor.ensure(child.id)
        proc.prompt([{ type: 'text', text: seed }]).catch((err) => {
          app.log.error({ err, childId: child.id, parentId: parent.id }, 'fork: seed prompt failed')
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'spawn failed'
        // The child row is real and the parent link is set. Surface
        // the spawn failure but don't roll back — caller can retry
        // with POST /v1/sessions/:id/message once they fix whatever
        // made spawn fail (e.g. CLAUDE auth).
        app.log.warn({ err, childId: child.id, parentId: parent.id }, 'fork: spawn failed')
        reply.code(500)
        return { error: { code: 'spawn_failed', message }, session: child }
      }
    }

    reply.code(201)
    return child
  })

  app.patch<{
    Params: { id: string }
    Body: { alias?: string | null; model?: string | null }
  }>('/v1/sessions/:id', async (req, reply) => {
    const body = req.body ?? {}
    const before = store.get(req.params.id)
    if (!before) return bad(reply, 404, 'not_found', `session ${req.params.id} not found`)

    const updated = store.update(req.params.id, {
      alias: body.alias === undefined ? undefined : body.alias,
      model: body.model === undefined ? undefined : body.model,
    })
    if (!updated) return bad(reply, 404, 'not_found', `session ${req.params.id} not found`)

    // Propagate model change to the live subprocess if there is one.
    // No process running = nothing to do; next prompt picks up the new
    // model at spawn time.
    if (
      body.model !== undefined &&
      typeof body.model === 'string' &&
      body.model !== before.model
    ) {
      const proc = deps.supervisor.get(req.params.id)
      if (proc?.setModel) {
        proc.setModel(body.model).catch((err) => {
          app.log.warn({ err, sessionId: req.params.id }, 'live setModel failed')
        })
      }
    }

    return updated
  })

  app.delete<{ Params: { id: string } }>('/v1/sessions/:id', async (req, reply) => {
    const id = req.params.id
    if (!store.get(id)) return bad(reply, 404, 'not_found', `session ${id} not found`)
    // Cascade: descendants of the deleted session are removed by the
    // FK cascade on parent_session_id, but their running subprocesses
    // and event listeners need to be torn down explicitly so they
    // don't outlive their session rows. Walk descendants children-first
    // so leaves close before their parents.
    const descendants = store.listDescendants(id)
    const targets = [...descendants.map((s) => s.id), id]
    for (const targetId of targets) {
      try {
        const event = deps.eventStore.append(targetId, { kind: 'session_destroyed' })
        deps.bus.publish(event)
      } catch (err) {
        app.log.warn({ err, sessionId: targetId }, 'failed to emit session_destroyed')
      }
    }
    // Tiny grace period so SSE consumers see the close marker before
    // their connection is torn down.
    await new Promise((r) => setTimeout(r, 50))
    // Close subprocesses leaves-first so a parent doesn't keep emitting
    // events while children are still alive.
    for (const desc of descendants) {
      await deps.supervisor.closeOne(desc.id)
      deps.bus.drop(desc.id)
    }
    await deps.supervisor.closeOne(id)
    // Single DELETE — FK cascade removes descendant rows.
    store.delete(id)
    deps.bus.drop(id)
    reply.code(204).send()
  })
}
