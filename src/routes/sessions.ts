import type { FastifyInstance, FastifyReply } from 'fastify'
import type { SessionStore } from '../sessions/store.js'
import type { EventStore } from '../events/store.js'
import type { SessionBus } from '../bus.js'
import type { AgentSupervisor } from '../agent/supervisor.js'
import { probeAgent } from '../agent/availability.js'
import {
  MAX_DELEGATION_DEPTH,
  RESERVED_MCP_SERVER_NAME,
  type AgentKind,
  type ApiError,
  type DelegationMode,
  type McpServerSpec,
  type SessionOptions,
} from '../types.js'

const VALID_AGENTS: AgentKind[] = ['claude', 'pi', 'echo']
const VALID_DELEGATION_MODES: DelegationMode[] = ['sync', 'background']

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

type ValidatedOptions =
  | { ok: true; value: SessionOptions | null }
  | { ok: false; code: string; message: string }

// Validate the optional `options` payload from POST /v1/sessions. Each
// field passes through if provided, is omitted cleanly if not — wagent
// never synthesizes defaults here.
function validateSessionOptions(raw: unknown): ValidatedOptions {
  if (raw === undefined || raw === null) return { ok: true, value: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'invalid_options', message: 'options must be an object' }
  }
  const obj = raw as Record<string, unknown>
  const out: SessionOptions = {}
  if (obj.systemPrompt !== undefined) {
    if (typeof obj.systemPrompt !== 'string') {
      return { ok: false, code: 'invalid_options', message: 'options.systemPrompt must be a string' }
    }
    out.systemPrompt = obj.systemPrompt
  }
  if (obj.appendSystemPrompt !== undefined) {
    if (typeof obj.appendSystemPrompt !== 'string') {
      return {
        ok: false,
        code: 'invalid_options',
        message: 'options.appendSystemPrompt must be a string',
      }
    }
    out.appendSystemPrompt = obj.appendSystemPrompt
  }
  if (obj.allowedTools !== undefined) {
    if (!Array.isArray(obj.allowedTools) || !obj.allowedTools.every((t) => typeof t === 'string')) {
      return {
        ok: false,
        code: 'invalid_options',
        message: 'options.allowedTools must be an array of strings',
      }
    }
    out.allowedTools = obj.allowedTools as string[]
  }
  if (obj.mcpServers !== undefined) {
    const validated = validateMcpServers(obj.mcpServers)
    if (!validated.ok) return validated
    // Collapse `mcpServers: {}` to absent — same treatment as the
    // empty-options-object → null collapse below.
    if (Object.keys(validated.value).length > 0) {
      out.mcpServers = validated.value
    }
  }
  // Empty object → null so we don't persist an empty JSON blob.
  if (
    out.systemPrompt === undefined &&
    out.appendSystemPrompt === undefined &&
    out.allowedTools === undefined &&
    out.mcpServers === undefined
  ) {
    return { ok: true, value: null }
  }
  return { ok: true, value: out }
}

type ValidatedMcpServers =
  | { ok: true; value: Record<string, McpServerSpec> }
  | { ok: false; code: string; message: string }

// Validate options.mcpServers — a record keyed by server name with
// stdio / http / sse transports. Mirrors the Claude Agent SDK's
// serializable McpServerConfig shape; the non-serializable `sdk`
// instance variant is intentionally not accepted here (it has no wire
// representation). The reserved key `wagent-delegate` is rejected so
// callers can't shadow wagent's per-spawn delegation channel.
function validateMcpServers(raw: unknown): ValidatedMcpServers {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      code: 'invalid_options',
      message: 'options.mcpServers must be an object keyed by server name',
    }
  }
  const out: Record<string, McpServerSpec> = {}
  for (const [name, spec] of Object.entries(raw)) {
    if (name === RESERVED_MCP_SERVER_NAME) {
      return {
        ok: false,
        code: 'invalid_options',
        message: `options.mcpServers["${RESERVED_MCP_SERVER_NAME}"] is reserved by wagent`,
      }
    }
    const validated = validateMcpServer(name, spec)
    if (!validated.ok) return validated
    out[name] = validated.value
  }
  return { ok: true, value: out }
}

type ValidatedMcpServer =
  | { ok: true; value: McpServerSpec }
  | { ok: false; code: string; message: string }

function validateMcpServer(name: string, raw: unknown): ValidatedMcpServer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      code: 'invalid_options',
      message: `options.mcpServers["${name}"] must be an object`,
    }
  }
  const spec = raw as Record<string, unknown>
  // Default transport when `type` is omitted is stdio (matches the SDK).
  const type = spec.type === undefined ? 'stdio' : spec.type
  if (type !== 'stdio' && type !== 'http' && type !== 'sse') {
    return {
      ok: false,
      code: 'invalid_options',
      message: `options.mcpServers["${name}"].type must be one of stdio, http, sse`,
    }
  }
  if (type === 'stdio') {
    if (typeof spec.command !== 'string' || spec.command.length === 0) {
      return {
        ok: false,
        code: 'invalid_options',
        message: `options.mcpServers["${name}"].command must be a non-empty string`,
      }
    }
    if (
      spec.args !== undefined &&
      (!Array.isArray(spec.args) || !spec.args.every((a) => typeof a === 'string'))
    ) {
      return {
        ok: false,
        code: 'invalid_options',
        message: `options.mcpServers["${name}"].args must be an array of strings`,
      }
    }
    if (spec.env !== undefined && !isStringRecord(spec.env)) {
      return {
        ok: false,
        code: 'invalid_options',
        message: `options.mcpServers["${name}"].env must be a string-to-string record`,
      }
    }
    const value: McpServerSpec = {
      type: 'stdio',
      command: spec.command,
      ...(spec.args !== undefined ? { args: spec.args as string[] } : {}),
      ...(spec.env !== undefined ? { env: spec.env as Record<string, string> } : {}),
    }
    return { ok: true, value }
  }
  // http or sse — same validation shape.
  if (typeof spec.url !== 'string' || spec.url.length === 0) {
    return {
      ok: false,
      code: 'invalid_options',
      message: `options.mcpServers["${name}"].url must be a non-empty string`,
    }
  }
  if (spec.headers !== undefined && !isStringRecord(spec.headers)) {
    return {
      ok: false,
      code: 'invalid_options',
      message: `options.mcpServers["${name}"].headers must be a string-to-string record`,
    }
  }
  const value: McpServerSpec = {
    type,
    url: spec.url,
    ...(spec.headers !== undefined ? { headers: spec.headers as Record<string, string> } : {}),
  }
  return { ok: true, value }
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string')
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
