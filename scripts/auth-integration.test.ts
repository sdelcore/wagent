// Integration test for WAGENT_AUTH_TOKEN. Boots a second wagent process
// with the env var set against a temp SQLite, then asserts:
//   - missing Authorization → 401
//   - wrong token → 401
//   - malformed Authorization (no Bearer prefix) → 401
//   - correct token → success on POST /v1/sessions
// 401 body shape is `{"error":"unauthorized"}` (flat, not nested).

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'

const PORT = Number.parseInt(process.env.AUTH_TEST_PORT ?? '12491', 10)
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = 'test-token-correct-horse-battery'

let server: ChildProcess | null = null
let dbDir: string | null = null

before(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'wagent-auth-test-'))
  server = spawn(
    process.execPath,
    ['--import', 'tsx', new URL('../src/server.ts', import.meta.url).pathname],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        WAGENT_PORT: String(PORT),
        WAGENT_HOST: '127.0.0.1',
        WAGENT_DB: join(dbDir, 'auth.sqlite'),
        WAGENT_AUTH_TOKEN: TOKEN,
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

  // Wait for /v1/health to come up — but it's authed now, so we wait for
  // a 401 instead of a 200 to confirm the listener is live.
  const start = Date.now()
  while (Date.now() - start < 15_000) {
    try {
      const r = await fetch(`${BASE}/v1/health`)
      if (r.status === 401) return
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

test('auth: missing Authorization header → 401 + flat error body', async () => {
  const res = await fetch(`${BASE}/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'echo', cwd: '/tmp' }),
  })
  assert.equal(res.status, 401)
  const body = (await res.json()) as { error: unknown }
  assert.equal(body.error, 'unauthorized')
})

test('auth: wrong token → 401', async () => {
  const res = await fetch(`${BASE}/v1/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer wrong-token',
    },
    body: JSON.stringify({ agent: 'echo', cwd: '/tmp' }),
  })
  assert.equal(res.status, 401)
})

test('auth: malformed Authorization (Basic instead of Bearer) → 401', async () => {
  const res = await fetch(`${BASE}/v1/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${TOKEN}`,
    },
    body: JSON.stringify({ agent: 'echo', cwd: '/tmp' }),
  })
  assert.equal(res.status, 401)
})

test('auth: bare token (no scheme) → 401', async () => {
  const res = await fetch(`${BASE}/v1/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: TOKEN,
    },
    body: JSON.stringify({ agent: 'echo', cwd: '/tmp' }),
  })
  assert.equal(res.status, 401)
})

test('auth: correct token → 2xx and creates session', async () => {
  const res = await fetch(`${BASE}/v1/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ agent: 'echo', cwd: '/tmp' }),
  })
  assert.ok(res.status >= 200 && res.status < 300, `expected 2xx, got ${res.status}`)
  const body = (await res.json()) as { id: string; agent: string }
  assert.equal(body.agent, 'echo')
  assert.ok(typeof body.id === 'string' && body.id.length > 0)
})

test('auth: /v1/health is also gated when token configured', async () => {
  const unauth = await fetch(`${BASE}/v1/health`)
  assert.equal(unauth.status, 401)
  const ok = await fetch(`${BASE}/v1/health`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(ok.status, 200)
  const body = (await ok.json()) as { status: string }
  assert.equal(body.status, 'ok')
})

test('auth: /v1/meta is also gated when token configured', async () => {
  const unauth = await fetch(`${BASE}/v1/meta`)
  assert.equal(unauth.status, 401)
  const ok = await fetch(`${BASE}/v1/meta`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(ok.status, 200)
  const body = (await ok.json()) as { capabilities: { auth: string } }
  assert.equal(body.capabilities.auth, 'bearer')
})

test('auth: case-insensitive Bearer scheme accepted', async () => {
  const res = await fetch(`${BASE}/v1/health`, {
    headers: { authorization: `bearer ${TOKEN}` },
  })
  assert.equal(res.status, 200)
})
