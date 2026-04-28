import { randomUUID } from 'node:crypto'
import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from '@mariozechner/pi-coding-agent'
import type { ImageContent } from '@mariozechner/pi-ai'
import type { AgentFactory, AgentProcess, AgentSpawnDeps } from './process.js'
import type {
  ContentBlock as WireContent,
  PermissionOutcome,
  Session,
  SessionUpdate,
} from '../types.js'

// Event-translation context. messageId is regenerated on every
// message_start so streaming chunks within a single assistant
// message share an id (matches the existing wire semantics).
export interface PiTranslationContext {
  messageId: string | null
}

// Pure translation from a pi AgentSessionEvent to a wagent
// SessionUpdate (or null when the event is not surfaced on the wire).
// Exported for unit testing — keep this function side-effect-free.
export function translatePiEvent(
  event: AgentSessionEvent,
  ctx: PiTranslationContext,
): SessionUpdate | null {
  switch (event.type) {
    case 'message_start':
      ctx.messageId = randomUUID()
      return null

    case 'message_update': {
      const inner = event.assistantMessageEvent
      if (inner.type === 'text_delta' && typeof inner.delta === 'string') {
        return {
          kind: 'agent_message_chunk',
          messageId: ctx.messageId,
          text: inner.delta,
        }
      }
      if (inner.type === 'thinking_delta' && typeof inner.delta === 'string') {
        return {
          kind: 'agent_thought_chunk',
          messageId: ctx.messageId,
          text: inner.delta,
        }
      }
      // tool_call deltas are summarized via tool_execution_* events
      // below; ignore the per-arg streaming chunks.
      return null
    }

    case 'tool_execution_start':
      return {
        kind: 'tool_call',
        toolCallId: event.toolCallId,
        name: event.toolName,
        input: event.args,
        status: 'running',
      }

    case 'tool_execution_update':
      return {
        kind: 'tool_call_update',
        toolCallId: event.toolCallId,
        status: 'running',
        partialResult: (event as { partialResult?: unknown }).partialResult,
      }

    case 'tool_execution_end':
      return {
        kind: 'tool_call_update',
        toolCallId: event.toolCallId,
        status: event.isError ? 'error' : 'complete',
        result: event.result,
      }

    // agent_start/agent_end/turn_start/turn_end/message_end and the
    // session-lifecycle events (queue_update, compaction_*, retry_*,
    // session_info_changed) are noise on the wire — wagent emits its
    // own user_message_chunk in prompt() and its own stop on prompt()
    // resolution.
    default:
      return null
  }
}

class PiSdkAgent implements AgentProcess {
  private readonly ctx: PiTranslationContext = { messageId: null }
  private readonly unsubscribe: () => void
  private aborted = false

  constructor(
    private readonly session: AgentSession,
    private readonly deps: AgentSpawnDeps,
  ) {
    this.unsubscribe = session.subscribe((event) => {
      const update = translatePiEvent(event, this.ctx)
      if (update) this.deps.emit(update)
    })
  }

  async prompt(content: WireContent[]): Promise<void> {
    this.deps.emit({ kind: 'user_message_chunk', content })

    const text = content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text!)
      .join('\n')

    const images: ImageContent[] = content
      .filter((c) => c.type === 'image')
      .map((c) => ({
        type: 'image',
        data: c.data ?? '',
        mimeType: c.mimeType ?? 'image/png',
      }))

    this.aborted = false
    try {
      await this.session.prompt(text, images.length > 0 ? { images } : undefined)
      this.deps.emit({
        kind: 'stop',
        reason: this.aborted ? 'cancelled' : 'end_turn',
      })
    } catch (err) {
      this.deps.log.error({ err }, 'pi prompt failed')
      this.deps.emit({
        kind: 'stop',
        reason: this.aborted ? 'cancelled' : 'error',
      })
      throw err
    }
  }

  async cancel(): Promise<void> {
    this.aborted = true
    await this.session.abort()
  }

  async respondPermission(_requestId: string, _outcome: PermissionOutcome): Promise<void> {
    // pi's coding agent runs without permission gating — no-op.
  }

  async setModel(model: string): Promise<void> {
    const [providerRaw, ...rest] = model.split(':')
    const provider = rest.length > 0 ? (providerRaw ?? 'anthropic') : 'anthropic'
    const modelId = rest.length > 0 ? rest.join(':') : (providerRaw ?? '')
    if (!modelId) return
    const found = this.session.modelRegistry.find(provider, modelId)
    if (!found) {
      this.deps.log.warn({ provider, modelId }, 'pi: model not found in registry')
      return
    }
    await this.session.setModel(found)
  }

  async close(): Promise<void> {
    try {
      this.unsubscribe()
    } catch {}
    try {
      await this.session.abort()
    } catch {}
    this.session.dispose()
  }
}

export const piSdkFactory: AgentFactory = {
  async spawn(session: Session, deps: AgentSpawnDeps): Promise<AgentProcess> {
    deps.log.info({ sessionId: session.id, cwd: session.cwd }, 'creating pi agent session')

    // In-memory session manager — wagent owns persistence, we don't
    // want pi writing its own session journal under the cwd. Auth
    // storage falls back to the user's ~/.pi/agent/auth.json so
    // OAuth/API-keys configured via `pi` CLI Just Work.
    const authStorage = AuthStorage.create()
    const modelRegistry = ModelRegistry.create(authStorage)

    const { session: agentSession } = await createAgentSession({
      cwd: session.cwd,
      authStorage,
      modelRegistry,
      sessionManager: SessionManager.inMemory(session.cwd),
    })

    const proc = new PiSdkAgent(agentSession, deps)
    if (session.model) {
      await proc.setModel(session.model).catch((err: unknown) => {
        deps.log.warn({ err, model: session.model }, 'pi: initial setModel failed')
      })
    }
    return proc
  },
}
