// End-to-end smoke test for wagent.
//
// Boots the server in-process, hits the public HTTP API, asserts the
// expected event flow over SSE. The echo agent path runs always; claude
// and pi runs are gated on their dependencies being present (a CLAUDE
// auth, the `pi` binary on PATH).
//
// Usage:
//   npm run smoke              # echo only
//   SMOKE_AGENTS=echo,claude,pi npm run smoke
//
// Exits non-zero on any failure.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const AGENTS = (process.env.SMOKE_AGENTS ?? 'echo')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const PORT = Number.parseInt(process.env.SMOKE_PORT ?? '12480', 10)
const BASE = `http://127.0.0.1:${PORT}`

interface SmokeResult {
  agent: string
  ok: boolean
  detail: string
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await sleep(100)
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

async function startServer(dbDir: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', new URL('../src/server.ts', import.meta.url).pathname],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        WAGENT_PORT: String(PORT),
        WAGENT_HOST: '127.0.0.1',
        WAGENT_DB: join(dbDir, 'smoke.sqlite'),
        LOG_LEVEL: process.env.SMOKE_LOG ?? 'warn',
      },
    },
  )
  child.stderr?.on('data', (b) => process.stderr.write(b))
  child.stdout?.on('data', (b) => {
    if (process.env.SMOKE_VERBOSE) process.stdout.write(b)
  })

  await waitFor(async () => {
    try {
      const r = await fetch(`${BASE}/v1/health`)
      return r.ok
    } catch {
      return false
    }
  })

  return child
}

interface SseEvent {
  id: number
  data: { kind: string; eventIndex: number; payload: { kind: string; [k: string]: unknown } }
}

// Minimal SSE consumer: reads the body, parses event/id/data lines,
// emits parsed events through onEvent until closeWhen returns true.
async function streamUntil(
  url: string,
  onEvent: (e: SseEvent) => void,
  closeWhen: (e: SseEvent) => boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const res = await fetch(url, { signal: ctrl.signal })
  if (!res.ok || !res.body) {
    clearTimeout(timer)
    throw new Error(`SSE connect failed: ${res.status}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx = buf.indexOf('\n\n')
      while (idx !== -1) {
        const block = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const ev = parseSseBlock(block)
        if (ev) {
          onEvent(ev)
          if (closeWhen(ev)) {
            ctrl.abort()
            clearTimeout(timer)
            return
          }
        }
        idx = buf.indexOf('\n\n')
      }
    }
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') return
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function parseSseBlock(block: string): SseEvent | null {
  let id: number | null = null
  let data: string | null = null
  for (const line of block.split('\n')) {
    if (line.startsWith(': ')) continue
    if (line.startsWith('id: ')) id = Number.parseInt(line.slice(4), 10)
    else if (line.startsWith('data: ')) data = line.slice(6)
  }
  if (id === null || data === null) return null
  try {
    return { id, data: JSON.parse(data) }
  } catch {
    return null
  }
}

async function smokeAgent(agent: string): Promise<SmokeResult> {
  const cwd = process.cwd()
  // 1. create
  const create = await fetch(`${BASE}/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent, cwd, alias: `smoke-${agent}` }),
  })
  if (!create.ok) {
    return { agent, ok: false, detail: `create failed: ${create.status} ${await create.text()}` }
  }
  const { id: sessionId } = (await create.json()) as { id: string }

  // 2. start SSE
  const got: SseEvent[] = []
  let sawStop = false
  const streamPromise = streamUntil(
    `${BASE}/v1/sessions/${sessionId}/events/stream`,
    (e) => {
      got.push(e)
      if (e.data.kind === 'stop') sawStop = true
    },
    (e) => e.data.kind === 'stop',
    agent === 'echo' ? 10_000 : 60_000,
  )

  // brief pause so the SSE handler subscribes before we prompt
  await sleep(150)

  // 3. send prompt
  const prompt = await fetch(`${BASE}/v1/sessions/${sessionId}/prompts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: [
        {
          type: 'text',
          text:
            agent === 'echo'
              ? 'hello, echo'
              : 'reply with the single word "ok" and nothing else',
        },
      ],
    }),
  })
  if (!prompt.ok) {
    return { agent, ok: false, detail: `prompt failed: ${prompt.status} ${await prompt.text()}` }
  }

  // 4. wait for stop
  await streamPromise

  // 5. assertions
  if (!sawStop) {
    return { agent, ok: false, detail: `no stop event in ${got.length} events` }
  }
  const indices = got.map((e) => e.id)
  const monotonic = indices.every((v, i) => i === 0 || v > indices[i - 1]!)
  if (!monotonic) {
    return { agent, ok: false, detail: `event_index not monotonic: ${indices.join(',')}` }
  }
  const userChunk = got.find((e) => e.data.kind === 'user_message_chunk')
  if (!userChunk) {
    return { agent, ok: false, detail: 'no user_message_chunk emitted' }
  }
  const stopEvent = got.find((e) => e.data.kind === 'stop')
  const reason = (stopEvent?.data.payload as { reason?: string } | undefined)?.reason

  // 6. cleanup
  await fetch(`${BASE}/v1/sessions/${sessionId}`, { method: 'DELETE' })

  return {
    agent,
    ok: true,
    detail: `${got.length} events, stop reason: ${reason}`,
  }
}

async function main() {
  const dbDir = mkdtempSync(join(tmpdir(), 'wagent-smoke-'))
  const server = await startServer(dbDir)

  const results: SmokeResult[] = []
  try {
    for (const agent of AGENTS) {
      try {
        const result = await smokeAgent(agent)
        results.push(result)
      } catch (err) {
        results.push({
          agent,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        })
      }
    }
  } finally {
    server.kill('SIGTERM')
    rmSync(dbDir, { recursive: true, force: true })
  }

  let failed = 0
  for (const r of results) {
    const tag = r.ok ? 'PASS' : 'FAIL'
    console.log(`${tag} ${r.agent.padEnd(8)} ${r.detail}`)
    if (!r.ok) failed++
  }
  if (failed > 0) {
    console.error(`\n${failed} of ${results.length} smoke runs failed`)
    process.exit(1)
  }
  console.log(`\nall ${results.length} smoke runs passed`)
}

main().catch((err) => {
  console.error('smoke harness crashed:', err)
  process.exit(1)
})
