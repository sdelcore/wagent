import { randomUUID } from 'node:crypto'
import type { AgentFactory, AgentProcess, AgentSpawnDeps } from './process.js'
import type { ContentBlock, PermissionOutcome, Session } from '../types.js'

// A stub agent for end-to-end testing without spawning a real coding agent.
// On every prompt it:
//   1. echoes the user prompt back as a user_message_chunk
//   2. emits a few agent_message_chunks splitting a canned reply
//   3. emits a stop event with reason: end_turn
class EchoAgent implements AgentProcess {
  private currentTurn: { id: string; cancelled: boolean } | null = null

  constructor(
    private readonly session: Session,
    private readonly deps: AgentSpawnDeps,
  ) {}

  async prompt(turnId: string, content: ContentBlock[]): Promise<void> {
    // Supersede: cancel any in-flight turn; its loop breaks at the next
    // tick and emits its own cancelled stop with its own turnId.
    if (this.currentTurn) this.currentTurn.cancelled = true
    const turn = { id: turnId, cancelled: false }
    this.currentTurn = turn

    const messageId = randomUUID()
    const userText = content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')

    this.deps.emit({
      kind: 'user_message_chunk',
      messageId,
      content,
      turnId,
    })

    const reply = userText.length > 0
      ? `(echo from session ${this.session.id.slice(0, 8)}) you said: ${userText}`
      : `(echo from session ${this.session.id.slice(0, 8)})`

    const chunks = chunkText(reply, 16)
    const replyMessageId = randomUUID()
    for (const chunk of chunks) {
      if (turn.cancelled) break
      await sleep(40)
      this.deps.emit({
        kind: 'agent_message_chunk',
        messageId: replyMessageId,
        text: chunk,
        turnId,
      })
    }

    this.deps.emit({
      kind: 'stop',
      reason: turn.cancelled ? 'cancelled' : 'end_turn',
      turnId,
    })
    if (this.currentTurn === turn) this.currentTurn = null
  }

  async cancel(turnId: string): Promise<void> {
    const turn = this.currentTurn
    if (!turn || turn.id !== turnId) return
    turn.cancelled = true
  }

  async respondPermission(_requestId: string, _outcome: PermissionOutcome): Promise<void> {
    // Echo agent never asks for permission.
  }

  async close(): Promise<void> {
    if (this.currentTurn) this.currentTurn.cancelled = true
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
