import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { AgentFactory, AgentProcess, AgentSpawnDeps } from './process.js'
import type {
  ContentBlock as WireContent,
  PermissionOutcome,
  Session,
  SessionUpdate,
} from '../types.js'

// Pi RPC events we care about (spec is in pi-mono/packages/coding-agent/docs/rpc.md).
// Pi uses LF-only JSONL framing: split on \n, do NOT use Node `readline`
// (which also splits on Unicode separators inside JSON payloads).

interface PiResponse {
  type: 'response'
  command: string
  id?: string
  success: boolean
  error?: string
  data?: unknown
}

interface PiEvent {
  type: string
  [key: string]: unknown
}

class PiRpcAgent implements AgentProcess {
  private nextId = 1
  private currentMessageId: string | null = null
  private closing = false

  // Pending responses by request id.
  private readonly pending = new Map<
    string,
    { resolve(r: PiResponse): void; reject(e: Error): void }
  >()

  constructor(
    private readonly child: ChildProcess,
    private readonly deps: AgentSpawnDeps,
  ) {}

  // ----- writer -----
  private send(payload: object): void {
    if (!this.child.stdin || this.child.stdin.destroyed) return
    this.child.stdin.write(JSON.stringify(payload) + '\n')
  }

  private async request<T = unknown>(
    type: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ success: boolean; data?: T; error?: string }> {
    const id = String(this.nextId++)
    const promise = new Promise<PiResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.send({ type, id, ...extra })
    const resp = await promise
    return {
      success: resp.success,
      data: resp.data as T | undefined,
      error: resp.error,
    }
  }

  // ----- reader -----
  handleLine(line: string): void {
    if (line.length === 0) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      this.deps.log.warn({ err, line: line.slice(0, 200) }, 'pi: non-JSON line')
      return
    }
    const obj = parsed as PiResponse | PiEvent
    if (obj && (obj as PiResponse).type === 'response') {
      const r = obj as PiResponse
      if (r.id && this.pending.has(r.id)) {
        const slot = this.pending.get(r.id)!
        this.pending.delete(r.id)
        slot.resolve(r)
        return
      }
      // Unsolicited response — ignore.
      return
    }
    this.handleEvent(obj as PiEvent)
  }

  private handleEvent(event: PiEvent): void {
    switch (event.type) {
      case 'agent_start':
      case 'turn_start':
      case 'turn_end':
        return // boundary noise; we already emit our own user_message_chunk + stop

      case 'agent_end':
        this.deps.emit({ kind: 'stop', reason: 'end_turn' })
        return

      case 'message_start':
        this.currentMessageId = randomUUID()
        return

      case 'message_end':
        // currentMessageId stays so any trailing toolcall events still
        // associate; reset on next message_start.
        return

      case 'message_update': {
        const msg = event.assistantMessageEvent as { type: string; delta?: string } | undefined
        if (!msg) return
        if (msg.type === 'text_delta' && typeof msg.delta === 'string') {
          this.deps.emit({
            kind: 'agent_message_chunk',
            messageId: this.currentMessageId,
            text: msg.delta,
          })
        } else if (msg.type === 'thinking_delta' && typeof msg.delta === 'string') {
          this.deps.emit({
            kind: 'agent_thought_chunk',
            messageId: this.currentMessageId,
            text: msg.delta,
          })
        }
        // toolcall_* deltas are summarized via tool_execution_* events.
        return
      }

      case 'tool_execution_start': {
        this.deps.emit({
          kind: 'tool_call',
          toolCallId: String(event.toolCallId ?? ''),
          name: String(event.toolName ?? ''),
          input: event.args,
          status: 'running',
        })
        return
      }

      case 'tool_execution_update': {
        this.deps.emit({
          kind: 'tool_call_update',
          toolCallId: String(event.toolCallId ?? ''),
          status: 'running',
          partialResult: event.partialResult,
        })
        return
      }

      case 'tool_execution_end': {
        this.deps.emit({
          kind: 'tool_call_update',
          toolCallId: String(event.toolCallId ?? ''),
          status: event.isError ? 'error' : 'complete',
          result: event.result,
        })
        return
      }

      // Pi doesn't ask for permissions in the ACP sense — agent runs YOLO.
      // extension_ui_request is for pi extensions; ignore for v0.1.
      default:
        this.deps.log.debug({ type: event.type }, 'pi: unhandled event')
    }
  }

  // ----- AgentProcess -----
  async prompt(content: WireContent[]): Promise<void> {
    this.deps.emit({ kind: 'user_message_chunk', content })
    const text = content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text!)
      .join('\n')
    const images = content
      .filter((c) => c.type === 'image')
      .map((c) => ({ data: c.data, mimeType: c.mimeType }))

    const resp = await this.request('prompt', {
      message: text,
      ...(images.length > 0 ? { images } : {}),
    })
    if (!resp.success) {
      this.deps.log.error({ error: resp.error }, 'pi prompt failed')
      this.deps.emit({ kind: 'stop', reason: 'error' })
    }
    // Real terminal events (`agent_end`) emit our `stop`. The prompt
    // response just acknowledges the command was queued.
  }

  async cancel(): Promise<void> {
    this.send({ type: 'abort' })
  }

  async respondPermission(_requestId: string, _outcome: PermissionOutcome): Promise<void> {
    // Pi does not surface permission requests — no-op.
  }

  async setModelByPair(provider: string, modelId: string): Promise<void> {
    const resp = await this.request('set_model', { provider, modelId })
    if (!resp.success) {
      this.deps.log.warn({ provider, modelId, error: resp.error }, 'pi set_model failed')
    }
  }

  // AgentProcess.setModel — accepts the same "provider:modelId" string
  // shape that POST /v1/sessions takes. Bare value goes to anthropic.
  async setModel(model: string): Promise<void> {
    const parts = model.split(':')
    const provider = parts.length > 1 ? (parts[0] ?? 'anthropic') : 'anthropic'
    const modelId = parts.length > 1 ? parts.slice(1).join(':') : (parts[0] ?? '')
    if (modelId) await this.setModelByPair(provider, modelId)
  }

  async close(): Promise<void> {
    this.closing = true
    try {
      this.child.kill('SIGTERM')
    } catch {}
  }
}

export const piRpcFactory: AgentFactory = {
  async spawn(session: Session, deps: AgentSpawnDeps): Promise<AgentProcess> {
    deps.log.info({ sessionId: session.id, cwd: session.cwd }, 'spawning pi --mode rpc')

    const child = spawn('pi', ['--mode', 'rpc'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: session.cwd,
      env: process.env,
    })

    child.stderr?.on('data', (buf) => {
      const line = buf.toString('utf8').trimEnd()
      if (line) deps.log.info({ stream: 'stderr' }, line)
    })

    const agent = new PiRpcAgent(child, deps)

    child.on('exit', (code, signal) => {
      deps.log.warn({ code, signal }, 'pi exited')
      // Reach into the agent's closing flag so we don't markDead on a
      // graceful close().
      if (!(agent as unknown as { closing: boolean }).closing) {
        deps.markDead(`pi exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
      }
    })

    // LF-only line splitter — `readline` would mishandle U+2028/U+2029
    // inside JSON payloads per pi's framing rules.
    let buffer = ''
    child.stdout?.on('data', (buf: Buffer) => {
      buffer += buf.toString('utf8')
      let nlIdx = buffer.indexOf('\n')
      while (nlIdx !== -1) {
        const rawLine = buffer.slice(0, nlIdx)
        buffer = buffer.slice(nlIdx + 1)
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
        agent.handleLine(line)
        nlIdx = buffer.indexOf('\n')
      }
    })

    // Optional model override at startup. Pi's set_model is best-effort.
    if (session.model) void agent.setModel(session.model)

    return agent
  },
}
