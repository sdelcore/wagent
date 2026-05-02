// Integration test for the `wagent-on` CLI. Drives the runner against
// a fake wagent HTTP+SSE server so we don't need a real claude binary
// to verify the round-trip wire shape.
//
// Covered:
//   - happy path: prompt → final assistant text on stdout, nothing else
//   - --resume passes through to session-create options.resume
//   - --json emits one envelope per line on stdout
//   - 5xx from session create surfaces a non-zero exit + stderr message
//   - Authorization: Bearer <token> sent when host has auth_token_env
//   - unknown host → exit 1, lists known hosts on stderr

import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { run } from '../src/cli/on.js'
import { parseHostsToml, type HostsConfig } from '../src/cli/on-config.js'

interface CapturedRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

interface FakeSseFrame {
  kind: string
  text?: string
  name?: string
  category?: string
  message?: string
}

interface FakeServer {
  url: string
  close: () => Promise<void>
  requests: CapturedRequest[]
  // Configure what the next session-stream emits.
  setStream: (frames: FakeSseFrame[]) => void
  setSessionStatus: (code: number, body?: string) => void
}

// Minimal wagent emulator: accepts POST /v1/sessions, POST
// /v1/sessions/:id/message, GET /v1/sessions/:id/events/stream. Emits
// the configured SSE frame list then closes.
async function startFakeServer(): Promise<FakeServer> {
  const requests: CapturedRequest[] = []
  let frames: FakeSseFrame[] = [{ kind: 'stop' }]
  let sessionStatus = 201
  let sessionBody: string | undefined

  const collectBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await collectBody(req)
    requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      headers: { ...req.headers },
      body,
    })

    if (req.method === 'POST' && req.url === '/v1/sessions') {
      if (sessionStatus >= 400) {
        res.writeHead(sessionStatus, { 'content-type': 'text/plain' })
        res.end(sessionBody ?? 'fake error')
        return
      }
      res.writeHead(sessionStatus, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'fake-session-id', agent: 'claude', cwd: '/tmp' }))
      return
    }
    if (req.method === 'POST' && req.url?.endsWith('/message')) {
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'accepted' }))
      return
    }
    if (req.method === 'GET' && req.url?.endsWith('/events/stream')) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })
      let i = 1
      for (const f of frames) {
        const envelope = {
          sessionId: 'fake-session-id',
          eventIndex: i++,
          createdAt: Date.now(),
          kind: f.kind,
          payload: { kind: f.kind, ...f },
        }
        res.write(`event: session_update\nid: ${envelope.eventIndex}\ndata: ${JSON.stringify(envelope)}\n\n`)
      }
      res.end()
      return
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  const url = `http://127.0.0.1:${addr.port}`

  return {
    url,
    requests,
    setStream(next) {
      frames = next
    },
    setSessionStatus(code, b) {
      sessionStatus = code
      sessionBody = b
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

interface CapturedStdio {
  out: string
  err: string
  stdout: { write: (s: string) => void }
  stderr: { write: (s: string) => void }
}
function captureStdio(): CapturedStdio {
  const c: CapturedStdio = {
    out: '',
    err: '',
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  }
  c.stdout.write = (s: string) => {
    c.out += s
  }
  c.stderr.write = (s: string) => {
    c.err += s
  }
  return c
}

let fake: FakeServer | null = null

before(async () => {
  fake = await startFakeServer()
})

after(async () => {
  if (fake) await fake.close()
})

function configFor(server: FakeServer, extra = ''): HostsConfig {
  return parseHostsToml(`
    [hosts.lab]
    url = "${server.url}"
    default_cwd = "/tmp/work"
    ${extra}
  `)
}

test('wagent-on: round-trip yields exactly the assistant text on stdout', async () => {
  const server = fake!
  server.requests.length = 0
  server.setStream([
    { kind: 'agent_message_chunk', text: 'hello ' },
    { kind: 'agent_message_chunk', text: 'world' },
    { kind: 'stop' },
  ])
  const stdio = captureStdio()
  const code = await run(['lab', 'reply with hello world'], {
    fetch: globalThis.fetch.bind(globalThis),
    loadConfig: () => configFor(server),
    stdin: async () => '',
    stdout: stdio.stdout,
    stderr: stdio.stderr,
  })
  assert.equal(code, 0)
  assert.equal(stdio.out, 'hello world\n')
  assert.equal(stdio.err, '')
})

test('wagent-on: --resume passes through to session-create options.resume', async () => {
  const server = fake!
  server.requests.length = 0
  server.setStream([
    { kind: 'agent_message_chunk', text: 'ok' },
    { kind: 'stop' },
  ])
  const stdio = captureStdio()
  const code = await run(
    ['lab', '--resume', 'cafef00d-1234-5678-9abc-def012345678', 'continue'],
    {
      fetch: globalThis.fetch.bind(globalThis),
      loadConfig: () => configFor(server),
      stdin: async () => '',
      stdout: stdio.stdout,
      stderr: stdio.stderr,
    },
  )
  assert.equal(code, 0)
  const create = server.requests.find(
    (r) => r.method === 'POST' && r.url === '/v1/sessions',
  )
  assert.ok(create, 'session create request was made')
  const body = JSON.parse(create!.body) as {
    agent: string
    cwd: string
    options?: { resume?: string }
  }
  assert.equal(body.agent, 'claude')
  assert.equal(body.cwd, '/tmp/work')
  assert.equal(body.options?.resume, 'cafef00d-1234-5678-9abc-def012345678')
})

test('wagent-on: --model passes through to session-create body', async () => {
  const server = fake!
  server.requests.length = 0
  server.setStream([
    { kind: 'agent_message_chunk', text: 'ok' },
    { kind: 'stop' },
  ])
  const stdio = captureStdio()
  const code = await run(['lab', '--model', 'claude-opus-4', 'go'], {
    fetch: globalThis.fetch.bind(globalThis),
    loadConfig: () => configFor(server),
    stdin: async () => '',
    stdout: stdio.stdout,
    stderr: stdio.stderr,
  })
  assert.equal(code, 0)
  const create = server.requests.find(
    (r) => r.method === 'POST' && r.url === '/v1/sessions',
  )!
  const body = JSON.parse(create.body) as { model?: string }
  assert.equal(body.model, 'claude-opus-4')
})

test('wagent-on: --json emits one envelope per line and skips formatted output', async () => {
  const server = fake!
  server.requests.length = 0
  server.setStream([
    { kind: 'agent_message_chunk', text: 'a' },
    { kind: 'agent_message_chunk', text: 'b' },
    { kind: 'stop' },
  ])
  const stdio = captureStdio()
  const code = await run(['lab', '--json', 'go'], {
    fetch: globalThis.fetch.bind(globalThis),
    loadConfig: () => configFor(server),
    stdin: async () => '',
    stdout: stdio.stdout,
    stderr: stdio.stderr,
  })
  assert.equal(code, 0)
  const lines = stdio.out.trim().split('\n')
  assert.equal(lines.length, 3)
  for (const line of lines) {
    const parsed = JSON.parse(line) as { kind: string }
    assert.ok(typeof parsed.kind === 'string')
  }
  // The formatted final-text path must not have run.
  assert.equal(stdio.out.includes('ab\n') && !stdio.out.includes('"kind"'), false)
})

test('wagent-on: error envelope → non-zero exit + stderr message', async () => {
  const server = fake!
  server.requests.length = 0
  server.setStream([
    {
      kind: 'error',
      category: 'rate_limit',
      message: 'slow down',
    },
    { kind: 'stop' },
  ])
  const stdio = captureStdio()
  const code = await run(['lab', 'go'], {
    fetch: globalThis.fetch.bind(globalThis),
    loadConfig: () => configFor(server),
    stdin: async () => '',
    stdout: stdio.stdout,
    stderr: stdio.stderr,
  })
  assert.notEqual(code, 0)
  assert.match(stdio.err, /rate_limit/)
  assert.match(stdio.err, /slow down/)
})

test('wagent-on: HTTP 5xx on session-create surfaces status + body', async () => {
  const server = fake!
  server.requests.length = 0
  server.setSessionStatus(503, 'overloaded')
  const stdio = captureStdio()
  const code = await run(['lab', 'go'], {
    fetch: globalThis.fetch.bind(globalThis),
    loadConfig: () => configFor(server),
    stdin: async () => '',
    stdout: stdio.stdout,
    stderr: stdio.stderr,
  })
  // Reset for later tests.
  server.setSessionStatus(201)
  assert.notEqual(code, 0)
  assert.match(stdio.err, /503/)
  assert.match(stdio.err, /overloaded/)
})

test('wagent-on: auth_token_env sets Authorization: Bearer header', async () => {
  const server = fake!
  server.requests.length = 0
  process.env.WAGENT_LAB_TOKEN = 'sekrit'
  server.setStream([{ kind: 'stop' }])
  const stdio = captureStdio()
  try {
    const code = await run(['lab', 'go'], {
      fetch: globalThis.fetch.bind(globalThis),
      loadConfig: () => configFor(server, 'auth_token_env = "WAGENT_LAB_TOKEN"'),
      stdin: async () => '',
      stdout: stdio.stdout,
      stderr: stdio.stderr,
    })
    assert.equal(code, 0)
  } finally {
    delete process.env.WAGENT_LAB_TOKEN
  }
  for (const r of server.requests) {
    assert.equal(r.headers['authorization'], 'Bearer sekrit', `${r.method} ${r.url} missing auth`)
  }
})

test('wagent-on: unknown host → exit 1, lists known hosts on stderr', async () => {
  const server = fake!
  const stdio = captureStdio()
  const code = await run(['mystery', 'go'], {
    fetch: globalThis.fetch.bind(globalThis),
    loadConfig: () => configFor(server),
    stdin: async () => '',
    stdout: stdio.stdout,
    stderr: stdio.stderr,
  })
  assert.equal(code, 1)
  assert.match(stdio.err, /no host named `mystery`/)
  assert.match(stdio.err, /known: lab/)
})

test('wagent-on: prompt `-` reads from supplied stdin function', async () => {
  const server = fake!
  server.requests.length = 0
  server.setStream([
    { kind: 'agent_message_chunk', text: 'got it' },
    { kind: 'stop' },
  ])
  const stdio = captureStdio()
  const code = await run(['lab', '-'], {
    fetch: globalThis.fetch.bind(globalThis),
    loadConfig: () => configFor(server),
    stdin: async () => 'piped prompt body',
    stdout: stdio.stdout,
    stderr: stdio.stderr,
  })
  assert.equal(code, 0)
  const msg = server.requests.find((r) => r.url.endsWith('/message'))
  assert.ok(msg)
  const parsed = JSON.parse(msg!.body) as { content: { text: string }[] }
  assert.equal(parsed.content[0]?.text, 'piped prompt body')
})

test('wagent-on: --max-bytes truncates with elision marker', async () => {
  const server = fake!
  server.requests.length = 0
  server.setStream([
    { kind: 'agent_message_chunk', text: 'abcdefghij' },
    { kind: 'stop' },
  ])
  const stdio = captureStdio()
  const code = await run(['lab', '--max-bytes', '4', 'go'], {
    fetch: globalThis.fetch.bind(globalThis),
    loadConfig: () => configFor(server),
    stdin: async () => '',
    stdout: stdio.stdout,
    stderr: stdio.stderr,
  })
  assert.equal(code, 0)
  assert.match(stdio.out, /^abcd\n\[…6 more bytes elided\]\n$/)
})

test('wagent-on: --quiet suppresses stdout', async () => {
  const server = fake!
  server.requests.length = 0
  server.setStream([
    { kind: 'agent_message_chunk', text: 'noise' },
    { kind: 'stop' },
  ])
  const stdio = captureStdio()
  const code = await run(['lab', '--quiet', 'go'], {
    fetch: globalThis.fetch.bind(globalThis),
    loadConfig: () => configFor(server),
    stdin: async () => '',
    stdout: stdio.stdout,
    stderr: stdio.stderr,
  })
  assert.equal(code, 0)
  assert.equal(stdio.out, '')
})
