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
