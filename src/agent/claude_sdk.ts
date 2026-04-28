import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  query,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { AgentFactory, AgentProcess, AgentSpawnDeps } from './process.js'
import type {
  ContentBlock as WireContent,
  PermissionOutcome,
  Session,
  SessionUpdate,
} from '../types.js'

// ---------------------------------------------------------------------------
// Pure translation
// ---------------------------------------------------------------------------

// Stateful so that partial assistant deltas inside one assistant message
// share a `messageId`. Equivalent to the pi adapter's PiTranslationContext.
export interface ClaudeTranslationState {
  messageId: string | null
}

// Translate a single SDKMessage into zero or more wagent SessionUpdates.
// Pure (apart from mutating `state.messageId`), exported for unit tests.
export function translateClaudeMessage(
  msg: SDKMessage,
  state: ClaudeTranslationState,
): SessionUpdate[] {
  switch (msg.type) {
    case 'stream_event': {
      const ev = msg.event
      // message_start mints a new messageId so subsequent deltas share it.
      if (ev.type === 'message_start') {
        state.messageId = randomUUID()
        return []
      }
      if (ev.type === 'content_block_delta') {
        const delta = ev.delta
        if (delta.type === 'text_delta') {
          return [
            {
              kind: 'agent_message_chunk',
              messageId: state.messageId,
              text: delta.text,
            },
          ]
        }
        if (delta.type === 'thinking_delta') {
          return [
            {
              kind: 'agent_thought_chunk',
              messageId: state.messageId,
              text: delta.thinking,
            },
          ]
        }
        return []
      }
      return []
    }

    case 'assistant': {
      // Final assistant message — surface any tool_use blocks as tool_call
      // events. Text/thinking already streamed via stream_event partials.
      const content = msg.message.content
      if (!Array.isArray(content)) return []
      const out: SessionUpdate[] = []
      for (const block of content) {
        if (block && typeof block === 'object' && (block as { type?: string }).type === 'tool_use') {
          const tu = block as { id: string; name: string; input?: unknown }
          out.push({
            kind: 'tool_call',
            toolCallId: tu.id,
            name: tu.name,
            input: tu.input,
            status: 'pending',
          })
        }
      }
      return out
    }

    case 'user': {
      // Tool results arrive as user messages whose content carries
      // tool_result blocks. Surface each as a tool_call_update.
      const message = msg.message as { content?: unknown }
      const content = message.content
      if (!Array.isArray(content)) return []
      const out: SessionUpdate[] = []
      for (const block of content) {
        if (block && typeof block === 'object' && (block as { type?: string }).type === 'tool_result') {
          const tr = block as {
            tool_use_id: string
            content?: unknown
            is_error?: boolean
          }
          out.push({
            kind: 'tool_call_update',
            toolCallId: tr.tool_use_id,
            status: tr.is_error ? 'error' : 'complete',
            result: tr.content,
          })
        }
      }
      return out
    }

    case 'result':
    default:
      // result is consumed by the adapter to drive prompt() resolution;
      // stop emission happens there. Other system/lifecycle messages are
      // not surfaced on the wire.
      return []
  }
}

export function translateStopReason(
  msg: Extract<SDKMessage, { type: 'result' }>,
  aborted: boolean,
): SessionUpdate['reason'] {
  if (aborted) return 'cancelled'
  if (msg.subtype === 'success') {
    switch (msg.stop_reason) {
      case 'end_turn':
        return 'end_turn'
      case 'max_tokens':
        return 'max_tokens'
      case 'refusal':
        return 'refusal'
      default:
        return 'end_turn'
    }
  }
  return 'error'
}

// ---------------------------------------------------------------------------
// Streaming-input queue: lets us push new prompts at any time
// ---------------------------------------------------------------------------

class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly buffer: SDKUserMessage[] = []
  private readonly waiting: ((r: IteratorResult<SDKUserMessage>) => void)[] = []
  private done = false

  push(msg: SDKUserMessage): void {
    if (this.done) return
    const next = this.waiting.shift()
    if (next) {
      next({ value: msg, done: false })
    } else {
      this.buffer.push(msg)
    }
  }

  end(): void {
    this.done = true
    while (this.waiting.length > 0) {
      const w = this.waiting.shift()!
      w({ value: undefined as never, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const queued = this.buffer.shift()
        if (queued) return Promise.resolve({ value: queued, done: false })
        if (this.done) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          this.waiting.push(resolve)
        })
      },
    }
  }
}

// ---------------------------------------------------------------------------
// Pending permissions
// ---------------------------------------------------------------------------

interface PendingPermission {
  resolve(r: PermissionResult): void
}

// Claude Code's bundled launcher prefers the musl native package over
// the glibc one (linux-${arch}-musl is tried first), which fails on
// NixOS and other glibc-only distros. If the host has a working
// `claude` on PATH, point the SDK at it via pathToClaudeCodeExecutable.
function detectClaudeExecutable(): string | undefined {
  if (process.env.CLAUDE_CODE_EXECUTABLE) return process.env.CLAUDE_CODE_EXECUTABLE
  if (process.platform !== 'linux') return undefined
  const which = spawnSync('which', ['claude'], { encoding: 'utf8' })
  if (which.status === 0) {
    const path = which.stdout.trim()
    if (path) return path
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

class ClaudeSdkAgent implements AgentProcess {
  private readonly state: ClaudeTranslationState = { messageId: null }
  private readonly pending = new Map<string, PendingPermission>()
  private readonly queue = new PromptQueue()
  private readonly abort = new AbortController()
  private q: Query | null = null
  private pump: Promise<void> | null = null
  private currentTurn: {
    resolve(reason: SessionUpdate['reason']): void
  } | null = null
  private aborted = false
  private closed = false

  constructor(
    private readonly session: Session,
    private readonly deps: AgentSpawnDeps,
  ) {}

  init(): void {
    const opts: Options = {
      cwd: this.session.cwd,
      abortController: this.abort,
      includePartialMessages: true,
      canUseTool: this.makeCanUseTool(),
      ...(this.session.model ? { model: this.session.model } : {}),
      ...(this.deps.delegate
        ? {
            mcpServers: {
              'wagent-delegate': {
                type: 'http',
                url: this.deps.delegate.url,
                headers: { authorization: `Bearer ${this.deps.delegate.token}` },
              },
            },
          }
        : {}),
      ...(detectClaudeExecutable()
        ? { pathToClaudeCodeExecutable: detectClaudeExecutable()! }
        : {}),
    }

    this.q = query({ prompt: this.queue, options: opts })
    this.pump = this.runPump(this.q).catch((err: unknown) => {
      // Resolve any pending permission as deny so callers don't hang.
      for (const p of this.pending.values()) {
        p.resolve({ behavior: 'deny', message: 'agent terminated' })
      }
      this.pending.clear()
      // Resolve any in-flight turn as error.
      const turn = this.currentTurn
      if (turn) {
        this.currentTurn = null
        turn.resolve(this.aborted ? 'cancelled' : 'error')
      }
      if (!this.closed) {
        this.deps.log.error({ err }, 'claude-agent-sdk pump failed')
        this.deps.markDead(`claude-agent-sdk pump exited: ${(err as Error).message}`)
      }
    })
  }

  private async runPump(q: Query): Promise<void> {
    for await (const msg of q) {
      if (msg.type === 'result') {
        const reason = translateStopReason(msg, this.aborted)
        const turn = this.currentTurn
        if (turn) {
          this.currentTurn = null
          turn.resolve(reason)
        }
        continue
      }
      const updates = translateClaudeMessage(msg, this.state)
      for (const u of updates) this.deps.emit(u)
    }
  }

  private makeCanUseTool(): CanUseTool {
    return async (toolName, input, options) => {
      const requestId = randomUUID()
      const promise = new Promise<PermissionResult>((resolve) => {
        this.pending.set(requestId, { resolve })
      })
      this.deps.emit({
        kind: 'permission_request',
        requestId,
        toolCall: { toolCallId: requestId, name: toolName, input },
        availableOutcomes: ['allow_once', 'allow_always', 'reject'],
      })
      // Race against signal abort so we don't hang if the SDK cancels.
      return await Promise.race<PermissionResult>([
        promise,
        new Promise<PermissionResult>((resolve) => {
          options.signal.addEventListener('abort', () => {
            this.pending.delete(requestId)
            resolve({ behavior: 'deny', message: 'aborted' })
          })
        }),
      ])
    }
  }

  async prompt(content: WireContent[]): Promise<void> {
    if (!this.q) throw new Error('claude adapter not initialized')

    this.deps.emit({ kind: 'user_message_chunk', content })

    // Translate wire content blocks into the Anthropic message-param
    // shape the SDK expects.
    const blocks = content.map((c) =>
      c.type === 'text'
        ? { type: 'text' as const, text: c.text ?? '' }
        : {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: (c.mimeType ?? 'image/png') as
                | 'image/png'
                | 'image/jpeg'
                | 'image/gif'
                | 'image/webp',
              data: c.data ?? '',
            },
          },
    )

    this.aborted = false
    const turnDone = new Promise<SessionUpdate['reason']>((resolve) => {
      this.currentTurn = { resolve }
    })

    this.queue.push({
      type: 'user',
      message: { role: 'user', content: blocks },
      parent_tool_use_id: null,
    } as SDKUserMessage)

    const reason = await turnDone
    this.deps.emit({ kind: 'stop', reason })
  }

  async cancel(): Promise<void> {
    this.aborted = true
    try {
      // Per the SDK README, the recommended interrupt is Query.interrupt()
      // — not aborting the controller, which tears down the whole
      // conversation. Try interrupt first, fall back to abort.
      const maybeInterrupt = (this.q as unknown as { interrupt?: () => Promise<void> }).interrupt
      if (typeof maybeInterrupt === 'function') {
        await maybeInterrupt.call(this.q)
        return
      }
    } catch (err) {
      this.deps.log.warn({ err }, 'claude: interrupt failed, falling back to abort')
    }
    this.abort.abort()
  }

  async respondPermission(requestId: string, outcome: PermissionOutcome): Promise<void> {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    if (outcome === 'reject') {
      pending.resolve({ behavior: 'deny', message: 'rejected by user' })
    } else {
      pending.resolve({ behavior: 'allow' })
    }
    this.deps.emit({ kind: 'permission_resolved', requestId, outcome })
  }

  async setModel(model: string): Promise<void> {
    // V1 streaming-input mode locks the model for the conversation;
    // changing it would require restarting query() with `resume`. For now
    // mirror the old adapter's best-effort semantics: log and persist
    // (DB row already updated by the route layer for the next spawn).
    this.deps.log.warn(
      { model },
      'claude: setModel applies to next session spawn, not the live one',
    )
  }

  async close(): Promise<void> {
    this.closed = true
    try {
      this.queue.end()
    } catch {}
    try {
      this.abort.abort()
    } catch {}
    if (this.pump) {
      await this.pump.catch(() => {})
    }
  }
}

export const claudeSdkFactory: AgentFactory = {
  async spawn(session: Session, deps: AgentSpawnDeps): Promise<AgentProcess> {
    deps.log.info({ sessionId: session.id, cwd: session.cwd }, 'creating claude SDK agent')
    const exe = detectClaudeExecutable()
    if (exe) deps.log.info({ claudeExe: exe }, 'using detected claude binary')
    const proc = new ClaudeSdkAgent(session, deps)
    proc.init()
    return proc
  },
}
