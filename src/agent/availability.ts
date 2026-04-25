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
  // Pi is expected to be on PATH. Run `pi --version` with a short
  // timeout; non-zero exit or ENOENT means missing.
  return new Promise<AgentAvailability>((resolve) => {
    let resolved = false
    const child = spawn('pi', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        try {
          child.kill('SIGKILL')
        } catch {}
        resolve({
          id: 'pi',
          installed: false,
          reason: 'probe_failed',
          notes: 'pi --version timed out (>2s)',
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
        id: 'pi',
        installed: false,
        reason: code === 'ENOENT' ? 'binary_missing' : 'probe_failed',
        notes: `pi --version error: ${err.message}`,
      })
    })

    child.on('exit', (code) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      if (code !== 0) {
        resolve({
          id: 'pi',
          installed: false,
          reason: 'probe_failed',
          notes: `pi --version exit code ${code}`,
        })
        return
      }
      resolve({
        id: 'pi',
        installed: true,
        version: out.trim().split('\n')[0],
      })
    })
  })
}
