// Wire types — stable v1 contract. Mirror these in any client.

export type AgentKind = 'claude' | 'pi' | 'echo'

export type DelegationMode = 'sync' | 'background'

export const MAX_DELEGATION_DEPTH = 3

// MCP server transports accepted on the wire. Mirrors the Claude
// Agent SDK's serializable `McpServerConfig` shape (the non-serializable
// `sdk` instance variant has no wire representation). Forwarded as-is
// into harnesses that support per-session MCP injection.
export interface McpStdioServerConfig {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface McpHttpServerConfig {
  type: 'http'
  url: string
  headers?: Record<string, string>
}

export interface McpSseServerConfig {
  type: 'sse'
  url: string
  headers?: Record<string, string>
}

export type McpServerSpec =
  | McpStdioServerConfig
  | McpHttpServerConfig
  | McpSseServerConfig

// Reserved server name. Caller-supplied `mcpServers` may not use this
// key — it's owned by wagent's per-spawn delegation channel and is
// injected automatically when delegation is wired up.
export const RESERVED_MCP_SERVER_NAME = 'wagent-delegate'

// Per-session knobs that mirror the Claude Agent SDK's `query({ options })`
// shape. Forwarded into the underlying harness at spawn time. Each
// adapter forwards what it can natively express and ignores the rest:
//   - claude: every field passes through to the SDK; mcpServers merges
//             alongside the per-spawn `wagent-delegate` server;
//             permissionMode controls whether tool calls round-trip
//             through wagent's permission API; resume / forkSession
//             load an existing Claude Code transcript by session UUID.
//   - pi:     systemPrompt / appendSystemPrompt map onto pi's
//             DefaultResourceLoader; allowedTools maps onto pi's
//             `tools` allowlist; mcpServers, permissionMode, resume,
//             and forkSession are ignored (pi-coding-agent has no
//             per-session MCP hook, runs without a permission gate,
//             and has no transcript-resume primitive).
//   - echo:   ignored (echo has no model or tools).
// Validation policy: pass through if provided, omit cleanly if not —
// wagent does not synthesize defaults.
//
// permissionMode semantics (claude only):
//   - 'default' / 'ask' / unset: every tool call surfaces as a
//     `permission_request` event that the caller must resolve via
//     POST /v1/sessions/:id/permissions/:requestId. This is wagent's
//     baseline contract.
//   - 'bypass': sets the underlying SDK to `bypassPermissions` and
//     skips wagent's `canUseTool` round-trip entirely. Intended for
//     callers (e.g. ARIA) that enforce tool-use policy upstream and
//     don't want each tool gated through wagent. Equivalent to
//     `claude --permission-mode bypassPermissions`.
//
// resume / forkSession semantics (claude only):
//   - resume: a Claude Code session UUID. The SDK loads the
//     conversation history from `~/.claude/projects/<encoded cwd>/
//     <uuid>.jsonl` and the wagent session continues from there. The
//     `cwd` of this wagent session must match the cwd of the original
//     CLI invocation; otherwise the SDK won't find the transcript.
//   - forkSession: when true alongside `resume`, the SDK forks the
//     resumed transcript to a new session id rather than appending to
//     the original CLI session's JSONL. Without `resume` set,
//     forkSession has no effect (and is rejected at the route layer
//     to surface caller mistakes early).
export type PermissionMode = 'default' | 'ask' | 'bypass'

// Built-in tool selector. Mirrors the Claude Agent SDK's `tools`
// option: an explicit string[] is the base set of built-ins to expose
// (`[]` disables every built-in); the `preset` form opts into all
// default Claude Code built-ins. See sdk.d.ts:
// `tools?: string[] | { type: 'preset'; preset: 'claude_code' }`.
export type BuiltinToolSelector = string[] | { type: 'preset'; preset: 'claude_code' }

export interface SessionOptions {
  systemPrompt?: string
  appendSystemPrompt?: string
  allowedTools?: string[]
  // Hard-deny list. Removed from the model's context — `bypassPermissions`
  // does not override this. Use when a caller (e.g. ARIA's orchestrator)
  // needs to *forbid* a tool, not just *not auto-allow* it.
  disallowedTools?: string[]
  // Base built-in tool set. `[]` strips all built-ins (Read/Edit/Bash/
  // Agent/...) — useful for routing-only personas that should only
  // reach MCP tools. Defaults to all Claude Code built-ins when unset.
  tools?: BuiltinToolSelector
  mcpServers?: Record<string, McpServerSpec>
  permissionMode?: PermissionMode
  resume?: string
  forkSession?: boolean
}

export interface Session {
  id: string
  agent: AgentKind
  cwd: string
  alias: string | null
  model: string | null
  createdAt: number
  updatedAt: number
  destroyedAt: number | null
  parentSessionId: string | null
  parentToolCallId: string | null
  delegationDepth: number
  delegationMode: DelegationMode | null
  options: SessionOptions | null
}

export interface ContentBlock {
  type: 'text' | 'image'
  text?: string
  data?: string // base64
  mimeType?: string
}

export type SessionUpdateKind =
  | 'agent_message_chunk'
  | 'agent_thought_chunk'
  | 'tool_call'
  | 'tool_call_update'
  | 'plan'
  | 'user_message_chunk'
  | 'permission_request'
  | 'permission_resolved'
  | 'stop'
  | 'subprocess_died'
  | 'session_destroyed'
  | 'usage_update'
  | 'error'

// Classification for an `error` event. Callers (e.g. failover policies)
// branch on this rather than string-matching adapter stderr. Adapters
// classify what they can confidently recognise; everything else is
// `internal`.
//
//   rate_limit    HTTP 429 / typed rate-limit error from upstream
//   auth          HTTP 401 / 403 / typed auth-failure
//   quota         HTTP 402 / billing / overage exhausted
//   upstream_5xx  HTTP 5xx from the model provider
//   transport     TCP / TLS / DNS / fetch abort that's not a clean cancel
//   internal      anything wagent can't classify
export type ErrorCategory =
  | 'rate_limit'
  | 'auth'
  | 'quota'
  | 'upstream_5xx'
  | 'transport'
  | 'internal'

// Payload shape for the `error` SessionUpdate. Always emitted alongside
// (or just before) a terminal event — `error` is purely informational
// classification; the turn still ends via `stop` / `subprocess_died`.
export interface ErrorPayload {
  category: ErrorCategory
  retryable: boolean
  retryAfterMs?: number
  message: string
}

// Token usage snapshot. Adapters emit this in a `usage_update` event
// when the underlying harness reports it. All counts are cumulative
// for the session.
export interface UsageSnapshot {
  inputTokens: number
  outputTokens: number
  cachedReadTokens?: number
  cachedWriteTokens?: number
  thoughtTokens?: number
  totalTokens?: number
}

export interface SessionUpdate {
  kind: SessionUpdateKind
  // Variant payload — shape depends on kind. Documented in docs/architecture.md.
  [key: string]: unknown
}

export interface EventEnvelope {
  sessionId: string
  eventIndex: number
  createdAt: number
  kind: SessionUpdateKind
  payload: SessionUpdate
}

// ACP wire vocabulary — `allow_always` / `allow_once` / `reject`.
// Used in both the wire (request body) and the SessionUpdate payload.
export type PermissionOutcome = 'allow_always' | 'allow_once' | 'reject'

export interface PermissionRequest {
  requestId: string
  toolCall: {
    toolCallId: string
    title?: string
    name?: string
  }
  availableOutcomes: PermissionOutcome[]
}

export interface ApiError {
  error: {
    code: string
    message: string
    details?: unknown
  }
}
