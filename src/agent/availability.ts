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
}

const TTL_MS = 30_000
const cache = new Map<AgentKind, { value: AgentAvailability; expiresAt: number }>()

export async function probeAgent(id: AgentKind): Promise<AgentAvailability> {
  const cached = cache.get(id)
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.value

  const value = await runProbe(id)
  cache.set(id, { value, expiresAt: now + TTL_MS })
  return value
}

export async function probeAll(): Promise<AgentAvailability[]> {
  return Promise.all(
    (['echo', 'claude', 'pi'] as AgentKind[]).map((id) => probeAgent(id)),
  )
}

export function clearCache(): void {
  cache.clear()
}

async function runProbe(id: AgentKind): Promise<AgentAvailability> {
  switch (id) {
    case 'echo':
      return { id, installed: true, notes: 'built-in stub agent' }
    case 'claude':
      return probeClaude()
    case 'pi':
      return probePi()
  }
}

async function probeClaude(): Promise<AgentAvailability> {
  // claude-agent-acp ships as an npm dep; presence of the bundled
  // bin under our node_modules is enough to confirm it's installable.
  const binPath = fileURLToPath(
    new URL(
      '../../node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js',
      import.meta.url,
    ),
  )
  if (!existsSync(binPath)) {
    return {
      id: 'claude',
      installed: false,
      reason: 'package_missing',
      notes: '@agentclientprotocol/claude-agent-acp not in node_modules',
    }
  }
  // We don't probe Claude auth here — it's per-session and has many
  // valid forms (subscription OAuth, ANTHROPIC_API_KEY, gateway). The
  // agent itself surfaces auth errors at session/new time.
  return {
    id: 'claude',
    installed: true,
    notes: 'auth via Claude Code OAuth (~/.claude/) or ANTHROPIC_API_KEY',
  }
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
