// Wire types — stable v1 contract. Mirror these in any client.

export type AgentKind = 'claude' | 'pi' | 'echo'

export interface Session {
  id: string
  agent: AgentKind
  cwd: string
  alias: string | null
  model: string | null
  createdAt: number
  updatedAt: number
  destroyedAt: number | null
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

export type PermissionReply = 'always' | 'once' | 'reject'

export interface PermissionRequest {
  requestId: string
  toolCall: {
    toolCallId: string
    title?: string
    name?: string
  }
  availableReplies: PermissionReply[]
}

export interface ApiError {
  error: {
    code: string
    message: string
    details?: unknown
  }
}
