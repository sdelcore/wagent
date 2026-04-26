import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { Writable, Readable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import type {
  AgentFactory,
  AgentProcess,
  AgentSpawnDeps,
} from './process.js'
import type {
  ContentBlock as WireContent,
  PermissionOutcome,
  Session,
  SessionUpdate,
} from '../types.js'

// Resolver registered while the agent's requestPermission is awaiting.
interface PendingPermission {
  resolve(response: acp.RequestPermissionResponse): void
  optionByOutcome: Partial<Record<PermissionOutcome, string>>
  toolCallId: string
}

class ClaudeAcpAgent implements AgentProcess {
  private readonly pending = new Map<string, PendingPermission>()
  private currentPromptAborter: AbortController | null = null
  private closing = false

  constructor(
    private readonly child: ChildProcess,
    private readonly conn: acp.ClientSideConnection,
    private readonly sessionId: string,
    private readonly wagentSessionId: string,
    private readonly deps: AgentSpawnDeps,
  ) {
    child.on('exit', (code, signal) => {
      this.deps.log.warn({ code, signal }, 'claude-agent-acp exited')
      // Resolve any pending permissions as cancelled so callers don't hang.
      for (const p of this.pending.values()) {
        p.resolve({ outcome: { outcome: 'cancelled' } })
      }
      this.pending.clear()
      if (!this.closing) {
        this.deps.markDead(
          `claude-agent-acp exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
        )
      }
    })
  }

  async prompt(content: WireContent[]): Promise<void> {
    // We emit the user_message_chunk ourselves so the wagent event log
    // has a turn boundary regardless of what the agent emits.
    this.deps.emit({ kind: 'user_message_chunk', content })

    const blocks: acp.ContentBlock[] = content.map((c) =>
      c.type === 'text'
        ? { type: 'text', text: c.text ?? '' }
        : { type: 'image', data: c.data ?? '', mimeType: c.mimeType ?? 'image/png' },
    )

    this.currentPromptAborter = new AbortController()
    try {
      const result = await this.conn.prompt({
        sessionId: this.sessionId,
        prompt: blocks,
      })
      this.deps.emit({ kind: 'stop', reason: stopReasonOf(result.stopReason) })
    } catch (err) {
      this.deps.log.error({ err }, 'prompt failed')
      this.deps.emit({ kind: 'stop', reason: 'error' })
      throw err
    } finally {
      this.currentPromptAborter = null
    }
  }

  async cancel(): Promise<void> {
    try {
      await this.conn.cancel({ sessionId: this.sessionId })
    } catch (err) {
      this.deps.log.warn({ err }, 'cancel notification failed')
    }
  }

  async respondPermission(requestId: string, outcome: PermissionOutcome): Promise<void> {
    const pending = this.pending.get(requestId)
    if (!pending) return // idempotent — already resolved
    this.pending.delete(requestId)
    const optionId =
      pending.optionByOutcome[outcome] ??
      // Fall back to the "once" variant if the requested outcome isn't
      // offered for this particular tool call (some ACP servers only
      // expose one of allow_always / allow_once).
      pending.optionByOutcome.allow_once ??
      pending.optionByOutcome.reject
    if (optionId) {
      pending.resolve({ outcome: { outcome: 'selected', optionId } })
    } else {
      pending.resolve({ outcome: { outcome: 'cancelled' } })
    }
    this.deps.emit({ kind: 'permission_resolved', requestId, outcome })
  }

  async setModel(model: string): Promise<void> {
    // claude-agent-acp exposes setSessionModel under unstable_; the
    // SDK wraps it. Best-effort — failures don't poison the session.
    try {
      const fn = (this.conn as { unstable_setSessionModel?: (p: { sessionId: string; modelId: string }) => Promise<unknown> })
        .unstable_setSessionModel
      if (typeof fn === 'function') {
        await fn.call(this.conn, { sessionId: this.sessionId, modelId: model })
      } else {
        this.deps.log.warn({ model }, 'claude-agent-acp: setSessionModel not available')
      }
    } catch (err) {
      this.deps.log.warn({ err, model }, 'claude setModel failed')
    }
  }

  async close(): Promise<void> {
    this.closing = true
    try {
      this.currentPromptAborter?.abort()
    } catch {}
    try {
      this.child.kill('SIGTERM')
    } catch {}
  }

  // Called by the Client implementation when the agent asks for permission.
  registerPending(toolCallId: string, options: acp.PermissionOption[]): Promise<acp.RequestPermissionResponse> {
    const requestId = toolCallId
    const optionByOutcome = mapOptionsToOutcomes(options)
    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      this.pending.set(requestId, { resolve, optionByOutcome, toolCallId })
      this.deps.emit({
        kind: 'permission_request',
        requestId,
        toolCall: { toolCallId },
        availableOutcomes: Object.keys(optionByOutcome) as PermissionOutcome[],
      })
    })
  }

  forwardSessionUpdate(notification: acp.SessionNotification): void {
    if (notification.sessionId !== this.sessionId) return
    const update = notification.update
    const out = translateUpdate(update)
    if (out) this.deps.emit(out)
  }
}

// Map ACP option kinds to wagent's PermissionOutcome triple. ACP option
// kinds: "allow_once" | "allow_always" | "reject_once" | "reject_always".
// We collapse both reject variants into a single `reject` outcome.
function mapOptionsToOutcomes(
  options: acp.PermissionOption[],
): Partial<Record<PermissionOutcome, string>> {
  const out: Partial<Record<PermissionOutcome, string>> = {}
  for (const opt of options) {
    switch (opt.kind) {
      case 'allow_always':
        out.allow_always = opt.optionId
        break
      case 'allow_once':
        out.allow_once = opt.optionId
        break
      case 'reject_once':
      case 'reject_always':
        if (!out.reject) out.reject = opt.optionId
        break
    }
  }
  return out
}

function stopReasonOf(r: acp.StopReason | undefined): SessionUpdate['reason'] {
  switch (r) {
    case 'end_turn':
      return 'end_turn'
    case 'max_tokens':
      return 'max_tokens'
    case 'cancelled':
      return 'cancelled'
    case 'refusal':
      return 'refusal'
    default:
      return 'end_turn'
  }
}

function translateUpdate(update: acp.SessionNotification['update']): SessionUpdate | null {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = chunkText(update.content)
      return text === null ? null : { kind: 'agent_message_chunk', text }
    }
    case 'agent_thought_chunk': {
      const text = chunkText(update.content)
      return text === null ? null : { kind: 'agent_thought_chunk', text }
    }
    case 'user_message_chunk':
      // We emit our own user_message_chunk in prompt(); avoid duplicates.
      return null
    case 'tool_call':
      return {
        kind: 'tool_call',
        toolCallId: update.toolCallId,
        title: update.title ?? null,
        kind_: update.kind ?? null,
        status: update.status ?? 'pending',
      }
    case 'tool_call_update':
      return {
        kind: 'tool_call_update',
        toolCallId: update.toolCallId,
        status: update.status ?? null,
        title: update.title ?? null,
      }
    case 'plan':
      return { kind: 'plan', entries: update.entries }
    default:
      return null
  }
}

function chunkText(content: acp.ContentBlock): string | null {
  if (content.type === 'text') return content.text
  return null
}

function makeClient(getAgent: () => ClaudeAcpAgent | null): acp.Client {
  return {
    async sessionUpdate(params) {
      const agent = getAgent()
      if (agent) agent.forwardSessionUpdate(params)
    },
    async requestPermission(params) {
      const agent = getAgent()
      if (!agent) return { outcome: { outcome: 'cancelled' } }
      return agent.registerPending(params.toolCall.toolCallId, params.options)
    },
  }
}

function resolveBinary(): string {
  // Prefer the package-bundled bin (works when wagent is npm-installed
  // or running from this repo's node_modules); fall back to PATH.
  const candidate = new URL(
    '../../node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js',
    import.meta.url,
  ).pathname
  return candidate
}

// claude-agent-acp's binary resolver prefers the musl native package
// over the glibc one (linux-${arch}-musl is tried first). On NixOS and
// other glibc-only distros the musl binary fails to load
// (`libc.musl-x86_64.so.1` is unavailable), and the user gets a
// "native binary not found" error even though both packages are on
// disk. If the user already has a working `claude` on PATH, point at
// that explicitly via CLAUDE_CODE_EXECUTABLE so the subprocess uses a
// binary their distro can actually exec.
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

export const claudeAcpFactory: AgentFactory = {
  async spawn(session: Session, deps: AgentSpawnDeps): Promise<AgentProcess> {
    deps.log.info({ sessionId: session.id, cwd: session.cwd }, 'spawning claude-agent-acp')

    const binPath = resolveBinary()
    const claudeExe = detectClaudeExecutable()
    if (claudeExe) deps.log.info({ claudeExe }, 'using detected claude binary')
    const child = spawn(process.execPath, [binPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: claudeExe
        ? { ...process.env, CLAUDE_CODE_EXECUTABLE: claudeExe }
        : process.env,
    })

    child.stderr?.on('data', (buf) => {
      const line = buf.toString('utf8').trimEnd()
      if (line) deps.log.info({ stream: 'stderr' }, line)
    })

    const input = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>
    const output = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
    const stream = acp.ndJsonStream(input, output)

    let agent: ClaudeAcpAgent | null = null
    const conn = new acp.ClientSideConnection(
      () => makeClient(() => agent),
      stream,
    )

    // No fs/terminal capabilities advertised — the claude-agent-acp bundle
    // ships with Claude Code's own read/write/edit/bash tools and uses
    // those when the client doesn't expose them.
    await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    })

    const newResp = await conn.newSession({
      cwd: session.cwd,
      mcpServers: [],
    })

    agent = new ClaudeAcpAgent(child, conn, newResp.sessionId, session.id, deps)
    return agent
  },
}
