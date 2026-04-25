import { randomUUID } from 'node:crypto'
import type { AgentFactory, AgentProcess, AgentSpawnDeps } from './process.js'
import type { ContentBlock, PermissionReply, Session } from '../types.js'

// A stub agent for end-to-end testing without spawning a real coding agent.
// On every prompt it:
//   1. echoes the user prompt back as a user_message_chunk
//   2. emits a few agent_message_chunks splitting a canned reply
//   3. emits a stop event with reason: end_turn
class EchoAgent implements AgentProcess {
  private cancelled = false

  constructor(
    private readonly session: Session,
    private readonly deps: AgentSpawnDeps,
  ) {}

  async prompt(content: ContentBlock[]): Promise<void> {
    this.cancelled = false
    const messageId = randomUUID()
    const userText = content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')

    this.deps.emit({
      kind: 'user_message_chunk',
      messageId,
      content,
    })

    const reply = userText.length > 0
      ? `(echo from session ${this.session.id.slice(0, 8)}) you said: ${userText}`
      : `(echo from session ${this.session.id.slice(0, 8)})`

    const chunks = chunkText(reply, 16)
    const replyMessageId = randomUUID()
    for (const chunk of chunks) {
      if (this.cancelled) break
      await sleep(40)
      this.deps.emit({
        kind: 'agent_message_chunk',
        messageId: replyMessageId,
        text: chunk,
      })
    }

    this.deps.emit({
      kind: 'stop',
      reason: this.cancelled ? 'cancelled' : 'end_turn',
    })
  }

  async cancel(): Promise<void> {
    this.cancelled = true
  }

  async respondPermission(_requestId: string, _reply: PermissionReply): Promise<void> {
    // Echo agent never asks for permission.
  }

  async close(): Promise<void> {
    this.cancelled = true
  }
}

function chunkText(text: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export const echoFactory: AgentFactory = {
  async spawn(session, deps) {
    deps.log.info({ sessionId: session.id }, 'spawning echo agent')
    return new EchoAgent(session, deps)
  },
}
