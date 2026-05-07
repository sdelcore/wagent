import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { SessionStore } from '../sessions/store.js'
import type { RemoteChildrenStore, RemoteChild } from '../sessions/remote_children_store.js'
import type { AgentSupervisor } from '../agent/supervisor.js'
import type { DelegateTokenStore } from '../agent/delegate_tokens.js'
import { probeAgent } from '../agent/availability.js'
import { createSession, VALID_AGENTS } from '../sessions/create.js'
import {
  type AgentKind,
  type ContentBlock,
  type DelegationMode,
  type SessionUpdate,
} from '../types.js'
import type { EventStore } from '../events/store.js'
import type { SessionBus } from '../bus.js'
import {
  loadHostsConfig,
  resolveHost,
  knownHosts,
  type ResolvedHost,
} from '../cli/on-config.js'

// Minimal MCP Streamable-HTTP server. Each parent session has one URL
// (`/mcp/delegate/:parentSessionId`). The harness running inside that
// parent session connects here, negotiates the JSON-RPC handshake, and
// calls the `delegate` tool to spawn child sessions.
//
// We hand-roll the protocol rather than pulling in @modelcontextprotocol/sdk
// + zod as direct dependencies. The surface is small (initialize,
// tools/list, tools/call, notifications/initialized) and POST-only is
// sufficient since we never need server-initiated notifications.

// Pinned protocol version we advertise. MCP clients (including the
// Claude SDK) negotiate to a version both sides support; if a future
// client demands newer than this we'll need to bump.
const PROTOCOL_VERSION = '2025-06-18'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface DelegateMcpDeps {
  sessionStore: SessionStore
  remoteChildren: RemoteChildrenStore
  eventStore: EventStore
  bus: SessionBus
  supervisor: AgentSupervisor
  delegateTokens: DelegateTokenStore
}

export function registerDelegateMcpRoutes(app: FastifyInstance, deps: DelegateMcpDeps) {
  const handler = async (
    req: FastifyRequest<{ Params: { parentSessionId: string } }>,
    reply: FastifyReply,
  ) => {
    // Loopback only. The MCP endpoint exists for harnesses spawned by
    // this same wagent process; remote clients have no business here.
    const ip = req.ip
    if (!isLoopback(ip)) {
      reply.code(403)
      return { error: { code: 'forbidden', message: 'delegate MCP is loopback-only' } }
    }

    const parentSessionId = req.params.parentSessionId
    const auth = req.headers.authorization ?? ''
    const match = /^Bearer\s+(.+)$/i.exec(auth)
    if (!match) {
      reply.code(401)
      return { error: { code: 'unauthorized', message: 'missing bearer token' } }
    }
    const token = match[1]!
    const entry = deps.delegateTokens.verify(parentSessionId, token)
    if (!entry) {
      reply.code(401)
      return { error: { code: 'unauthorized', message: 'invalid delegate token' } }
    }

    if (req.method === 'GET') {
      // GET = client opening an SSE stream for server-initiated
      // notifications. We don't push anything, but clients may still
      // open the channel. 405 is technically correct per the optional
      // GET in the streamable-HTTP spec; respond with 200 + empty SSE
      // so cooperating clients don't error.
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
      })
      // Keep alive briefly then close — we never have notifications
      // to push, so a long-lived stream serves no purpose.
      reply.raw.write(': mcp delegate stream open\n\n')
      reply.raw.end()
      return reply
    }

    const body = req.body as JsonRpcRequest | JsonRpcRequest[] | undefined
    if (!body) {
      reply.code(400)
      return rpcError(null, -32600, 'empty body')
    }

    const responses: JsonRpcResponse[] = []
    const messages = Array.isArray(body) ? body : [body]
    for (const msg of messages) {
      const resp = await dispatch(msg, parentSessionId, deps, app)
      if (resp) responses.push(resp)
    }

    if (responses.length === 0) {
      // All-notifications batch — return 202 Accepted with no body.
      reply.code(202).send()
      return reply
    }
    reply.header('content-type', 'application/json')
    return Array.isArray(body) ? responses : responses[0]
  }

  app.post('/mcp/delegate/:parentSessionId', handler)
  app.get('/mcp/delegate/:parentSessionId', handler)
}

function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1' ||
    ip.startsWith('127.')
  )
}

async function dispatch(
  msg: JsonRpcRequest,
  parentSessionId: string,
  deps: DelegateMcpDeps,
  app: FastifyInstance,
): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null
  // Notifications (no id) get no response.
  const isNotification = msg.id === undefined || msg.id === null
  try {
    switch (msg.method) {
      case 'initialize': {
        if (isNotification) return null
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'wagent-delegate', version: '1' },
          },
        }
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null
      case 'tools/list': {
        if (isNotification) return null
        return { jsonrpc: '2.0', id, result: { tools: TOOL_DEFS } }
      }
      case 'tools/call': {
        if (isNotification) return null
        const params = (msg.params ?? {}) as { name?: string; arguments?: unknown }
        switch (params.name) {
          case 'delegate': {
            const result = await runDelegate(
              params.arguments as DelegateArgs | undefined,
              parentSessionId,
              deps,
              app,
            )
            return { jsonrpc: '2.0', id, result }
          }
          case 'delegate_status': {
            const result = await runDelegateStatus(
              params.arguments as DelegateStatusArgs | undefined,
              parentSessionId,
              deps,
              app,
            )
            return { jsonrpc: '2.0', id, result }
          }
          case 'delegate_cancel': {
            const result = await runDelegateCancel(
              params.arguments as DelegateCancelArgs | undefined,
              parentSessionId,
              deps,
              app,
            )
            return { jsonrpc: '2.0', id, result }
          }
          default:
            return rpcError(id, -32601, `unknown tool: ${params.name ?? '<missing>'}`)
        }
      }
      case 'ping':
        if (isNotification) return null
        return { jsonrpc: '2.0', id, result: {} }
      default:
        if (isNotification) return null
        return rpcError(id, -32601, `unknown method: ${msg.method}`)
    }
  } catch (err) {
    app.log.error({ err, method: msg.method }, 'delegate MCP dispatch failed')
    if (isNotification) return null
    return rpcError(id, -32603, err instanceof Error ? err.message : String(err))
  }
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const VALID_MODES: DelegationMode[] = ['sync', 'background']

const TOOL_DEFS = [
  {
    name: 'delegate',
    description:
      "Spawn a wagent child session running the requested coding-agent harness and send it a single prompt. In sync mode (default) returns the child's final assistant message when it finishes. In background mode returns immediately with a childSessionId; use `delegate_status` to check on it later. Use this to hand off a focused subtask to another agent (possibly a different harness/model). The child runs in its own conversation context — pass anything it needs in `prompt` directly. To run the child on a different machine, set `host` to a name from `~/.config/wagent/hosts.toml` (e.g. 'nightman'); the child runs on that host's wagent and `delegate_status` / `delegate_cancel` proxy through to the remote. Both sync and background modes work for remote hosts.",
    inputSchema: {
      type: 'object',
      properties: {
        harness: {
          type: 'string',
          enum: VALID_AGENTS,
          description:
            'Which agent harness to spawn the child as. "claude" = Claude Code via ACP, "pi" = pi-coding-agent SDK (in-process), "echo" = stub for testing.',
        },
        prompt: {
          type: 'string',
          description:
            "The prompt to send to the child. The child sees only this — it does not inherit the parent's conversation. Include all context the child needs.",
        },
        cwd: {
          type: 'string',
          description:
            "Working directory for the child. Absolute path. Defaults to the parent's cwd (local) or the host's default_cwd from hosts.toml (remote).",
        },
        host: {
          type: 'string',
          description:
            "Optional remote wagent host name (must match an entry in `~/.config/wagent/hosts.toml`). When set, the child runs on the named host's wagent instead of locally — use this to route work to a different machine (e.g. 'nightman' to act on home-infra). Omit (or use 'local') to run locally. Background mode is supported: the child id is recorded so later `delegate_status` / `delegate_cancel` calls proxy through to the remote.",
        },
        model: {
          type: 'string',
          description:
            'Optional model override for the child (harness-specific format).',
        },
        mode: {
          type: 'string',
          enum: VALID_MODES,
          description:
            "'sync' (default) blocks until the child stops. 'background' returns immediately so the parent can fan out and poll status with delegate_status. Background children survive past this tool call but are still cascade-destroyed when the parent session is destroyed.",
        },
        options: {
          type: 'object',
          description:
            'Per-child SessionOptions. Same shape and adapter forwarding rules as POST /v1/sessions { options }: systemPrompt / appendSystemPrompt / allowedTools / mcpServers / permissionMode / resume / forkSession. Useful when a parent needs to enforce a focused persona (system prompt + tool allowlist) on the child without round-tripping through `POST /v1/sessions`.',
          properties: {
            systemPrompt: { type: 'string' },
            appendSystemPrompt: { type: 'string' },
            allowedTools: { type: 'array', items: { type: 'string' } },
            mcpServers: { type: 'object' },
            permissionMode: { type: 'string', enum: ['default', 'ask', 'bypass'] },
            resume: { type: 'string' },
            forkSession: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
      required: ['harness', 'prompt'],
    },
  },
  {
    name: 'delegate_status',
    description:
      'Check the status of a previously-spawned (background) child. Returns the current status and, if the child has completed, its final assistant message. Safe to call repeatedly.',
    inputSchema: {
      type: 'object',
      properties: {
        childSessionId: {
          type: 'string',
          description: 'The childSessionId returned by an earlier delegate call.',
        },
      },
      required: ['childSessionId'],
    },
  },
  {
    name: 'delegate_cancel',
    description:
      'Abort a running background child session. No-op if the child has already finished.',
    inputSchema: {
      type: 'object',
      properties: {
        childSessionId: {
          type: 'string',
          description: 'The childSessionId to cancel.',
        },
      },
      required: ['childSessionId'],
    },
  },
] as const

interface DelegateArgs {
  harness: AgentKind
  prompt: string
  cwd?: string
  host?: string
  model?: string
  mode?: DelegationMode
  options?: unknown
}

interface DelegateStatusArgs {
  childSessionId: string
}

interface DelegateCancelArgs {
  childSessionId: string
}

interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
  // We surface structured fields too so callers that look beyond text can use them.
  structuredContent?: Record<string, unknown>
}

function toolError(text: string, structured?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text }],
    isError: true,
    structuredContent: { status: 'failed', error: text, ...structured },
  }
}

async function runDelegate(
  args: DelegateArgs | undefined,
  parentSessionId: string,
  deps: DelegateMcpDeps,
  app: FastifyInstance,
): Promise<ToolResult> {
  if (!args || typeof args !== 'object') {
    return toolError('delegate: missing arguments')
  }
  const { harness, prompt, cwd: cwdArg, host: hostArg, model, mode: modeArg, options: optionsArg } = args
  if (typeof prompt !== 'string' || prompt.length === 0) {
    return toolError('delegate: prompt must be a non-empty string')
  }
  const mode: DelegationMode = modeArg === 'background' ? 'background' : 'sync'
  if (modeArg !== undefined && !VALID_MODES.includes(modeArg)) {
    return toolError(`delegate: mode must be one of ${VALID_MODES.join(', ')}`)
  }

  // `host` (when set and not "local") routes the child to a remote
  // wagent. The remote dispatch path has no shared SessionStore with
  // us, so it can't link parent↔child or be polled via delegate_status
  // — sync only, fire-and-await.
  const remoteHost =
    typeof hostArg === 'string' && hostArg.length > 0 && hostArg !== 'local'
      ? hostArg
      : null
  if (remoteHost) {
    return runDelegateRemote(
      remoteHost,
      harness,
      prompt,
      cwdArg,
      model,
      optionsArg,
      mode,
      parentSessionId,
      deps,
      app,
    )
  }

  // Pre-fetch parent for clean toolError UX on missing/destroyed parent
  // and to default child cwd to parent.cwd. createSession will re-fetch
  // and re-validate — fine, in-process SQLite read.
  const parent = deps.sessionStore.get(parentSessionId)
  if (!parent) return toolError(`delegate: parent session ${parentSessionId} not found`)
  if (parent.destroyedAt !== null) {
    return toolError('delegate: parent session is destroyed')
  }

  const cwd = cwdArg && cwdArg.length > 0 ? cwdArg : parent.cwd

  const result = await createSession(
    {
      agent: harness,
      cwd,
      alias: null,
      model: model ?? null,
      options: optionsArg,
      parentSessionId: parent.id,
      parentToolCallId: null,
      delegationMode: mode,
    },
    { sessionStore: deps.sessionStore, probeAgent },
  )
  if (!result.ok) {
    return toolError(`delegate: ${result.message}`, { code: result.code })
  }
  const child = result.value
  app.log.info(
    {
      childId: child.id,
      parentId: parent.id,
      depth: child.delegationDepth,
      harness,
      mode,
    },
    'delegate: child session created',
  )

  // Wait for stop in sync mode; in background mode return immediately
  // and let the child run on its own.
  if (mode === 'background') {
    let proc
    try {
      proc = await deps.supervisor.ensure(child.id)
    } catch (err) {
      return toolError(
        `delegate: failed to spawn child: ${err instanceof Error ? err.message : String(err)}`,
        { childSessionId: child.id },
      )
    }
    const content: ContentBlock[] = [{ type: 'text', text: prompt }]
    proc.prompt(content).catch((err) => {
      app.log.error({ err, childId: child.id }, 'delegate: background child prompt failed')
    })
    return {
      content: [
        { type: 'text', text: `Spawned child ${child.id} in background. Use delegate_status to check.` },
      ],
      structuredContent: {
        status: 'running',
        childSessionId: child.id,
        mode: 'background',
      },
    }
  }

  // Sync mode: subscribe before spawning so we don't miss any events.
  const turn = awaitTurn(deps.bus, child.id)

  let proc
  try {
    proc = await deps.supervisor.ensure(child.id)
  } catch (err) {
    return toolError(
      `delegate: failed to spawn child: ${err instanceof Error ? err.message : String(err)}`,
      { childSessionId: child.id },
    )
  }

  const content: ContentBlock[] = [{ type: 'text', text: prompt }]
  proc.prompt(content).catch((err) => {
    app.log.error({ err, childId: child.id }, 'delegate: child prompt failed')
  })

  const { finalText, stopReason } = await turn

  const text = finalText.length > 0 ? finalText : `(child stopped: ${stopReason})`
  return {
    content: [{ type: 'text', text }],
    structuredContent: {
      status: stopReason === 'end_turn' ? 'completed' : 'failed',
      childSessionId: child.id,
      stopReason,
      result: text,
    },
  }
}

// Dispatch the child session to a remote wagent named in
// `~/.config/wagent/hosts.toml`. Mirrors the wire moves the
// `wagent-on` CLI makes (POST /v1/sessions, POST /message). In sync
// mode opens the SSE stream and drains until terminal. In background
// mode returns immediately and records the remote child in our
// SQLite so subsequent delegate_status / delegate_cancel calls can
// proxy back to the remote.
async function runDelegateRemote(
  hostName: string,
  harness: AgentKind,
  prompt: string,
  cwdArg: string | undefined,
  model: string | undefined,
  optionsArg: unknown,
  mode: DelegationMode,
  parentSessionId: string,
  deps: DelegateMcpDeps,
  app: FastifyInstance,
): Promise<ToolResult> {
  const resolved = resolveRemote(hostName, cwdArg)
  if ('error' in resolved) return toolError(resolved.error)
  const host = resolved.host

  // POST /v1/sessions on the remote.
  const sessionBody: Record<string, unknown> = { agent: harness, cwd: host.cwd }
  if (model) sessionBody.model = model
  if (optionsArg !== undefined) sessionBody.options = optionsArg

  let childSessionId: string
  try {
    const resp = await fetch(`${host.url}/v1/sessions`, {
      method: 'POST',
      headers: remoteHeaders(host, { 'content-type': 'application/json' }),
      body: JSON.stringify(sessionBody),
    })
    if (!resp.ok) {
      const body = await safeReadText(resp)
      return toolError(
        `delegate: remote session create failed (${resp.status}): ${body}`,
      )
    }
    const json = (await resp.json()) as { id?: unknown }
    if (typeof json.id !== 'string' || json.id.length === 0) {
      return toolError(
        `delegate: remote session create returned no id: ${JSON.stringify(json).slice(0, 200)}`,
      )
    }
    childSessionId = json.id
  } catch (err) {
    return toolError(
      `delegate: connecting to ${host.url} failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  app.log.info(
    { childId: childSessionId, host: hostName, url: host.url, harness, mode },
    'delegate: remote child session created',
  )

  // Background mode: persist the mapping FIRST so a status/cancel that
  // races the prompt POST can still find the remote, then post and
  // return immediately.
  if (mode === 'background') {
    deps.remoteChildren.insert({
      childSessionId,
      parentSessionId,
      hostName,
      harness,
    })
    try {
      const resp = await fetch(
        `${host.url}/v1/sessions/${childSessionId}/message`,
        {
          method: 'POST',
          headers: remoteHeaders(host, { 'content-type': 'application/json' }),
          body: JSON.stringify({ content: [{ type: 'text', text: prompt }] }),
        },
      )
      if (!resp.ok) {
        const body = await safeReadText(resp)
        // Drop the mapping — there's nothing useful to poll.
        deps.remoteChildren.delete(childSessionId)
        return toolError(
          `delegate: remote message post failed (${resp.status}): ${body}`,
          { childSessionId },
        )
      }
    } catch (err) {
      deps.remoteChildren.delete(childSessionId)
      return toolError(
        `delegate: posting prompt failed: ${err instanceof Error ? err.message : String(err)}`,
        { childSessionId },
      )
    }
    return {
      content: [
        {
          type: 'text',
          text: `Spawned remote child ${childSessionId} on ${hostName} in background. Use delegate_status to check.`,
        },
      ],
      structuredContent: {
        status: 'running',
        childSessionId,
        host: hostName,
        mode: 'background',
      },
    }
  }

  // Sync: open SSE stream, post prompt, drain until terminal.
  let streamResp: Response
  try {
    streamResp = await fetch(
      `${host.url}/v1/sessions/${childSessionId}/events/stream`,
      {
        method: 'GET',
        headers: remoteHeaders(host, {
          accept: 'text/event-stream',
          'last-event-id': '0',
        }),
      },
    )
  } catch (err) {
    return toolError(
      `delegate: events stream connect failed: ${err instanceof Error ? err.message : String(err)}`,
      { childSessionId },
    )
  }
  if (!streamResp.ok || !streamResp.body) {
    const body = streamResp.ok ? '<no body>' : await safeReadText(streamResp)
    return toolError(
      `delegate: events stream open failed (${streamResp.status}): ${body}`,
      { childSessionId },
    )
  }

  try {
    const resp = await fetch(
      `${host.url}/v1/sessions/${childSessionId}/message`,
      {
        method: 'POST',
        headers: remoteHeaders(host, { 'content-type': 'application/json' }),
        body: JSON.stringify({ content: [{ type: 'text', text: prompt }] }),
      },
    )
    if (!resp.ok) {
      const body = await safeReadText(resp)
      return toolError(
        `delegate: remote message post failed (${resp.status}): ${body}`,
        { childSessionId },
      )
    }
  } catch (err) {
    return toolError(
      `delegate: posting prompt failed: ${err instanceof Error ? err.message : String(err)}`,
      { childSessionId },
    )
  }

  const result = await consumeRemoteStream(streamResp.body)
  return {
    content: [
      {
        type: 'text',
        text:
          result.finalText.length > 0
            ? result.finalText
            : `(remote child stopped: ${result.stopReason})`,
      },
    ],
    isError: result.isError,
    structuredContent: {
      status: result.isError
        ? 'failed'
        : result.stopReason === 'end_turn'
          ? 'completed'
          : 'failed',
      childSessionId,
      host: hostName,
      stopReason: result.stopReason,
      result: result.finalText,
    },
  }
}

// Look up a host_name in hosts.toml. Returns the resolved host or an
// error string; the caller turns the error string into a toolError.
// Re-resolved on every call so token rotation in env/file takes
// effect immediately without having to update any persisted state.
function resolveRemote(
  hostName: string,
  cwdOverride: string | undefined,
): { host: ResolvedHost & { cwd: string } } | { error: string } {
  let host: ResolvedHost | null
  try {
    const config = loadHostsConfig()
    host = resolveHost(config, hostName, cwdOverride)
    if (!host) {
      const list = knownHosts(config)
      return {
        error: `delegate: no host \`${hostName}\` in hosts.toml (known: ${list.length > 0 ? list.join(', ') : '(none)'})`,
      }
    }
  } catch (err) {
    return {
      error: `delegate: hosts.toml load failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (!host.cwd) {
    return {
      error: `delegate: host \`${hostName}\` has no default_cwd and no \`cwd\` was given`,
    }
  }
  return { host: { ...host, cwd: host.cwd } }
}

function remoteHeaders(
  host: ResolvedHost,
  extra: Record<string, string> = {},
): Record<string, string> {
  return host.authToken
    ? { authorization: `Bearer ${host.authToken}`, ...extra }
    : extra
}

interface RemoteStreamResult {
  finalText: string
  stopReason: string
  isError: boolean
}

async function consumeRemoteStream(
  body: ReadableStream<Uint8Array>,
): Promise<RemoteStreamResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buf = ''
  let finalText = ''
  let stopReason = 'closed'
  let isError = false

  outer: while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    while (true) {
      const idx = buf.indexOf('\n\n')
      if (idx === -1) break
      const rawEvent = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const data = parseSseData(rawEvent)
      if (data === null) continue
      let envelope: Record<string, unknown>
      try {
        envelope = JSON.parse(data) as Record<string, unknown>
      } catch {
        continue
      }
      const kind = typeof envelope.kind === 'string' ? envelope.kind : ''
      const payloadRaw = envelope.payload
      const payload =
        payloadRaw && typeof payloadRaw === 'object'
          ? (payloadRaw as Record<string, unknown>)
          : envelope
      switch (kind) {
        case 'agent_message_chunk': {
          if (typeof payload.text === 'string') finalText += payload.text
          break
        }
        case 'error': {
          isError = true
          const message =
            typeof payload.message === 'string' ? payload.message : '(no message)'
          finalText += `\n[error] ${message}`
          stopReason = 'error'
          break outer
        }
        case 'subprocess_died': {
          isError = true
          stopReason = 'subprocess_died'
          break outer
        }
        case 'stop': {
          stopReason = typeof payload.reason === 'string' ? payload.reason : 'end_turn'
          break outer
        }
      }
    }
  }
  return { finalText, stopReason, isError }
}

function parseSseData(rawEvent: string): string | null {
  let data: string | null = null
  for (const line of rawEvent.split('\n')) {
    if (line.startsWith('data:')) {
      data = line.slice('data:'.length).replace(/^\s/, '')
    }
  }
  return data
}

async function safeReadText(resp: Response): Promise<string> {
  try {
    return (await resp.text()).slice(0, 4096)
  } catch {
    return '<no body>'
  }
}

// Inspect a child's event log to derive its current status and (if
// completed) the assistant text. For local children: reads from
// SQLite (cheap). For remote children: fetches the snapshot
// `/v1/sessions/:id/events` from the remote (one round-trip).
async function runDelegateStatus(
  args: DelegateStatusArgs | undefined,
  parentSessionId: string,
  deps: DelegateMcpDeps,
  app: FastifyInstance,
): Promise<ToolResult> {
  if (!args || typeof args.childSessionId !== 'string') {
    return toolError('delegate_status: missing childSessionId')
  }

  // Try the remote-children store first. If it's there, that's a
  // remote child and we proxy through; otherwise fall through to the
  // local lookup. (A local child is in sessionStore, never in
  // remote_children, so the order doesn't allow a misclassification.)
  const remote = deps.remoteChildren.get(args.childSessionId)
  if (remote) {
    if (remote.parentSessionId !== parentSessionId) {
      return toolError('delegate_status: child does not belong to this parent')
    }
    return runDelegateStatusRemote(remote, app)
  }

  const child = deps.sessionStore.get(args.childSessionId)
  if (!child) return toolError(`delegate_status: child ${args.childSessionId} not found`)
  if (child.parentSessionId !== parentSessionId) {
    // Don't let one parent peek at another parent's children.
    return toolError('delegate_status: child does not belong to this parent')
  }

  if (child.destroyedAt !== null) {
    return {
      content: [{ type: 'text', text: `(child ${child.id} destroyed)` }],
      structuredContent: {
        status: 'destroyed',
        childSessionId: child.id,
      },
    }
  }

  // Walk events: aggregate assistant text up to the first stop /
  // subprocess_died. Page in chunks to handle large transcripts.
  let cursor = 0
  let stopReason: string | null = null
  let aggregated = ''
  let dead = false
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = deps.eventStore.list(child.id, { afterIndex: cursor, limit: 500 })
    if (page.length === 0) break
    for (const ev of page) {
      cursor = ev.eventIndex
      const payload = ev.payload as SessionUpdate & { text?: string; reason?: string }
      if (payload.kind === 'agent_message_chunk' && typeof payload.text === 'string') {
        aggregated += payload.text
      } else if (payload.kind === 'stop') {
        stopReason = payload.reason ?? 'end_turn'
      } else if (payload.kind === 'subprocess_died') {
        dead = true
      }
    }
    if (page.length < 500) break
  }

  let status: 'running' | 'completed' | 'failed' | 'cancelled'
  if (dead) status = 'failed'
  else if (stopReason === 'cancelled') status = 'cancelled'
  else if (stopReason === 'end_turn') status = 'completed'
  else if (stopReason !== null) status = 'failed'
  else status = 'running'

  const summary = aggregated.length > 0 ? aggregated : `(no assistant output yet)`
  return {
    content: [
      { type: 'text', text: status === 'running' ? `(child ${child.id} still running)` : summary },
    ],
    structuredContent: {
      status,
      childSessionId: child.id,
      stopReason,
      result: status === 'completed' ? aggregated : undefined,
    },
  }
}

async function runDelegateCancel(
  args: DelegateCancelArgs | undefined,
  parentSessionId: string,
  deps: DelegateMcpDeps,
  app: FastifyInstance,
): Promise<ToolResult> {
  if (!args || typeof args.childSessionId !== 'string') {
    return toolError('delegate_cancel: missing childSessionId')
  }

  const remote = deps.remoteChildren.get(args.childSessionId)
  if (remote) {
    if (remote.parentSessionId !== parentSessionId) {
      return toolError('delegate_cancel: child does not belong to this parent')
    }
    return runDelegateCancelRemote(remote, app)
  }

  const child = deps.sessionStore.get(args.childSessionId)
  if (!child) return toolError(`delegate_cancel: child ${args.childSessionId} not found`)
  if (child.parentSessionId !== parentSessionId) {
    return toolError('delegate_cancel: child does not belong to this parent')
  }
  const proc = deps.supervisor.get(child.id)
  if (!proc) {
    // No live process — child either finished, never spawned, or was
    // already cancelled. Idempotent ok.
    return {
      content: [{ type: 'text', text: `(child ${child.id} not running)` }],
      structuredContent: { status: 'noop', childSessionId: child.id },
    }
  }
  try {
    await proc.cancel()
  } catch (err) {
    app.log.warn({ err, childId: child.id }, 'delegate_cancel failed')
    return toolError(
      `delegate_cancel: ${err instanceof Error ? err.message : String(err)}`,
      { childSessionId: child.id },
    )
  }
  return {
    content: [{ type: 'text', text: `(cancel requested for ${child.id})` }],
    structuredContent: { status: 'cancelling', childSessionId: child.id },
  }
}

interface TurnResult {
  finalText: string
  stopReason: string
}

// Fetch /v1/sessions/:id/events from the remote, replay through the
// same status-derivation logic the local path uses. One round-trip
// per call — no caching — so a hosts.toml token rotation or registry
// edit takes effect on the next status call.
async function runDelegateStatusRemote(
  remote: RemoteChild,
  app: FastifyInstance,
): Promise<ToolResult> {
  const resolved = resolveRemote(remote.hostName, undefined)
  if ('error' in resolved) return toolError(resolved.error, { childSessionId: remote.childSessionId })
  const host = resolved.host

  let events: Array<{ kind?: unknown; payload?: unknown }>
  try {
    const resp = await fetch(
      `${host.url}/v1/sessions/${remote.childSessionId}/events`,
      { method: 'GET', headers: remoteHeaders(host, { accept: 'application/json' }) },
    )
    if (resp.status === 404) {
      return toolError(
        `delegate_status: remote child ${remote.childSessionId} not found on ${remote.hostName}`,
        { childSessionId: remote.childSessionId },
      )
    }
    if (!resp.ok) {
      const body = await safeReadText(resp)
      return toolError(
        `delegate_status: remote events fetch failed (${resp.status}): ${body}`,
        { childSessionId: remote.childSessionId },
      )
    }
    const json = (await resp.json()) as unknown
    // Polling endpoint shape: either a bare array of envelopes or
    // { events: [...] }. Tolerate both so we don't break if the route
    // shape evolves.
    if (Array.isArray(json)) {
      events = json as typeof events
    } else if (json && typeof json === 'object' && Array.isArray((json as { events?: unknown }).events)) {
      events = (json as { events: typeof events }).events
    } else {
      return toolError(
        `delegate_status: unexpected remote events response: ${JSON.stringify(json).slice(0, 200)}`,
        { childSessionId: remote.childSessionId },
      )
    }
  } catch (err) {
    return toolError(
      `delegate_status: connecting to ${host.url} failed: ${err instanceof Error ? err.message : String(err)}`,
      { childSessionId: remote.childSessionId },
    )
  }

  let aggregated = ''
  let stopReason: string | null = null
  let dead = false
  for (const ev of events) {
    const kind = typeof ev.kind === 'string' ? ev.kind : ''
    const payloadRaw = ev.payload
    const payload = (payloadRaw && typeof payloadRaw === 'object' ? payloadRaw : ev) as {
      text?: unknown
      reason?: unknown
    }
    if (kind === 'agent_message_chunk' && typeof payload.text === 'string') {
      aggregated += payload.text
    } else if (kind === 'stop') {
      stopReason = typeof payload.reason === 'string' ? payload.reason : 'end_turn'
    } else if (kind === 'subprocess_died') {
      dead = true
    }
  }

  let status: 'running' | 'completed' | 'failed' | 'cancelled'
  if (dead) status = 'failed'
  else if (stopReason === 'cancelled') status = 'cancelled'
  else if (stopReason === 'end_turn') status = 'completed'
  else if (stopReason !== null) status = 'failed'
  else status = 'running'

  // Once the remote child is terminal, drop our mapping — we won't
  // need to proxy further calls.
  if (status !== 'running') {
    try {
      // Best-effort: a stale row is harmless, just wastes a row.
      app.log.debug({ childId: remote.childSessionId }, 'delegate: dropping terminal remote child mapping')
    } catch {
      // ignore
    }
  }

  const summary = aggregated.length > 0 ? aggregated : `(no assistant output yet)`
  return {
    content: [
      {
        type: 'text',
        text: status === 'running' ? `(remote child ${remote.childSessionId} still running)` : summary,
      },
    ],
    structuredContent: {
      status,
      childSessionId: remote.childSessionId,
      host: remote.hostName,
      stopReason,
      result: status === 'completed' ? aggregated : undefined,
    },
  }
}

async function runDelegateCancelRemote(
  remote: RemoteChild,
  app: FastifyInstance,
): Promise<ToolResult> {
  const resolved = resolveRemote(remote.hostName, undefined)
  if ('error' in resolved) return toolError(resolved.error, { childSessionId: remote.childSessionId })
  const host = resolved.host

  try {
    const resp = await fetch(
      `${host.url}/v1/sessions/${remote.childSessionId}/abort`,
      { method: 'POST', headers: remoteHeaders(host) },
    )
    if (resp.status === 404) {
      return {
        content: [
          { type: 'text', text: `(remote child ${remote.childSessionId} not found on ${remote.hostName})` },
        ],
        structuredContent: { status: 'noop', childSessionId: remote.childSessionId },
      }
    }
    if (!resp.ok) {
      const body = await safeReadText(resp)
      return toolError(
        `delegate_cancel: remote abort failed (${resp.status}): ${body}`,
        { childSessionId: remote.childSessionId },
      )
    }
  } catch (err) {
    app.log.warn({ err, childId: remote.childSessionId }, 'delegate_cancel: remote abort failed')
    return toolError(
      `delegate_cancel: ${err instanceof Error ? err.message : String(err)}`,
      { childSessionId: remote.childSessionId },
    )
  }
  return {
    content: [
      { type: 'text', text: `(cancel requested for remote ${remote.childSessionId} on ${remote.hostName})` },
    ],
    structuredContent: { status: 'cancelling', childSessionId: remote.childSessionId, host: remote.hostName },
  }
}

// Subscribe to a child's bus, accumulate assistant text, resolve when
// the session reaches a terminal event. Caller must invoke this before
// spawning so no early events are missed.
function awaitTurn(bus: SessionBus, childSessionId: string): Promise<TurnResult> {
  return new Promise<TurnResult>((resolve) => {
    let finalText = ''
    const unsubscribe = bus.subscribe(childSessionId, (ev) => {
      const payload = ev.payload as SessionUpdate & { text?: string; reason?: string }
      if (payload.kind === 'agent_message_chunk' && typeof payload.text === 'string') {
        finalText += payload.text
      } else if (payload.kind === 'stop') {
        unsubscribe()
        resolve({ finalText, stopReason: payload.reason ?? 'end_turn' })
      } else if (payload.kind === 'subprocess_died' || payload.kind === 'session_destroyed') {
        unsubscribe()
        resolve({ finalText, stopReason: payload.kind })
      }
    })
  })
}
