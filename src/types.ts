// Wire types — stable v1 contract. Mirror these in any client.

export type AgentKind = 'claude' | 'pi' | 'echo'

export type DelegationMode = 'sync' | 'background'

export const MAX_DELEGATION_DEPTH = 3

// Per-session knobs that mirror the Claude Agent SDK's `query({ options })`
// shape. Forwarded into the underlying harness at spawn time. Each
// adapter forwards what it can natively express and ignores the rest:
//   - claude: all three pass straight through to the SDK.
//   - pi:     systemPrompt / appendSystemPrompt map onto pi's
//             DefaultResourceLoader; allowedTools maps onto pi's
//             `tools` allowlist.
//   - echo:   ignored (echo has no model or tools).
// Validation policy: pass through if provided, omit cleanly if not —
// wagent does not synthesize defaults.
export interface SessionOptions {
  systemPrompt?: string
  appendSystemPrompt?: string
  allowedTools?: string[]
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
