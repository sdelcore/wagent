import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { SessionStore } from '../sessions/store.js'
import type { AgentSupervisor } from '../agent/supervisor.js'
import type { DelegateTokenStore } from '../agent/delegate_tokens.js'
import { probeAgent } from '../agent/availability.js'
import {
  MAX_DELEGATION_DEPTH,
  type AgentKind,
  type ContentBlock,
  type DelegationMode,
  type SessionUpdate,
} from '../types.js'
import type { EventStore } from '../events/store.js'
import type { SessionBus } from '../bus.js'

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

const VALID_AGENTS: AgentKind[] = ['claude', 'pi', 'echo']

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
      const resp = await dispatch(msg, parentSessionId, entry.parentDepth, deps, app)
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
  parentDepth: number,
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
              parentDepth,
              deps,
              app,
            )
            return { jsonrpc: '2.0', id, result }
          }
          case 'delegate_status': {
            const result = runDelegateStatus(
              params.arguments as DelegateStatusArgs | undefined,
              parentSessionId,
              deps,
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
      "Spawn a wagent child session running the requested coding-agent harness and send it a single prompt. In sync mode (default) returns the child's final assistant message when it finishes. In background mode returns immediately with a childSessionId; use `delegate_status` to check on it later. Use this to hand off a focused subtask to another agent (possibly a different harness/model). The child runs in its own conversation context — pass anything it needs in `prompt` directly.",
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
            "Working directory for the child. Absolute path. Defaults to the parent's cwd.",
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
  model?: string
  mode?: DelegationMode
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
  parentDepth: number,
  deps: DelegateMcpDeps,
  app: FastifyInstance,
): Promise<ToolResult> {
  if (!args || typeof args !== 'object') {
    return toolError('delegate: missing arguments')
  }
  const { harness, prompt, cwd: cwdArg, model, mode: modeArg } = args
  if (!harness || !VALID_AGENTS.includes(harness)) {
    return toolError(`delegate: harness must be one of ${VALID_AGENTS.join(', ')}`)
  }
  if (typeof prompt !== 'string' || prompt.length === 0) {
    return toolError('delegate: prompt must be a non-empty string')
  }
  const mode: DelegationMode = modeArg === 'background' ? 'background' : 'sync'
  if (modeArg !== undefined && !VALID_MODES.includes(modeArg)) {
    return toolError(`delegate: mode must be one of ${VALID_MODES.join(', ')}`)
  }

  const parent = deps.sessionStore.get(parentSessionId)
  if (!parent) return toolError(`delegate: parent session ${parentSessionId} not found`)
  if (parent.destroyedAt !== null) {
    return toolError('delegate: parent session is destroyed')
  }

  if (parentDepth + 1 > MAX_DELEGATION_DEPTH) {
    return toolError(
      `delegate: depth cap exceeded (max ${MAX_DELEGATION_DEPTH})`,
      { childDepth: parentDepth + 1 },
    )
  }

  const cwd = cwdArg && cwdArg.length > 0 ? cwdArg : parent.cwd
  if (!cwd.startsWith('/')) {
    return toolError('delegate: cwd must be an absolute path')
  }

  const availability = await probeAgent(harness)
  if (!availability.installed) {
    return toolError(
      `delegate: harness ${harness} is not available on this host` +
        (availability.notes ? ` (${availability.notes})` : ''),
    )
  }

  const child = deps.sessionStore.create({
    agent: harness,
    cwd,
    alias: null,
    model: model ?? null,
    parentSessionId: parent.id,
    parentToolCallId: null,
    delegationDepth: parentDepth + 1,
    delegationMode: mode,
  })
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
  let finalText = ''
  let stopReason: string | null = null
  const stopPromise = new Promise<void>((resolve) => {
    const unsubscribe = deps.bus.subscribe(child.id, (ev) => {
      const payload = ev.payload as SessionUpdate & { text?: string; reason?: string }
      if (payload.kind === 'agent_message_chunk' && typeof payload.text === 'string') {
        finalText += payload.text
      } else if (payload.kind === 'stop') {
        stopReason = payload.reason ?? 'end_turn'
        unsubscribe()
        resolve()
      } else if (payload.kind === 'subprocess_died' || payload.kind === 'session_destroyed') {
        stopReason = payload.kind
        unsubscribe()
        resolve()
      }
    })
  })

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

  await stopPromise

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

// Inspect a child's event log to derive its current status and (if
// completed) the assistant text. Cheap: just reads from SQLite.
function runDelegateStatus(
  args: DelegateStatusArgs | undefined,
  parentSessionId: string,
  deps: DelegateMcpDeps,
): ToolResult {
  if (!args || typeof args.childSessionId !== 'string') {
    return toolError('delegate_status: missing childSessionId')
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
