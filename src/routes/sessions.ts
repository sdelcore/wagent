import type { FastifyInstance, FastifyReply } from 'fastify'
import type { SessionStore } from '../sessions/store.js'
import type { EventStore } from '../events/store.js'
import type { SessionBus } from '../bus.js'
import type { AgentSupervisor } from '../agent/supervisor.js'
import { probeAgent } from '../agent/availability.js'
import { buildForkSeed, VALID_FORK_MODES, type ForkMode } from '../sessions/fork.js'
import { createSession, VALID_AGENTS } from '../sessions/create.js'
import {
  MAX_DELEGATION_DEPTH,
  type AgentKind,
  type ApiError,
  type EventEnvelope,
} from '../types.js'

// Map a createSession failure code to an HTTP status. The codes are the
// stable contract; this table is the route's local choice of how to
// surface them.
const CREATE_SESSION_STATUS: Record<string, number> = {
  invalid_agent: 400,
  invalid_cwd: 400,
  invalid_options: 400,
  invalid_parent: 400,
  invalid_delegation_mode: 400,
  parent_not_found: 404,
  parent_destroyed: 410,
  depth_cap_exceeded: 400,
  agent_not_available: 409,
}

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
    // POST historically coalesces delegationMode: null → 'sync' (a null
    // on the wire was treated as "default"). createSession treats null
    // as "no mode at all" (the fork case). Normalise here so POST's
    // wire behaviour is preserved.
    const delegationMode = body.delegationMode === null ? undefined : body.delegationMode
    const result = await createSession(
      {
        agent: body.agent,
        cwd: body.cwd,
        alias: body.alias,
        model: body.model,
        options: body.options,
        parentSessionId: body.parentSessionId,
        parentToolCallId: body.parentToolCallId,
        delegationMode,
      },
      { sessionStore: store, probeAgent },
    )
    if (!result.ok) {
      return bad(reply, CREATE_SESSION_STATUS[result.code] ?? 400, result.code, result.message)
    }
    reply.code(201)
    return result.value
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

    // Early parent fetch so we can (a) return fork's existing 404 code
    // 'not_found' for a missing parent (createSession would surface
    // 'parent_not_found' instead, which would change wire behaviour),
    // and (b) read parent.cwd for the child.
    const parent = store.get(req.params.id)
    if (!parent) return bad(reply, 404, 'not_found', `session ${req.params.id} not found`)

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

    // delegationMode: null is the fork-specific signal — a fork is not a
    // sync / background delegation, just a parent-link for queryability.
    // createSession respects an explicit null.
    const result = await createSession(
      {
        agent: body.agent,
        cwd: parent.cwd,
        alias: null,
        model: body.model,
        parentSessionId: parent.id,
        parentToolCallId: null,
        delegationMode: null,
      },
      { sessionStore: store, probeAgent },
    )
    if (!result.ok) {
      return bad(reply, CREATE_SESSION_STATUS[result.code] ?? 400, result.code, result.message)
    }
    const child = result.value

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
