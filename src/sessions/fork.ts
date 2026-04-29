import type { EventEnvelope } from '../types.js'

// Modes for `POST /v1/sessions/:id/fork`. See docs/architecture.md.
//
//  - summary    interleaved user + assistant text plus one-line tool
//               summaries. Lossy: tool inputs/outputs are truncated.
//  - transcript verbatim concatenation of assistant text only. No
//               tool calls, no user text — useful when the new harness
//               can't sensibly run prior tool history.
export type ForkMode = 'summary' | 'transcript'

export const VALID_FORK_MODES: ForkMode[] = ['summary', 'transcript']

// Cap the textual length of any single tool input/result we splice into
// the seed message. Forks are lossy by design — the goal is "agent has
// enough context to continue," not "agent gets the verbatim transcript."
// 600 chars is roughly two short paragraphs; longer payloads get a "…
// (truncated)" marker. Keeping this here (not configurable on the
// route) keeps the seed shape predictable across clients.
const TOOL_TEXT_BUDGET = 600

interface AssistantChunk {
  kind: 'agent_message_chunk'
  messageId?: unknown
  text?: unknown
}

interface UserChunk {
  kind: 'user_message_chunk'
  content?: unknown
}

interface ToolCall {
  kind: 'tool_call'
  toolCallId?: unknown
  name?: unknown
  input?: unknown
}

interface ToolCallUpdate {
  kind: 'tool_call_update'
  toolCallId?: unknown
  status?: unknown
  result?: unknown
}

// Build the leading user message text that seeds a forked session. The
// caller passes the parent's full event list (chronological) and the
// chosen mode. Returns the empty string if nothing in the parent's
// history maps onto the chosen mode — callers should treat that as
// "fork has nothing to seed with" and decide whether to seed at all.
export function buildForkSeed(
  parentEvents: EventEnvelope[],
  mode: ForkMode,
  parentSessionId: string,
): string {
  if (mode === 'transcript') {
    return buildTranscript(parentEvents, parentSessionId)
  }
  return buildSummary(parentEvents, parentSessionId)
}

function buildTranscript(events: EventEnvelope[], parentSessionId: string): string {
  // Group consecutive assistant chunks by messageId so each assistant
  // message lands as one paragraph rather than one chunk per line.
  const messages: string[] = []
  let currentId: unknown = null
  let currentText = ''
  for (const ev of events) {
    switch (ev.kind) {
      case 'agent_message_chunk': {
        const chunk = ev.payload as AssistantChunk
        if (typeof chunk.text !== 'string' || chunk.text.length === 0) break
        if (chunk.messageId !== currentId) {
          if (currentText.length > 0) messages.push(currentText)
          currentId = chunk.messageId ?? null
          currentText = chunk.text
        } else {
          currentText += chunk.text
        }
        break
      }
      case 'user_message_chunk':
      case 'agent_thought_chunk':
      case 'tool_call':
      case 'tool_call_update':
      case 'plan':
      case 'permission_request':
      case 'permission_resolved':
      case 'stop':
      case 'subprocess_died':
      case 'session_destroyed':
      case 'usage_update':
      case 'error':
        break
      default:
        assertExhaustive(ev.kind)
    }
  }
  if (currentText.length > 0) messages.push(currentText)
  if (messages.length === 0) return ''
  return [
    `[Forked from session ${parentSessionId} (transcript mode). Prior assistant turns follow; please continue the conversation.]`,
    '',
    messages.join('\n\n'),
  ].join('\n')
}

function buildSummary(events: EventEnvelope[], parentSessionId: string): string {
  // Index tool_call_update by toolCallId so we can pair each tool_call
  // with its result when we render the summary.
  const updates = new Map<string, ToolCallUpdate>()
  for (const ev of events) {
    if (ev.kind !== 'tool_call_update') continue
    const u = ev.payload as ToolCallUpdate
    const id = typeof u.toolCallId === 'string' ? u.toolCallId : null
    if (!id) continue
    // Last update wins — we want the terminal status / result.
    updates.set(id, u)
  }

  const lines: string[] = []
  let currentAssistantId: unknown = null
  let currentAssistantText = ''

  const flushAssistant = () => {
    if (currentAssistantText.length > 0) {
      lines.push(`A: ${currentAssistantText}`)
    }
    currentAssistantId = null
    currentAssistantText = ''
  }

  // Switch with default: never so adding a new SessionUpdateKind to
  // types.ts triggers a tsc error here. Each kind is either rendered or
  // explicitly listed under "intentionally dropped" — the seed is
  // conversational context, not a wire replay, so most kinds (thoughts,
  // plans, permissions, usage, stop, subprocess_died, session_destroyed,
  // error) carry no useful seed content.
  for (const ev of events) {
    switch (ev.kind) {
      case 'user_message_chunk': {
        flushAssistant()
        const u = ev.payload as UserChunk
        const text = extractUserText(u.content)
        if (text.length > 0) lines.push(`U: ${text}`)
        break
      }
      case 'agent_message_chunk': {
        const chunk = ev.payload as AssistantChunk
        if (typeof chunk.text !== 'string' || chunk.text.length === 0) break
        if (chunk.messageId !== currentAssistantId) {
          flushAssistant()
          currentAssistantId = chunk.messageId ?? null
          currentAssistantText = chunk.text
        } else {
          currentAssistantText += chunk.text
        }
        break
      }
      case 'tool_call': {
        flushAssistant()
        const c = ev.payload as ToolCall
        const id = typeof c.toolCallId === 'string' ? c.toolCallId : null
        const name = typeof c.name === 'string' ? c.name : '<unknown>'
        const inputText = truncate(stringify(c.input), TOOL_TEXT_BUDGET)
        const update = id ? updates.get(id) : undefined
        const status = typeof update?.status === 'string' ? update.status : 'pending'
        const resultText =
          update !== undefined
            ? truncate(stringify(update.result), TOOL_TEXT_BUDGET)
            : '(no result)'
        lines.push(`[used ${name} (${status}) with input ${inputText}: ${resultText}]`)
        break
      }
      case 'agent_thought_chunk':
      case 'tool_call_update':
      case 'plan':
      case 'permission_request':
      case 'permission_resolved':
      case 'stop':
      case 'subprocess_died':
      case 'session_destroyed':
      case 'usage_update':
      case 'error':
        break
      default:
        assertExhaustive(ev.kind)
    }
  }
  flushAssistant()

  if (lines.length === 0) return ''
  return [
    `[Forked from session ${parentSessionId} (summary mode). Prior conversation summary follows; tool inputs and outputs are truncated. Please continue from here.]`,
    '',
    lines.join('\n\n'),
  ].join('\n')
}

function extractUserText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: unknown; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n')
}

function stringify(value: unknown): string {
  if (value === undefined) return '(none)'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}… (truncated, ${text.length - max} more chars)`
}

// Compiler-only check: every SessionUpdateKind must be handled in the
// fork-seed switch above. If a new kind lands in types.ts and isn't
// added here (either rendered or listed as intentionally dropped), tsc
// fails with "Argument of type 'X' is not assignable to type 'never'".
function assertExhaustive(_: never): void {}
