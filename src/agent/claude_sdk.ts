import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  query,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { AgentFactory, AgentProcess, AgentSpawnDeps } from './process.js'
import type {
  ContentBlock as WireContent,
  ErrorPayload,
  PermissionOutcome,
  Session,
  SessionUpdate,
} from '../types.js'
import { makeError } from './errors.js'

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
      // If the SDK attached an `error` tag (rate_limit, auth, etc.) emit
      // a typed `error` event so callers can branch on the category.
      const out: SessionUpdate[] = []
      const errorTag = (msg as { error?: SDKAssistantMessageError }).error
      if (errorTag) out.push(errorPayloadToUpdate(classifyAssistantError(errorTag)))
      const content = msg.message.content
      if (!Array.isArray(content)) return out
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

// How long to wait for the `result` that should follow an error-tagged
// assistant message on the main turn. The CLI normally emits it in the
// same breath; observed live (issue #35): a rate_limit-tagged assistant
// message and then silence, wedging the turn forever. When the guard
// fires the turn is terminated so `stop` still reaches consumers.
export const ERROR_TAG_STALL_MS = 10_000

export interface PumpHooks {
  emit(update: SessionUpdate): void
  // Resolve the in-flight turn; must be a no-op when no turn is open.
  resolveTurn(reason: SessionUpdate['reason']): void
  hasOpenTurn(): boolean
  turnAborted(): boolean
  closed(): boolean
  // True when this result belongs to a superseded turn and must not
  // resolve the current one.
  discardResult(): boolean
  armStallGuard(): void
  disarmStallGuard(): void
}

// The adapter's read loop over the SDK stream, extracted so turn
// termination is testable against synthetic streams. Guarantees the
// open turn is resolved no matter how the stream ends: result, clean
// end without a result, or a thrown error (typed `error` event first,
// then resolution — the caller's prompt() emits the terminal `stop`).
export async function pumpClaudeStream(
  stream: AsyncIterable<SDKMessage>,
  state: ClaudeTranslationState,
  hooks: PumpHooks,
): Promise<void> {
  try {
    for await (const msg of stream) {
      if (msg.type === 'result') {
        hooks.disarmStallGuard()
        if (hooks.discardResult()) continue
        hooks.resolveTurn(translateStopReason(msg, hooks.turnAborted()))
        continue
      }
      const updates = translateClaudeMessage(msg, state)
      for (const u of updates) hooks.emit(u)
      // An error-tagged assistant message on the main turn should be
      // followed by a result immediately; guard against the CLI wedging
      // in between. Subagent messages (parent_tool_use_id set) don't end
      // the turn, so they must not arm the guard.
      if (
        msg.type === 'assistant' &&
        (msg as { error?: unknown }).error !== undefined &&
        msg.parent_tool_use_id === null
      ) {
        hooks.armStallGuard()
      }
    }
    if (hooks.hasOpenTurn()) {
      const cancelled = hooks.turnAborted() || hooks.closed()
      if (!cancelled) {
        hooks.emit(
          errorPayloadToUpdate(makeError('internal', 'claude stream ended without a result')),
        )
      }
      hooks.resolveTurn(cancelled ? 'cancelled' : 'error')
    }
  } catch (err) {
    const cancelled = hooks.turnAborted() || hooks.closed()
    if (!cancelled) {
      hooks.emit(errorPayloadToUpdate(classifyThrownError(err)))
    }
    hooks.resolveTurn(cancelled ? 'cancelled' : 'error')
    throw err
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

// Map the Claude Agent SDK's typed in-stream error tag (attached to
// SDKAssistantMessage / SDKAPIRetryMessage) to a wagent ErrorPayload.
// These are the cleanest classification signal — the upstream HTTP
// request already failed with a typed status and the SDK normalised
// it for us.
export function classifyAssistantError(tag: SDKAssistantMessageError): ErrorPayload {
  switch (tag) {
    case 'rate_limit':
      return makeError('rate_limit', 'rate limit exceeded')
    case 'authentication_failed':
      return makeError('auth', 'authentication failed')
    case 'billing_error':
      return makeError('quota', 'billing / quota exhausted')
    case 'server_error':
      return makeError('upstream_5xx', 'upstream 5xx')
    case 'invalid_request':
      return makeError('internal', 'invalid request')
    case 'max_output_tokens':
      return makeError('internal', 'max output tokens reached')
    case 'unknown':
    default:
      return makeError('internal', 'unknown upstream error')
  }
}

// Best-effort classification of an exception thrown by the SDK pump
// (network errors, abort, anything not surfaced as an in-stream tag).
// Duck-typed against the @anthropic-ai/sdk error shapes so we don't take
// a direct dep on that transitive package.
export function classifyThrownError(err: unknown): ErrorPayload {
  if (err === null || err === undefined) {
    return makeError('internal', 'unknown error')
  }
  const e = err as {
    name?: string
    message?: string
    status?: number
    headers?: { get?(name: string): string | null } | Record<string, string | undefined>
    cause?: { code?: string; name?: string }
    code?: string
  }
  const message = e.message ?? String(err)

  // A deliberate AbortError is transport-shaped but not retryable — the
  // user pulled the plug, retrying would be wrong. Override the table.
  if (e.name === 'AbortError' || e.name === 'APIUserAbortError') {
    return makeError('transport', message, { retryable: false })
  }

  const causeCode = e.cause?.code
  if (
    e.name === 'APIConnectionError' ||
    e.name === 'APIConnectionTimeoutError' ||
    e.code === 'ECONNRESET' ||
    e.code === 'ETIMEDOUT' ||
    e.code === 'ENOTFOUND' ||
    causeCode === 'ECONNRESET' ||
    causeCode === 'ETIMEDOUT' ||
    causeCode === 'ENOTFOUND'
  ) {
    return makeError('transport', message)
  }

  const status = typeof e.status === 'number' ? e.status : undefined
  if (status !== undefined) {
    const retryAfterMs = readRetryAfterMs(e.headers)
    if (status === 429) {
      return makeError('rate_limit', message, { retryAfterMs })
    }
    if (status === 401 || status === 403) {
      return makeError('auth', message)
    }
    if (status === 402) {
      return makeError('quota', message)
    }
    if (status >= 500 && status < 600) {
      return makeError('upstream_5xx', message, { retryAfterMs })
    }
    if (status >= 400 && status < 500) {
      return makeError('internal', message)
    }
  }

  return makeError('internal', message)
}

function readRetryAfterMs(
  headers: { get?(name: string): string | null } | Record<string, string | undefined> | undefined,
): number | undefined {
  if (!headers) return undefined
  let raw: string | null | undefined
  const maybeFetchHeaders = headers as { get?(name: string): string | null }
  if (typeof maybeFetchHeaders.get === 'function') {
    raw = maybeFetchHeaders.get('retry-after')
  } else {
    const plain = headers as Record<string, string | undefined>
    raw = plain['retry-after'] ?? plain['Retry-After']
  }
  if (!raw) return undefined
  // RFC 7231: either an integer seconds value or an HTTP-date.
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(raw)
  if (!Number.isNaN(date)) {
    const delta = date - Date.now()
    return delta > 0 ? delta : 0
  }
  return undefined
}

// Build the wire-shaped SessionUpdate for a classified error. Kept
// separate from classify* so adapters can compose / synthesise their
// own payloads (see the pump's catch block).
export function errorPayloadToUpdate(payload: ErrorPayload): SessionUpdate {
  const out: SessionUpdate = {
    kind: 'error',
    category: payload.category,
    retryable: payload.retryable,
    message: payload.message,
  }
  if (payload.retryAfterMs !== undefined) out.retryAfterMs = payload.retryAfterMs
  return out
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
export function detectClaudeExecutable(): string | undefined {
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

interface ClaudeTurn {
  id: string
  aborted: boolean
  resolve(reason: SessionUpdate['reason']): void
}

// How long a supersession waits for the interrupted turn's result
// before declaring the CLI wedged and tearing the query down. A healthy
// interrupt yields the old turn's result within milliseconds.
const SUPERSEDE_DRAIN_MS = 5_000

class ClaudeSdkAgent implements AgentProcess {
  private readonly state: ClaudeTranslationState = { messageId: null }
  private readonly pending = new Map<string, PendingPermission>()
  private readonly queue = new PromptQueue()
  private readonly abort = new AbortController()
  private q: Query | null = null
  private pump: Promise<void> | null = null
  private currentTurn: ClaudeTurn | null = null
  // Number of upcoming `result` messages that belong to superseded
  // turns. The SDK stream is serial — one result per user message — so
  // the first N results after N supersessions are the dead turns'.
  private discardResults = 0
  private discardWaiters: (() => void)[] = []
  private stallTimer: NodeJS.Timeout | null = null
  private closed = false

  constructor(
    private readonly session: Session,
    private readonly deps: AgentSpawnDeps,
  ) {}

  init(): void {
    // Translate per-session SessionOptions into the SDK's `options` shape.
    // - systemPrompt (string) replaces the preset prompt outright.
    // - appendSystemPrompt layers onto the default `claude_code` preset
    //   via { type: 'preset', preset: 'claude_code', append }.
    // - If both are set, replacement wins; appendSystemPrompt is ignored
    //   because the SDK has no "string + append" shape, only one or the
    //   other.
    // - allowedTools passes straight through.
    // - permissionMode 'bypass' hands the SDK `bypassPermissions` mode
    //   and omits `canUseTool`, so tool calls never round-trip through
    //   wagent's permission API. 'default' / 'ask' / unset keep the
    //   gate in place (wagent's baseline contract).
    const sessionOpts = this.session.options
    let systemPromptOpt: Options['systemPrompt']
    if (sessionOpts?.systemPrompt !== undefined) {
      systemPromptOpt = sessionOpts.systemPrompt
      if (sessionOpts.appendSystemPrompt !== undefined) {
        this.deps.log.warn(
          { sessionId: this.session.id },
          'claude: options.systemPrompt overrides; options.appendSystemPrompt ignored',
        )
      }
    } else if (sessionOpts?.appendSystemPrompt !== undefined) {
      systemPromptOpt = {
        type: 'preset',
        preset: 'claude_code',
        append: sessionOpts.appendSystemPrompt,
      }
    }

    // Build the MCP server map. Caller-supplied servers from
    // session.options.mcpServers merge alongside the per-spawn
    // `wagent-delegate` HTTP server (if delegation is wired up). The
    // route layer rejects caller use of the reserved key, so a clobber
    // here would be a programmer error.
    const mcpServers: NonNullable<Options['mcpServers']> = {}
    if (sessionOpts?.mcpServers) {
      for (const [name, spec] of Object.entries(sessionOpts.mcpServers)) {
        mcpServers[name] = spec
      }
    }
    if (this.deps.delegate) {
      mcpServers['wagent-delegate'] = {
        type: 'http',
        url: this.deps.delegate.url,
        headers: { authorization: `Bearer ${this.deps.delegate.token}` },
      }
    }

    const bypassPermissions = sessionOpts?.permissionMode === 'bypass'

    const opts: Options = {
      cwd: this.session.cwd,
      abortController: this.abort,
      includePartialMessages: true,
      // bypass: hand the SDK `bypassPermissions` mode (the safety
      // flag `allowDangerouslySkipPermissions` is required alongside)
      // and skip wagent's own gate. Otherwise install canUseTool so
      // tool calls surface as `permission_request` events.
      ...(bypassPermissions
        ? {
            permissionMode: 'bypassPermissions' as const,
            allowDangerouslySkipPermissions: true,
          }
        : { canUseTool: this.makeCanUseTool() }),
      ...(this.session.model ? { model: this.session.model } : {}),
      ...(systemPromptOpt !== undefined ? { systemPrompt: systemPromptOpt } : {}),
      ...(sessionOpts?.allowedTools !== undefined
        ? { allowedTools: sessionOpts.allowedTools }
        : {}),
      // disallowedTools is a *hard* filter — the SDK removes these tools
      // from the model's context entirely. Survives bypassPermissions, so
      // callers (e.g. ARIA's orchestrator) can guarantee certain tools
      // (Task / Agent) are never reachable even with the bypass mode set.
      ...(sessionOpts?.disallowedTools !== undefined
        ? { disallowedTools: sessionOpts.disallowedTools }
        : {}),
      // tools selects the base built-in set the model sees. `[]` strips
      // every built-in; `{ type: 'preset', preset: 'claude_code' }` opts
      // back in. Unset → SDK default.
      ...(sessionOpts?.tools !== undefined ? { tools: sessionOpts.tools } : {}),
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      // resume picks up an existing Claude Code transcript by session
      // UUID — the SDK loads it from `~/.claude/projects/<encoded
      // cwd>/<uuid>.jsonl`, so cwd above must match the cwd of the
      // original CLI invocation. forkSession (only meaningful with
      // resume; the route layer rejects it standalone) tells the SDK
      // to branch to a new session id instead of appending to the
      // original JSONL.
      ...(sessionOpts?.resume !== undefined ? { resume: sessionOpts.resume } : {}),
      ...(sessionOpts?.forkSession !== undefined
        ? { forkSession: sessionOpts.forkSession }
        : {}),
      ...(detectClaudeExecutable()
        ? { pathToClaudeCodeExecutable: detectClaudeExecutable()! }
        : {}),
    }

    this.q = query({ prompt: this.queue, options: opts })
    // pumpClaudeStream emits the typed `error` event and resolves the
    // in-flight turn before rethrowing, so the turn's `stop` (emitted by
    // prompt()'s continuation, already queued as a microtask) lands on
    // the wire before this catch runs markDead's `subprocess_died`.
    this.pump = pumpClaudeStream(this.q, this.state, this.pumpHooks()).catch((err: unknown) => {
      // Resolve any pending permission as deny so callers don't hang.
      for (const p of this.pending.values()) {
        p.resolve({ behavior: 'deny', message: 'agent terminated' })
      }
      this.pending.clear()
      if (!this.closed) {
        this.deps.log.error({ err }, 'claude-agent-sdk pump failed')
        this.deps.markDead(`claude-agent-sdk pump exited: ${(err as Error).message}`)
      }
    })
  }

  private pumpHooks(): PumpHooks {
    return {
      emit: (u) => this.deps.emit(u),
      resolveTurn: (reason) => {
        const turn = this.currentTurn
        if (!turn) return
        this.currentTurn = null
        turn.resolve(reason)
      },
      hasOpenTurn: () => this.currentTurn !== null,
      turnAborted: () => this.currentTurn?.aborted ?? false,
      closed: () => this.closed,
      discardResult: () => {
        if (this.discardResults === 0) return false
        this.discardResults--
        if (this.discardResults === 0) {
          const waiters = this.discardWaiters
          this.discardWaiters = []
          for (const w of waiters) w()
        }
        return true
      },
      armStallGuard: () => {
        if (this.stallTimer) clearTimeout(this.stallTimer)
        this.stallTimer = setTimeout(() => {
          this.stallTimer = null
          const turn = this.currentTurn
          if (!turn) return
          this.deps.log.warn(
            { turnId: turn.id },
            'claude: no result after error-tagged message, terminating turn',
          )
          this.currentTurn = null
          // If the CLI ever recovers, its late result must not resolve
          // the next turn.
          this.discardResults++
          turn.resolve('error')
        }, ERROR_TAG_STALL_MS)
        this.stallTimer.unref?.()
      },
      disarmStallGuard: () => {
        if (this.stallTimer) {
          clearTimeout(this.stallTimer)
          this.stallTimer = null
        }
      },
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

  async prompt(turnId: string, content: WireContent[]): Promise<void> {
    if (!this.q) throw new Error('claude adapter not initialized')

    this.deps.emit({ kind: 'user_message_chunk', content, turnId })

    const prev = this.currentTurn
    if (prev) {
      try {
        await this.supersede(prev)
      } catch (err) {
        // The old turn is wedged and the query was torn down. Terminate
        // this turn's contract too — it never reached the SDK.
        this.deps.emit({ kind: 'stop', reason: 'error', turnId })
        throw err
      }
    }

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

    const turnDone = new Promise<SessionUpdate['reason']>((resolve) => {
      this.currentTurn = { id: turnId, aborted: false, resolve }
    })

    this.queue.push({
      type: 'user',
      message: { role: 'user', content: blocks },
      parent_tool_use_id: null,
    } as SDKUserMessage)

    const reason = await turnDone
    this.deps.emit({ kind: 'stop', reason, turnId })
  }

  // A prompt arriving while a turn is in flight cancels it: resolve the
  // old turn (its prompt() emits the cancelled stop), interrupt the SDK
  // so it stops generating, and wait for the interrupted turn's result
  // to drain — the SDK stream carries no turn correlation, so the new
  // turn can't start until the old turn's result is accounted for. A
  // drain timeout means the CLI is wedged (issue #36's ghost turn):
  // tear the query down so the next prompt respawns cleanly instead of
  // wedging forever.
  private async supersede(prev: ClaudeTurn): Promise<void> {
    this.currentTurn = null
    this.discardResults++
    prev.resolve('cancelled')
    try {
      await this.interruptQuery()
    } catch (err) {
      this.deps.log.warn({ err }, 'claude: interrupt during supersede failed')
    }
    const drained = await this.waitForDiscardDrain(SUPERSEDE_DRAIN_MS)
    if (!drained) {
      this.abort.abort()
      throw new Error('claude: superseded turn never yielded a result; killing query for respawn')
    }
  }

  private async interruptQuery(): Promise<boolean> {
    // Per the SDK README, the recommended interrupt is Query.interrupt()
    // — not aborting the controller, which tears down the whole
    // conversation.
    const maybeInterrupt = (this.q as unknown as { interrupt?: () => Promise<void> }).interrupt
    if (typeof maybeInterrupt !== 'function') return false
    await maybeInterrupt.call(this.q)
    return true
  }

  private waitForDiscardDrain(ms: number): Promise<boolean> {
    if (this.discardResults === 0) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms)
      timer.unref?.()
      this.discardWaiters.push(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  async cancel(turnId: string): Promise<void> {
    const turn = this.currentTurn
    if (!turn || turn.id !== turnId) return
    turn.aborted = true
    try {
      if (await this.interruptQuery()) return
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
    if (this.stallTimer) {
      clearTimeout(this.stallTimer)
      this.stallTimer = null
    }
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
