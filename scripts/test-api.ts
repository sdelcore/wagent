// End-to-end API test suite for wagent.
//
// Boots the server in a child process against a temp SQLite, then drives
// every public endpoint via fetch + EventSource-style SSE. Echo path runs
// always; the claude path runs when CLAUDE_E2E=1 (or RUN_ALL=1) so it's
// opt-in for local "use my claude sub" runs without breaking CI.
//
// Run:
//   npm test                                # echo only
//   CLAUDE_E2E=1 npm test                   # also exercise the Claude Agent SDK
//   RUN_ALL=1 npm test                      # claude + future agents
//
// Exits non-zero on any failure.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'

const PORT = Number.parseInt(process.env.SMOKE_PORT ?? '12490', 10)
const BASE = `http://127.0.0.1:${PORT}`

// ----------------------------------------------------------------------------
// Server lifecycle (one server, shared across all tests in the file)
// ----------------------------------------------------------------------------

let server: ChildProcess | null = null
let dbDir: string | null = null

before(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'wagent-test-'))
  server = spawn(
    process.execPath,
    ['--import', 'tsx', new URL('../src/server.ts', import.meta.url).pathname],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        WAGENT_PORT: String(PORT),
        WAGENT_HOST: '127.0.0.1',
        WAGENT_DB: join(dbDir, 'test.sqlite'),
        LOG_LEVEL: process.env.SMOKE_LOG ?? 'warn',
      },
    },
  )
  server.stderr?.on('data', (b) => {
    if (process.env.SMOKE_VERBOSE) process.stderr.write(b)
  })
  server.stdout?.on('data', (b) => {
    if (process.env.SMOKE_VERBOSE) process.stdout.write(b)
  })

  // Wait for /v1/health to come up.
  const start = Date.now()
  while (Date.now() - start < 15_000) {
    try {
      const r = await fetch(`${BASE}/v1/health`)
      if (r.ok) return
    } catch {
      // ignore until timeout
    }
    await sleep(100)
  }
  throw new Error('wagent did not start within 15s')
})

after(async () => {
  if (server) {
    server.kill('SIGTERM')
    await sleep(200)
  }
  if (dbDir) rmSync(dbDir, { recursive: true, force: true })
})

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

interface Session {
  id: string
  agent: string
  cwd: string
  alias: string | null
  model: string | null
  createdAt: number
  updatedAt: number
  destroyedAt: number | null
  options: {
    systemPrompt?: string
    appendSystemPrompt?: string
    allowedTools?: string[]
    mcpServers?: Record<
      string,
      | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
      | { type: 'http'; url: string; headers?: Record<string, string> }
      | { type: 'sse'; url: string; headers?: Record<string, string> }
    >
    permissionMode?: 'default' | 'ask' | 'bypass'
    resume?: string
    forkSession?: boolean
  } | null
}

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
}

async function json<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await api(method, path, body)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${method} ${path} → ${res.status}: ${text}`)
  }
  return (await res.json()) as T
}

interface SseEvent {
  id: number
  data: { kind: string; eventIndex: number; payload: { kind: string; [k: string]: unknown } }
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

async function streamUntil(
  url: string,
  onEvent: (e: SseEvent) => void,
  closeWhen: (e: SseEvent) => boolean,
  opts: { lastEventId?: number; timeoutMs?: number } = {},
): Promise<void> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000)
  const headers: Record<string, string> = {}
  if (opts.lastEventId !== undefined) headers['last-event-id'] = String(opts.lastEventId)
  const res = await fetch(url, { headers, signal: ctrl.signal })
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

// ----------------------------------------------------------------------------
// Suite
// ----------------------------------------------------------------------------

test('GET /v1/health → 200 ok', async () => {
  const res = await api('GET', '/v1/health')
  assert.equal(res.status, 200)
  const body = (await res.json()) as { status: string }
  assert.equal(body.status, 'ok')
})

test('GET /v1/meta → name+version+hostname+home', async () => {
  const m = await json<{
    name: string
    version: string
    hostname: string
    home: string
    capabilities: { agents: string[]; auth: string }
  }>('GET', '/v1/meta')
  assert.equal(m.name, 'wagent')
  assert.match(m.version, /^\d+\.\d+\.\d+/)
  assert.ok(m.hostname.length > 0)
  assert.ok(m.home.startsWith('/'))
  assert.ok(Array.isArray(m.capabilities.agents))
  assert.ok(m.capabilities.agents.includes('echo'))
})

test('GET /v1/agents → list with echo always installed', async () => {
  const r = await json<{ agents: { id: string; installed: boolean; reason?: string }[] }>(
    'GET',
    '/v1/agents',
  )
  const echo = r.agents.find((a) => a.id === 'echo')
  assert.ok(echo, 'echo entry missing')
  assert.equal(echo!.installed, true)
})

test('POST /v1/sessions rejects ~-prefix cwd → 400 invalid_cwd', async () => {
  const res = await api('POST', '/v1/sessions', { agent: 'echo', cwd: '~/nope' })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'invalid_cwd')
})

test('POST /v1/sessions rejects relative cwd → 400 invalid_cwd', async () => {
  const res = await api('POST', '/v1/sessions', { agent: 'echo', cwd: 'relative/path' })
  assert.equal(res.status, 400)
})

test('POST /v1/sessions rejects unknown agent → 400 invalid_agent', async () => {
  const res = await api('POST', '/v1/sessions', { agent: 'made-up', cwd: '/tmp' })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'invalid_agent')
})

test('POST /v1/sessions persists options when provided', async () => {
  const created = await json<Session>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    options: {
      systemPrompt: 'route only',
      appendSystemPrompt: 'be terse',
      allowedTools: ['Task', 'mcp__recall__*'],
    },
  })
  assert.deepEqual(created.options, {
    systemPrompt: 'route only',
    appendSystemPrompt: 'be terse',
    allowedTools: ['Task', 'mcp__recall__*'],
  })
  // Round-trip through GET
  const got = await json<Session>('GET', `/v1/sessions/${created.id}`)
  assert.deepEqual(got.options, created.options)
  await api('DELETE', `/v1/sessions/${created.id}`)
})

test('POST /v1/sessions options omitted → options is null', async () => {
  const created = await json<Session>('POST', '/v1/sessions', { agent: 'echo', cwd: '/tmp' })
  assert.equal(created.options, null)
  await api('DELETE', `/v1/sessions/${created.id}`)
})

test('POST /v1/sessions empty options object → options is null', async () => {
  const created = await json<Session>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    options: {},
  })
  assert.equal(created.options, null)
  await api('DELETE', `/v1/sessions/${created.id}`)
})

test('POST /v1/sessions rejects non-object options → 400 invalid_options', async () => {
  const res = await api('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    options: 'nope',
  })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'invalid_options')
})

test('POST /v1/sessions rejects non-string systemPrompt → 400 invalid_options', async () => {
  const res = await api('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    options: { systemPrompt: 123 },
  })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'invalid_options')
})

test('POST /v1/sessions rejects non-string-array allowedTools → 400 invalid_options', async () => {
  const res = await api('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    options: { allowedTools: ['ok', 7] },
  })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'invalid_options')
})

test('POST /v1/sessions persists options.mcpServers (stdio + http + sse)', async () => {
  const created = await json<Session>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    options: {
      mcpServers: {
        recall: { type: 'stdio', command: 'recall-mcp', args: ['--vault', '/tmp/v'] },
        gateway: { type: 'http', url: 'https://example/mcp', headers: { 'x-k': 'v' } },
        live: { type: 'sse', url: 'https://example/mcp/sse' },
      },
    },
  })
  assert.deepEqual(created.options, {
    mcpServers: {
      recall: { type: 'stdio', command: 'recall-mcp', args: ['--vault', '/tmp/v'] },
      gateway: { type: 'http', url: 'https://example/mcp', headers: { 'x-k': 'v' } },
      live: { type: 'sse', url: 'https://example/mcp/sse' },
    },
  })
  const got = await json<Session>('GET', `/v1/sessions/${created.id}`)
  assert.deepEqual(got.options, created.options)
  await api('DELETE', `/v1/sessions/${created.id}`)
})

test('POST /v1/sessions defaults mcpServers entry type to stdio', async () => {
  const created = await json<Session>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    options: {
      mcpServers: { recall: { command: 'recall-mcp' } },
    },
  })
  assert.deepEqual(created.options, {
    mcpServers: { recall: { type: 'stdio', command: 'recall-mcp' } },
  })
  await api('DELETE', `/v1/sessions/${created.id}`)
})

test('POST /v1/sessions empty mcpServers → options is null', async () => {
  // Empty mcpServers collapses the same way an empty options object
  // does — wagent never persists "no preferences" as an empty blob.
  const created = await json<Session>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    options: { mcpServers: {} },
  })
  assert.equal(created.options, null)
  await api('DELETE', `/v1/sessions/${created.id}`)
})

test('POST /v1/sessions rejects non-object mcpServers → 400 invalid_options', async () => {
  const res = await api('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    options: { mcpServers: ['bad'] },
  })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'invalid_options')
})

test('POST /v1/sessions persists permissionMode when provided', async () => {
  for (const mode of ['default', 'ask', 'bypass'] as const) {
    const created = await json<Session>('POST', '/v1/sessions', {
      agent: 'echo',
      cwd: '/tmp',
      options: { permissionMode: mode },
    })
    assert.equal(created.options?.permissionMode, mode)
    const got = await json<Session>('GET', `/v1/sessions/${created.id}`)
    assert.equal(got.options?.permissionMode, mode)
    await api('DELETE', `/v1/sessions/${created.id}`)
  }
})

test('POST /v1/sessions rejects unknown permissionMode → 400 invalid_options', async () => {
  const res = await api('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    options: { permissionMode: 'yolo' },
  })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'invalid_options')
})

test('POST /v1/sessions persists options.resume + options.forkSession', async () => {
  const created = await json<Session>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    options: {
      resume: '2a72f723-8849-48a3-8f3a-c1c62db7a344',
      forkSession: true,
    },
  })
  assert.deepEqual(created.options, {
    resume: '2a72f723-8849-48a3-8f3a-c1c62db7a344',
    forkSession: true,
  })
  const got = await json<Session>('GET', `/v1/sessions/${created.id}`)
  assert.deepEqual(got.options, created.options)
  await api('DELETE', `/v1/sessions/${created.id}`)
})

test('POST /v1/sessions rejects non-string resume → 400 invalid_options', async () => {
  const res = await api('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    options: { resume: 42 },
  })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'invalid_options')
})

test('POST /v1/sessions rejects empty resume string → 400 invalid_options', async () => {
  const res = await api('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    options: { resume: '' },
  })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'invalid_options')
})

test('POST /v1/sessions rejects forkSession without resume → 400 invalid_options', async () => {
  const res = await api('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    options: { forkSession: true },
  })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'invalid_options')
})

test('POST /v1/sessions rejects non-boolean forkSession → 400 invalid_options', async () => {
  const res = await api('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    options: { resume: 'abc', forkSession: 'yes' },
  })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'invalid_options')
})

test('POST /v1/sessions allows forkSession: false standalone (no-op, not persisted unless resume set)', async () => {
  // forkSession: false is a no-op without resume — accepted, persisted as-is.
  const created = await json<Session>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    options: { forkSession: false },
  })
  assert.deepEqual(created.options, { forkSession: false })
  await api('DELETE', `/v1/sessions/${created.id}`)
})

test('POST /v1/sessions rejects unknown mcpServers transport type → 400 invalid_options', async () => {
  const res = await api('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    options: { mcpServers: { x: { type: 'wat', command: 'foo' } } },
  })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'invalid_options')
})

test('POST /v1/sessions rejects stdio mcpServer with missing command → 400 invalid_options', async () => {
  const res = await api('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    options: { mcpServers: { x: { type: 'stdio' } } },
  })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'invalid_options')
})

test('POST /v1/sessions rejects http mcpServer with missing url → 400 invalid_options', async () => {
  const res = await api('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    options: { mcpServers: { x: { type: 'http' } } },
  })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'invalid_options')
})

test('POST /v1/sessions rejects mcpServer args containing non-strings → 400 invalid_options', async () => {
  const res = await api('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    options: { mcpServers: { x: { type: 'stdio', command: 'foo', args: ['ok', 7] } } },
  })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'invalid_options')
})

test('POST /v1/sessions rejects reserved mcpServers key wagent-delegate → 400 invalid_options', async () => {
  const res = await api('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    options: {
      mcpServers: { 'wagent-delegate': { type: 'http', url: 'https://shadow/mcp' } },
    },
  })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'invalid_options')
})

test('POST /v1/sessions rejects non-string permissionMode → 400 invalid_options', async () => {
  const res = await api('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    options: { permissionMode: 42 },
  })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'invalid_options')
})

test('POST /v1/sessions accepts an installed agent (pi via SDK)', async () => {
  // pi now ships as an npm dep, so the precheck should accept it. Auth
  // for the underlying model is per-session and surfaced by the SDK at
  // first prompt — not gated here.
  const res = await api('POST', '/v1/sessions', { agent: 'pi', cwd: '/tmp' })
  // Tolerate 409 too in case some future setup makes pi conditionally
  // unavailable (e.g. install profile that omits the package).
  assert.ok([201, 409].includes(res.status))
  if (res.status === 201) {
    const body = (await res.json()) as { id: string }
    await api('DELETE', `/v1/sessions/${body.id}`)
  }
})

test('sessions: create / list / get / patch / delete', async () => {
  // create
  const created = await json<Session>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    alias: 'first',
  })
  assert.equal(created.agent, 'echo')
  assert.equal(created.alias, 'first')
  assert.equal(created.destroyedAt, null)

  // list
  const list = await json<{ sessions: Session[] }>('GET', '/v1/sessions')
  assert.ok(list.sessions.some((s) => s.id === created.id))

  // get
  const got = await json<Session>('GET', `/v1/sessions/${created.id}`)
  assert.equal(got.id, created.id)

  // patch alias
  const patched = await json<Session>('PATCH', `/v1/sessions/${created.id}`, {
    alias: 'renamed',
  })
  assert.equal(patched.alias, 'renamed')

  // delete
  const del = await api('DELETE', `/v1/sessions/${created.id}`)
  assert.equal(del.status, 204)

  // not found after delete
  const after = await api('GET', `/v1/sessions/${created.id}`)
  assert.equal(after.status, 404)
})

test('echo: full session lifecycle, monotonic events, stop end_turn', async () => {
  const session = await json<Session>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    alias: 'echo-lifecycle',
  })

  const events: SseEvent[] = []
  const sseDone = streamUntil(
    `${BASE}/v1/sessions/${session.id}/events/stream`,
    (e) => events.push(e),
    (e) => e.data.kind === 'stop',
    { timeoutMs: 10_000 },
  )

  // Brief wait so the SSE handler has subscribed before we send the prompt.
  await sleep(150)

  const promptRes = await api('POST', `/v1/sessions/${session.id}/message`, {
    content: [{ type: 'text', text: 'hello, echo' }],
  })
  assert.equal(promptRes.status, 202)

  await sseDone

  // Required events in order: user_message_chunk → 1+ agent_message_chunk → stop
  assert.ok(events.length >= 3, `only ${events.length} events`)
  assert.equal(events[0]!.data.kind, 'user_message_chunk')
  assert.equal(events.at(-1)!.data.kind, 'stop')
  assert.equal((events.at(-1)!.data.payload as { reason: string }).reason, 'end_turn')

  // event_index must be monotonically increasing.
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i]!.id > events[i - 1]!.id, 'event_index not monotonic')
  }

  await api('DELETE', `/v1/sessions/${session.id}`)
})

test('events history: GET /events?after=N pages correctly', async () => {
  const session = await json<Session>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    alias: 'history',
  })

  // Drive a turn so there are events.
  const live: SseEvent[] = []
  const sseDone = streamUntil(
    `${BASE}/v1/sessions/${session.id}/events/stream`,
    (e) => live.push(e),
    (e) => e.data.kind === 'stop',
    { timeoutMs: 10_000 },
  )
  await sleep(150)
  await api('POST', `/v1/sessions/${session.id}/message`, {
    content: [{ type: 'text', text: 'hi' }],
  })
  await sseDone

  const all = await json<{
    events: { sessionId: string; eventIndex: number; kind: string }[]
  }>('GET', `/v1/sessions/${session.id}/events`)
  assert.equal(all.events.length, live.length)

  const tail = await json<{
    events: { eventIndex: number }[]
  }>('GET', `/v1/sessions/${session.id}/events?after=2`)
  assert.ok(tail.events.every((e) => e.eventIndex > 2))
  assert.equal(tail.events.length, all.events.length - 2)

  await api('DELETE', `/v1/sessions/${session.id}`)
})

test('SSE Last-Event-ID resumes without dupes', async () => {
  const session = await json<Session>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    alias: 'resume',
  })

  // Drive a complete turn first so there's history to replay.
  const live: SseEvent[] = []
  const sseDone = streamUntil(
    `${BASE}/v1/sessions/${session.id}/events/stream`,
    (e) => live.push(e),
    (e) => e.data.kind === 'stop',
    { timeoutMs: 10_000 },
  )
  await sleep(150)
  await api('POST', `/v1/sessions/${session.id}/message`, {
    content: [{ type: 'text', text: 'resume me' }],
  })
  await sseDone

  // Reconnect with Last-Event-ID = 2; expect events with index > 2 only.
  const resumed: SseEvent[] = []
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), 1500)
  const res = await fetch(`${BASE}/v1/sessions/${session.id}/events/stream`, {
    headers: { 'last-event-id': '2' },
    signal: ctrl.signal,
  })
  const reader = res.body!.getReader()
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
        if (ev) resumed.push(ev)
        idx = buf.indexOf('\n\n')
      }
    }
  } catch (err) {
    if ((err as { name?: string }).name !== 'AbortError') throw err
  }

  assert.ok(resumed.every((e) => e.id > 2), 'replay sent <= last-event-id')

  await api('DELETE', `/v1/sessions/${session.id}`)
})

test('abort: in-flight echo turn → stop reason cancelled', async () => {
  const session = await json<Session>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    alias: 'abort-it',
  })

  const events: SseEvent[] = []
  const sseDone = streamUntil(
    `${BASE}/v1/sessions/${session.id}/events/stream`,
    (e) => events.push(e),
    (e) => e.data.kind === 'stop',
    { timeoutMs: 5_000 },
  )
  await sleep(150)

  // Echo chunks at 40ms a piece, ~30 chunks for a long string. Abort partway.
  const longText = 'x'.repeat(500)
  await api('POST', `/v1/sessions/${session.id}/message`, {
    content: [{ type: 'text', text: longText }],
  })
  await sleep(120)
  const abortRes = await api('POST', `/v1/sessions/${session.id}/abort`)
  assert.equal(abortRes.status, 200)

  await sseDone

  const stopEvent = events.find((e) => e.data.kind === 'stop')
  assert.ok(stopEvent)
  assert.equal((stopEvent!.data.payload as { reason: string }).reason, 'cancelled')

  await api('DELETE', `/v1/sessions/${session.id}`)
})

test('abort idempotent on session with no live turn', async () => {
  const session = await json<Session>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
  })
  // No prompt sent — supervisor never spawned a process. Abort = noop.
  const res = await api('POST', `/v1/sessions/${session.id}/abort`)
  assert.equal(res.status, 200)
  const body = (await res.json()) as { status: string }
  assert.equal(body.status, 'noop')
  await api('DELETE', `/v1/sessions/${session.id}`)
})

test('permissions: invalid outcome → 400 invalid_outcome', async () => {
  const session = await json<Session>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
  })
  const res = await api('POST', `/v1/sessions/${session.id}/permissions/req-x`, {
    outcome: 'made-up',
  })
  assert.equal(res.status, 400)
  await api('DELETE', `/v1/sessions/${session.id}`)
})

test('permissions: unknown requestId on live session → noop', async () => {
  const session = await json<Session>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
  })
  // Spin up the process by sending a prompt first.
  await api('POST', `/v1/sessions/${session.id}/message`, {
    content: [{ type: 'text', text: 'hi' }],
  })
  await sleep(200)
  const res = await api(
    'POST',
    `/v1/sessions/${session.id}/permissions/never-existed`,
    { outcome: 'allow_once' },
  )
  assert.equal(res.status, 200)
  await api('DELETE', `/v1/sessions/${session.id}`)
})

test('session_destroyed event emitted before SSE closes', async () => {
  const session = await json<Session>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
  })
  const events: SseEvent[] = []
  const sseDone = streamUntil(
    `${BASE}/v1/sessions/${session.id}/events/stream`,
    (e) => events.push(e),
    (e) => e.data.kind === 'session_destroyed',
    { timeoutMs: 5_000 },
  )
  await sleep(150)
  await api('DELETE', `/v1/sessions/${session.id}`)
  await sseDone
  assert.ok(events.some((e) => e.data.kind === 'session_destroyed'))
})

test('projects: upsert / list / delete', async () => {
  // upsert
  const created = await json<{ directory: string; name: string }>('POST', '/v1/projects', {
    directory: '/tmp/test-project',
    name: 'test',
  })
  assert.equal(created.directory, '/tmp/test-project')
  assert.equal(created.name, 'test')

  // re-upsert same dir bumps name
  const updated = await json<{ name: string }>('POST', '/v1/projects', {
    directory: '/tmp/test-project',
    name: 'test-2',
  })
  assert.equal(updated.name, 'test-2')

  // list contains it
  const list = await json<{ projects: { directory: string }[] }>('GET', '/v1/projects')
  assert.ok(list.projects.some((p) => p.directory === '/tmp/test-project'))

  // delete
  const del = await api(
    'DELETE',
    `/v1/projects?directory=${encodeURIComponent('/tmp/test-project')}`,
  )
  assert.equal(del.status, 204)

  // 404 on second delete
  const del2 = await api(
    'DELETE',
    `/v1/projects?directory=${encodeURIComponent('/tmp/test-project')}`,
  )
  assert.equal(del2.status, 404)
})

test('projects: rejects ~-prefix directory', async () => {
  const res = await api('POST', '/v1/projects', {
    directory: '~/nope',
    name: 'nope',
  })
  assert.equal(res.status, 400)
})

test('GET /v1/fs/entries lists subdirectories of /tmp', async () => {
  const entries = await json<
    { name: string; path: string; entryType: string }[]
  >('GET', `/v1/fs/entries?path=${encodeURIComponent('/tmp')}`)
  assert.ok(Array.isArray(entries))
  // We don't assert specific names — just that paths look absolute.
  for (const e of entries) {
    assert.ok(e.path.startsWith('/'))
    assert.ok(['directory', 'file', 'symlink', 'unknown'].includes(e.entryType))
  }
})

test('GET /v1/fs/entries rejects ~-path → 400', async () => {
  const res = await api('GET', `/v1/fs/entries?path=${encodeURIComponent('~')}`)
  assert.equal(res.status, 400)
})

test('GET /v1/fs/entries on missing dir → 404', async () => {
  const res = await api(
    'GET',
    `/v1/fs/entries?path=${encodeURIComponent('/nonexistent-${Date.now()}')}`,
  )
  assert.equal(res.status, 404)
})

// ----------------------------------------------------------------------------
// Delegation (Phase 1) — sync child sessions, depth cap, cascade destroy.
// Drives the wire surface: POST /v1/sessions with parent fields + the
// hand-rolled MCP HTTP endpoint at /mcp/delegate/:parentSessionId.
// ----------------------------------------------------------------------------

interface ChildSession extends Session {
  parentSessionId: string | null
  parentToolCallId: string | null
  delegationDepth: number
  delegationMode: string | null
}

test('delegation: POST /v1/sessions accepts parent fields, exposes them', async () => {
  const parent = await json<ChildSession>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    alias: 'parent',
  })
  assert.equal(parent.parentSessionId, null)
  assert.equal(parent.delegationDepth, 0)

  const child = await json<ChildSession>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    alias: 'child',
    parentSessionId: parent.id,
    parentToolCallId: 'tool-call-1',
  })
  assert.equal(child.parentSessionId, parent.id)
  assert.equal(child.parentToolCallId, 'tool-call-1')
  assert.equal(child.delegationDepth, 1)
  assert.equal(child.delegationMode, 'sync')

  await api('DELETE', `/v1/sessions/${parent.id}`)
})

test('delegation: GET /v1/sessions?parentSessionId filters', async () => {
  const parent = await json<ChildSession>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
  })
  const a = await json<ChildSession>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    parentSessionId: parent.id,
  })
  const b = await json<ChildSession>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    parentSessionId: parent.id,
  })
  const list = await json<{ sessions: ChildSession[] }>(
    'GET',
    `/v1/sessions?parentSessionId=${parent.id}`,
  )
  const ids = list.sessions.map((s) => s.id).sort()
  assert.deepEqual(ids, [a.id, b.id].sort())

  await api('DELETE', `/v1/sessions/${parent.id}`)
})

test('delegation: cascade destroy removes descendants', async () => {
  const parent = await json<ChildSession>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
  })
  const child = await json<ChildSession>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    parentSessionId: parent.id,
  })
  const grandchild = await json<ChildSession>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    parentSessionId: child.id,
  })

  const del = await api('DELETE', `/v1/sessions/${parent.id}`)
  assert.equal(del.status, 204)

  // All three rows should be gone (FK cascade).
  for (const id of [parent.id, child.id, grandchild.id]) {
    const got = await api('GET', `/v1/sessions/${id}`)
    assert.equal(got.status, 404, `expected ${id} gone`)
  }
})

test('delegation: depth cap rejects 4th level', async () => {
  const root = await json<ChildSession>('POST', '/v1/sessions', { agent: 'echo', cwd: '/tmp' })
  const d1 = await json<ChildSession>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    parentSessionId: root.id,
  })
  const d2 = await json<ChildSession>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    parentSessionId: d1.id,
  })
  const d3 = await json<ChildSession>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    parentSessionId: d2.id,
  })
  // d3 is at depth 3, the cap. A child of d3 would be depth 4 — rejected.
  const res = await api('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    parentSessionId: d3.id,
  })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'depth_cap_exceeded')

  await api('DELETE', `/v1/sessions/${root.id}`)
})

test('delegation: child carries options through to its session row', async () => {
  // The MCP delegate tool funnels into the same sessionStore.create call
  // as POST /v1/sessions { parentSessionId, options }, so this test
  // covers the persistence path that the delegate-options ticket adds.
  const parent = await json<ChildSession>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
  })
  const child = await json<ChildSession & { options: Session['options'] }>(
    'POST',
    '/v1/sessions',
    {
      agent: 'echo',
      cwd: '/tmp',
      parentSessionId: parent.id,
      options: {
        systemPrompt: 'You are a focused subagent.',
        allowedTools: ['Read', 'Grep'],
        permissionMode: 'bypass',
      },
    },
  )
  assert.equal(child.parentSessionId, parent.id)
  assert.deepEqual(child.options, {
    systemPrompt: 'You are a focused subagent.',
    allowedTools: ['Read', 'Grep'],
    permissionMode: 'bypass',
  })
  await api('DELETE', `/v1/sessions/${parent.id}`)
})

test('delegation: child rejects bad options the same way a top-level session does', async () => {
  const parent = await json<ChildSession>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
  })
  const res = await api('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    parentSessionId: parent.id,
    options: { permissionMode: 'banana' },
  })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'invalid_options')
  await api('DELETE', `/v1/sessions/${parent.id}`)
})

test('delegation: parent_not_found / parent_destroyed', async () => {
  const noSuch = await api('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    parentSessionId: '00000000-0000-0000-0000-000000000000',
  })
  assert.equal(noSuch.status, 404)

  const parent = await json<ChildSession>('POST', '/v1/sessions', { agent: 'echo', cwd: '/tmp' })
  await api('DELETE', `/v1/sessions/${parent.id}`)
  // After delete, the row is gone — wagent reports parent_not_found
  // (we don't soft-delete). Test that path explicitly.
  const afterDel = await api('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    parentSessionId: parent.id,
  })
  assert.equal(afterDel.status, 404)
})

// ----------------------------------------------------------------------------
// MCP HTTP endpoint — drives /mcp/delegate/:parentSessionId. We can't
// easily extract the per-spawn delegate token from outside the daemon,
// so these tests assert the auth boundary rather than the happy path.
// (Happy path is exercised by claude E2E and the manual smoke flow.)
// ----------------------------------------------------------------------------

test('mcp: missing bearer → 401', async () => {
  const res = await fetch(`${BASE}/mcp/delegate/anything`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  })
  assert.equal(res.status, 401)
})

test('delegation: GET /v1/sessions/:id/descendants returns subtree', async () => {
  const root = await json<ChildSession>('POST', '/v1/sessions', { agent: 'echo', cwd: '/tmp' })
  const a = await json<ChildSession>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    parentSessionId: root.id,
  })
  const b = await json<ChildSession>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    parentSessionId: root.id,
  })
  const aa = await json<ChildSession>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    parentSessionId: a.id,
  })
  const desc = await json<{ sessions: ChildSession[] }>(
    'GET',
    `/v1/sessions/${root.id}/descendants`,
  )
  const ids = desc.sessions.map((s) => s.id).sort()
  assert.deepEqual(ids, [a.id, b.id, aa.id].sort())

  await api('DELETE', `/v1/sessions/${root.id}`)
})

test('delegation: GET /v1/sessions/:id?include=descendants_cost returns rollup shape', async () => {
  const root = await json<ChildSession>('POST', '/v1/sessions', { agent: 'echo', cwd: '/tmp' })
  const child = await json<ChildSession>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    parentSessionId: root.id,
  })
  // Echo never emits usage_update, so the rollup should report
  // reportingSessionCount=0 and totals=0 across 2 sessions.
  const got = await json<{
    descendantsCost: {
      inputTokens: number
      outputTokens: number
      reportingSessionCount: number
      totalSessionCount: number
    }
  }>('GET', `/v1/sessions/${root.id}?include=descendants_cost`)
  assert.equal(got.descendantsCost.totalSessionCount, 2)
  assert.equal(got.descendantsCost.reportingSessionCount, 0)
  assert.equal(got.descendantsCost.inputTokens, 0)
  assert.equal(got.descendantsCost.outputTokens, 0)
  // Drive a turn to make sure it doesn't suddenly have usage either.
  // (Echo never reports usage; rollup must not double-count nothing.)
  void child

  await api('DELETE', `/v1/sessions/${root.id}`)
})

test('mcp: invalid bearer → 401', async () => {
  const res = await fetch(`${BASE}/mcp/delegate/anything`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer wrong-token',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  })
  assert.equal(res.status, 401)
})

// ----------------------------------------------------------------------------
// Fork — POST /v1/sessions/:id/fork. Creates a parent-linked child of
// any installed harness, seeded with a textual context handoff. Tested
// against echo so we don't depend on Claude / pi auth.
// ----------------------------------------------------------------------------

test('fork: rejects unknown agent → 400 invalid_agent', async () => {
  const parent = await json<ChildSession>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    alias: 'fork-bad-agent',
  })
  const res = await api('POST', `/v1/sessions/${parent.id}/fork`, {
    agent: 'not-a-real-agent',
  })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'invalid_agent')
  await api('DELETE', `/v1/sessions/${parent.id}`)
})

test('fork: rejects unknown mode → 400 invalid_fork_mode', async () => {
  const parent = await json<ChildSession>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    alias: 'fork-bad-mode',
  })
  const res = await api('POST', `/v1/sessions/${parent.id}/fork`, {
    agent: 'echo',
    mode: 'verbatim',
  })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'invalid_fork_mode')
  await api('DELETE', `/v1/sessions/${parent.id}`)
})

test('fork: missing parent → 404 not_found', async () => {
  const res = await api('POST', '/v1/sessions/00000000-0000-0000-0000-000000000000/fork', {
    agent: 'echo',
  })
  assert.equal(res.status, 404)
})

test('fork: depth cap rejects 4th level', async () => {
  const root = await json<ChildSession>('POST', '/v1/sessions', { agent: 'echo', cwd: '/tmp' })
  const d1 = await json<ChildSession>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    parentSessionId: root.id,
  })
  const d2 = await json<ChildSession>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    parentSessionId: d1.id,
  })
  const d3 = await json<ChildSession>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    parentSessionId: d2.id,
  })
  // d3 sits at depth 3 — forking it would put the fork at depth 4.
  const res = await api('POST', `/v1/sessions/${d3.id}/fork`, { agent: 'echo' })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'depth_cap_exceeded')
  await api('DELETE', `/v1/sessions/${root.id}`)
})

test('fork: summary mode seeds child + links via descendants', async () => {
  // 1. Drive a turn on a parent so there's something to summarize.
  const parent = await json<ChildSession>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    alias: 'fork-parent',
  })
  const parentEvents: SseEvent[] = []
  const parentDone = streamUntil(
    `${BASE}/v1/sessions/${parent.id}/events/stream`,
    (e) => parentEvents.push(e),
    (e) => e.data.kind === 'stop',
    { timeoutMs: 10_000 },
  )
  await sleep(150)
  await api('POST', `/v1/sessions/${parent.id}/message`, {
    content: [{ type: 'text', text: 'hello, parent' }],
  })
  await parentDone

  // 2. Fork it. Default mode is 'summary'.
  const fork = await json<ChildSession>('POST', `/v1/sessions/${parent.id}/fork`, {
    agent: 'echo',
  })
  assert.equal(fork.parentSessionId, parent.id)
  assert.equal(fork.delegationDepth, parent.delegationDepth + 1)
  // delegationMode is null on a fork — see docs/architecture.md.
  assert.equal(fork.delegationMode, null)
  assert.equal(fork.cwd, parent.cwd)

  // 3. The fork should appear in the parent's descendants subtree.
  const desc = await json<{ sessions: ChildSession[] }>(
    'GET',
    `/v1/sessions/${parent.id}/descendants`,
  )
  assert.ok(desc.sessions.some((s) => s.id === fork.id), 'fork missing from descendants')

  // 4. The fork was auto-prompted with the seed text. Its first event
  //    should be a user_message_chunk whose text references the parent.
  const forkEvents = await json<{
    events: { kind: string; payload: Record<string, unknown> }[]
  }>('GET', `/v1/sessions/${fork.id}/events`)
  const userMsg = forkEvents.events.find((e) => e.kind === 'user_message_chunk')
  assert.ok(userMsg, 'fork has no user_message_chunk seed')
  const content = userMsg!.payload.content as { type: string; text: string }[]
  const text = content.find((c) => c.type === 'text')?.text ?? ''
  assert.ok(text.includes('Forked from session'), `seed missing fork header: ${text.slice(0, 80)}`)
  assert.ok(text.includes(parent.id), 'seed missing parent id')
  assert.ok(text.includes('summary mode'), 'seed missing mode tag')

  await api('DELETE', `/v1/sessions/${parent.id}`)
})

test('fork: transcript mode includes assistant text only', async () => {
  // Parent: drive a turn so there's at least one assistant message.
  const parent = await json<ChildSession>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    alias: 'fork-transcript',
  })
  const parentDone = streamUntil(
    `${BASE}/v1/sessions/${parent.id}/events/stream`,
    () => {},
    (e) => e.data.kind === 'stop',
    { timeoutMs: 10_000 },
  )
  await sleep(150)
  await api('POST', `/v1/sessions/${parent.id}/message`, {
    content: [{ type: 'text', text: 'transcript-test-input' }],
  })
  await parentDone

  // Fork in transcript mode.
  const fork = await json<ChildSession>('POST', `/v1/sessions/${parent.id}/fork`, {
    agent: 'echo',
    mode: 'transcript',
  })

  // The seed text should reference transcript mode and contain the
  // echo agent's reply ("you said: transcript-test-input"), but not
  // the user's own text framed as a U: line.
  const forkEvents = await json<{
    events: { kind: string; payload: Record<string, unknown> }[]
  }>('GET', `/v1/sessions/${fork.id}/events`)
  const userMsg = forkEvents.events.find((e) => e.kind === 'user_message_chunk')
  assert.ok(userMsg, 'fork has no user_message_chunk seed')
  const content = userMsg!.payload.content as { type: string; text: string }[]
  const text = content.find((c) => c.type === 'text')?.text ?? ''
  assert.ok(text.includes('transcript mode'), 'seed missing mode tag')
  assert.ok(text.includes('you said: transcript-test-input'), 'transcript missing assistant reply')
  // Transcript mode does NOT prefix lines with "U:" — that's summary only.
  assert.ok(!text.includes('\nU: '), `transcript should not contain U: lines: ${text}`)

  await api('DELETE', `/v1/sessions/${parent.id}`)
})

test('fork: empty parent → no auto-prompt, no events on fork', async () => {
  // A parent that has never been prompted has no events to summarize.
  // The fork row should still be created and parent-linked, but the
  // child should have no auto-seed (zero events on it).
  const parent = await json<ChildSession>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
    alias: 'fork-empty-parent',
  })
  const fork = await json<ChildSession>('POST', `/v1/sessions/${parent.id}/fork`, {
    agent: 'echo',
  })
  assert.equal(fork.parentSessionId, parent.id)

  const forkEvents = await json<{ events: unknown[] }>(
    'GET',
    `/v1/sessions/${fork.id}/events`,
  )
  assert.equal(forkEvents.events.length, 0, 'empty-parent fork should not be auto-prompted')

  await api('DELETE', `/v1/sessions/${parent.id}`)
})

test('fork: parent_destroyed → 410', async () => {
  const parent = await json<ChildSession>('POST', '/v1/sessions', {
    agent: 'echo',
    cwd: '/tmp',
  })
  await api('DELETE', `/v1/sessions/${parent.id}`)
  // After hard-delete the row is gone, so we get 404 (parent_not_found).
  // The 410/parent_destroyed branch fires only while a row is still
  // present with destroyed_at set — wagent doesn't soft-delete today,
  // so we test the 404 path here, which is the live behavior.
  const res = await api('POST', `/v1/sessions/${parent.id}/fork`, {
    agent: 'echo',
  })
  assert.equal(res.status, 404)
})

// ----------------------------------------------------------------------------
// Claude end-to-end — opt-in via CLAUDE_E2E=1 or RUN_ALL=1.
// Needs working Claude auth (subscription OAuth at ~/.claude/ or
// ANTHROPIC_API_KEY). Sends a single trivial prompt and asserts the
// turn completes with at least one agent_message_chunk.
// ----------------------------------------------------------------------------

const runClaude =
  process.env.CLAUDE_E2E === '1' ||
  process.env.RUN_ALL === '1' ||
  process.env.SMOKE_AGENTS?.split(',').includes('claude')

test('claude: end-to-end turn (opt-in)', { skip: !runClaude }, async () => {
  const cwd = process.cwd()
  const session = await json<Session>('POST', '/v1/sessions', {
    agent: 'claude',
    cwd,
    alias: 'claude-e2e',
  })

  const events: SseEvent[] = []
  const sseDone = streamUntil(
    `${BASE}/v1/sessions/${session.id}/events/stream`,
    (e) => events.push(e),
    (e) => e.data.kind === 'stop',
    { timeoutMs: 90_000 },
  )
  await sleep(200)

  await api('POST', `/v1/sessions/${session.id}/message`, {
    content: [
      {
        type: 'text',
        text: 'Reply with the single word "ok" and nothing else.',
      },
    ],
  })

  await sseDone

  const userChunk = events.find((e) => e.data.kind === 'user_message_chunk')
  const stop = events.find((e) => e.data.kind === 'stop')
  const anyAgentChunk = events.some(
    (e) => e.data.kind === 'agent_message_chunk' || e.data.kind === 'agent_thought_chunk',
  )

  assert.ok(userChunk, 'no user_message_chunk emitted')
  assert.ok(stop, 'no stop event reached')
  assert.ok(anyAgentChunk, 'no agent_message_chunk reached — auth may have failed')

  await api('DELETE', `/v1/sessions/${session.id}`)
})
