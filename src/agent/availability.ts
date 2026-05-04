import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AgentKind } from '../types.js'

export interface AgentAvailability {
  id: AgentKind
  installed: boolean
  // Reason the agent is unavailable, if any. Useful for clients deciding
  // whether to surface a "log in" / "install" / "n/a" affordance.
  reason?: 'binary_missing' | 'package_missing' | 'probe_failed'
  // Best-effort version string from the underlying tool.
  version?: string
  // Notes for clients — e.g. auth state, known caveats. Free-form.
  notes?: string
  // Per-agent model catalog. Only populated when probeAll/probeAgent is
  // called with `{ includeModels: true }`. An empty array means the agent
  // is installed but has no enumerable models (echo). Omitted entirely
  // when not requested.
  models?: AgentModel[]
  // Set when includeModels was requested but the underlying enumeration
  // failed (e.g. claude SDK init couldn't reach the CLI, pi registry
  // missing). Free-form string for clients to surface in a UI.
  modelsError?: string
}

// Wire shape for an enumerable model. Fields beyond `id` and `available`
// are optional because the two harnesses surface different metadata
// (pi: provider + cost + context; claude: capability flags). Clients
// should treat unknown fields as additive.
export interface AgentModel {
  // Canonical identifier accepted by `setModel` / POST /v1/sessions
  // `model`. For pi: `<provider>:<id>` (round-trips through the parser
  // in pi_sdk.ts). For claude: the model alias or full id (`sonnet`,
  // `claude-opus-4-7`, etc.) — passed straight through to the SDK.
  id: string
  // Human-readable label. Free-form.
  displayName?: string
  // pi only — the upstream provider key (`anthropic`, `openai`, …).
  // Undefined for claude where the SDK does not surface this.
  provider?: string
  // True if auth is configured and the model is usable right now.
  // pi: ModelRegistry.getAvailable() membership.
  // claude: assumed true when supportedModels() returns the entry —
  // the SDK already filters by what the CLI can reach.
  available: boolean
  // pi only — context window in tokens.
  contextWindow?: number
  // claude only — capability flags pulled from the SDK's ModelInfo.
  supportsEffort?: boolean
  supportedEffortLevels?: ('low' | 'medium' | 'high' | 'xhigh' | 'max')[]
  supportsAdaptiveThinking?: boolean
  supportsFastMode?: boolean
}

const INSTALL_TTL_MS = 30_000
const MODEL_TTL_MS = 10 * 60_000

const installCache = new Map<AgentKind, { value: AgentAvailability; expiresAt: number }>()
const modelCache = new Map<
  AgentKind,
  { models?: AgentModel[]; modelsError?: string; expiresAt: number }
>()

export interface ProbeOptions {
  includeModels?: boolean
}

export async function probeAgent(
  id: AgentKind,
  opts: ProbeOptions = {},
): Promise<AgentAvailability> {
  const now = Date.now()
  const cached = installCache.get(id)
  let base: AgentAvailability
  if (cached && cached.expiresAt > now) {
    base = cached.value
  } else {
    base = await runInstallProbe(id)
    installCache.set(id, { value: base, expiresAt: now + INSTALL_TTL_MS })
  }

  if (!opts.includeModels) return base
  if (!base.installed) return { ...base, models: [] }

  const cachedModels = modelCache.get(id)
  if (cachedModels && cachedModels.expiresAt > now) {
    return {
      ...base,
      ...(cachedModels.models !== undefined ? { models: cachedModels.models } : {}),
      ...(cachedModels.modelsError !== undefined ? { modelsError: cachedModels.modelsError } : {}),
    }
  }

  const probed = await runModelProbe(id)
  modelCache.set(id, { ...probed, expiresAt: now + MODEL_TTL_MS })
  return {
    ...base,
    ...(probed.models !== undefined ? { models: probed.models } : {}),
    ...(probed.modelsError !== undefined ? { modelsError: probed.modelsError } : {}),
  }
}

export async function probeAll(opts: ProbeOptions = {}): Promise<AgentAvailability[]> {
  return Promise.all(
    (['echo', 'claude', 'pi'] as AgentKind[]).map((id) => probeAgent(id, opts)),
  )
}

export function clearCache(): void {
  installCache.clear()
  modelCache.clear()
}

async function runInstallProbe(id: AgentKind): Promise<AgentAvailability> {
  switch (id) {
    case 'echo':
      return { id, installed: true, notes: 'built-in stub agent' }
    case 'claude':
      return probeClaude()
    case 'pi':
      return probePi()
  }
}

async function runModelProbe(
  id: AgentKind,
): Promise<{ models?: AgentModel[]; modelsError?: string }> {
  switch (id) {
    case 'echo':
      return { models: [] }
    case 'pi':
      return probePiModels()
    case 'claude':
      return probeClaudeModels()
  }
}

async function probeClaude(): Promise<AgentAvailability> {
  // The Claude Agent SDK shells out to the `claude` binary (Claude
  // Code's CLI). It must be on PATH (or pointed at via
  // CLAUDE_CODE_EXECUTABLE / pathToClaudeCodeExecutable on NixOS).
  // Auth is per-session — surface errors at session/new time, not here.
  const sdkPkg = fileURLToPath(
    new URL('../../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url),
  )
  if (!existsSync(sdkPkg)) {
    return {
      id: 'claude',
      installed: false,
      reason: 'package_missing',
      notes: '@anthropic-ai/claude-agent-sdk not in node_modules',
    }
  }

  return new Promise<AgentAvailability>((resolve) => {
    let resolved = false
    const claudeBin = process.env.CLAUDE_CODE_EXECUTABLE ?? 'claude'
    const child = spawn(claudeBin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        try {
          child.kill('SIGKILL')
        } catch {}
        resolve({
          id: 'claude',
          installed: false,
          reason: 'probe_failed',
          notes: `${claudeBin} --version timed out (>2s)`,
        })
      }
    }, 2_000)

    let out = ''
    child.stdout?.on('data', (b) => {
      out += b.toString('utf8')
    })

    child.on('error', (err) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      const code = (err as NodeJS.ErrnoException).code
      resolve({
        id: 'claude',
        installed: false,
        reason: code === 'ENOENT' ? 'binary_missing' : 'probe_failed',
        notes: `${claudeBin} --version error: ${err.message}`,
      })
    })

    child.on('exit', (code) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      if (code !== 0) {
        resolve({
          id: 'claude',
          installed: false,
          reason: 'probe_failed',
          notes: `${claudeBin} --version exit code ${code}`,
        })
        return
      }
      resolve({
        id: 'claude',
        installed: true,
        version: out.trim().split('\n')[0],
        notes: 'in-process via @anthropic-ai/claude-agent-sdk; auth via Claude Code OAuth (~/.claude/) or ANTHROPIC_API_KEY',
      })
    })
  })
}

async function probePi(): Promise<AgentAvailability> {
  // Pi runs in-process via the @mariozechner/pi-coding-agent SDK.
  // Presence of the bundled package under our node_modules is enough
  // to confirm pi is usable. Auth is per-model and not probed here —
  // createAgentSession surfaces auth errors at session creation time.
  const pkgPath = fileURLToPath(
    new URL('../../node_modules/@mariozechner/pi-coding-agent/package.json', import.meta.url),
  )
  if (!existsSync(pkgPath)) {
    return {
      id: 'pi',
      installed: false,
      reason: 'package_missing',
      notes: '@mariozechner/pi-coding-agent not in node_modules',
    }
  }
  let version: string | undefined
  try {
    const { readFileSync } = await import('node:fs')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
    version = pkg.version
  } catch {
    // best-effort
  }
  return {
    id: 'pi',
    installed: true,
    version,
    notes: 'in-process via @mariozechner/pi-coding-agent SDK',
  }
}

// Pi enumerates fully in-process — no child spawn needed. We construct
// a one-off ModelRegistry against the user's AuthStorage (same one
// piSdkFactory uses) so `available` reflects the real auth state on
// disk. Cheap; safe to call per-request, but still cached.
async function probePiModels(): Promise<{ models?: AgentModel[]; modelsError?: string }> {
  try {
    const { AuthStorage, ModelRegistry } = await import('@mariozechner/pi-coding-agent')
    const authStorage = AuthStorage.create()
    const registry = ModelRegistry.create(authStorage)
    const all = registry.getAll()
    const availableSet = new Set(
      registry.getAvailable().map((m) => `${m.provider}:${m.id}`),
    )
    const models: AgentModel[] = all.map((m) => {
      const id = `${m.provider}:${m.id}`
      return {
        id,
        displayName: m.name,
        provider: m.provider,
        available: availableSet.has(id),
        contextWindow: m.contextWindow,
      }
    })
    return { models }
  } catch (err) {
    return {
      modelsError: err instanceof Error ? err.message : String(err),
    }
  }
}

const CLAUDE_MODEL_PROBE_BUDGET_MS = 8_000

// Claude does not expose a static list — the Agent SDK's
// `supportedModels()` is the source of truth, but it's a control
// message on a live Query. We spin up a minimal streaming-input query,
// pull the model list, then abort. The CLI handles the control message
// without making any API calls, so this works without auth. Cached for
// MODEL_TTL_MS to keep the first hit cost off the hot path.
async function probeClaudeModels(): Promise<{ models?: AgentModel[]; modelsError?: string }> {
  const abort = new AbortController()
  const budget = setTimeout(() => abort.abort(), CLAUDE_MODEL_PROBE_BUDGET_MS)

  let q: { supportedModels(): Promise<unknown>; interrupt?: () => Promise<void> } | undefined
  try {
    const [{ query }, { detectClaudeExecutable }] = await Promise.all([
      import('@anthropic-ai/claude-agent-sdk'),
      import('./claude_sdk.js'),
    ])
    const claudeBin = detectClaudeExecutable()
    q = query({
      // Hanging async iterable: we never send a user message and never
      // close the stream. Closing it would tear the session down before
      // supportedModels() resolves.
      prompt: hangingPromptStream(abort.signal),
      options: {
        abortController: abort,
        cwd: process.cwd(),
        ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
      },
    }) as unknown as { supportedModels(): Promise<unknown>; interrupt?: () => Promise<void> }
    const raw = (await q.supportedModels()) as Array<{
      value: string
      displayName?: string
      supportsEffort?: boolean
      supportedEffortLevels?: ('low' | 'medium' | 'high' | 'xhigh' | 'max')[]
      supportsAdaptiveThinking?: boolean
      supportsFastMode?: boolean
    }>
    const models: AgentModel[] = raw.map((m) => ({
      id: m.value,
      ...(m.displayName !== undefined ? { displayName: m.displayName } : {}),
      available: true,
      ...(m.supportsEffort !== undefined ? { supportsEffort: m.supportsEffort } : {}),
      ...(m.supportedEffortLevels !== undefined
        ? { supportedEffortLevels: m.supportedEffortLevels }
        : {}),
      ...(m.supportsAdaptiveThinking !== undefined
        ? { supportsAdaptiveThinking: m.supportsAdaptiveThinking }
        : {}),
      ...(m.supportsFastMode !== undefined ? { supportsFastMode: m.supportsFastMode } : {}),
    }))
    return { models }
  } catch (err) {
    return {
      modelsError: err instanceof Error ? err.message : String(err),
    }
  } finally {
    clearTimeout(budget)
    if (!abort.signal.aborted) abort.abort()
  }
}

async function* hangingPromptStream(signal: AbortSignal): AsyncIterable<never> {
  // Resolve when aborted so the iterable can be cleaned up. Yields
  // nothing — supportedModels() is a control message and doesn't need
  // user input.
  await new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}
