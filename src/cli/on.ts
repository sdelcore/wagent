#!/usr/bin/env node
// `wagent-on` — run a wagent prompt on a registered remote host. Ported
// from aria-core's Rust binary so the tool ships with wagent and any
// consumer (not just ARIA) can use it.
//
// Reads `${XDG_CONFIG_HOME:-$HOME/.config}/wagent/hosts.toml` for the
// host registry, opens a session against the named host's wagent
// endpoint, posts the prompt, and streams the response back to stdout.
//
// Default mode prints only the final assistant message text — keeps
// the calling worker's context clean. `--verbose` also prints tool
// calls and thinking events to stderr for debugging.

import {
  ArgsError,
  DEFAULT_MAX_BYTES,
  parseArgs,
  helpText,
  type ParsedArgs,
} from './on-args.js'
import {
  loadHostsConfig,
  resolveHost,
  knownHosts,
  type ResolvedHost,
  type HostsConfig,
} from './on-config.js'

interface SessionCreateBody {
  agent: 'claude'
  cwd: string
  model?: string
  options?: { resume: string }
}

interface SessionCreateResp {
  id: string
}

interface RunDeps {
  fetch: typeof fetch
  loadConfig: () => HostsConfig
  stdin: () => Promise<string>
  stdout: { write: (s: string) => void }
  stderr: { write: (s: string) => void }
}

export async function run(argv: string[], deps: RunDeps): Promise<number> {
  let args: ParsedArgs
  try {
    args = parseArgs(argv)
  } catch (err) {
    if (err instanceof ArgsError) {
      deps.stderr.write(`${err.message}\n`)
      return 2
    }
    throw err
  }

  const prompt = args.prompt === '-' ? await deps.stdin() : args.prompt

  let config: HostsConfig
  try {
    config = deps.loadConfig()
  } catch (err) {
    deps.stderr.write(`wagent-on: ${(err as Error).message}\n`)
    return 1
  }

  const host = resolveHost(config, args.host, args.cwd)
  if (!host) {
    const known = knownHosts(config)
    const list = known.length > 0 ? known.join(', ') : '(none configured)'
    deps.stderr.write(`wagent-on: no host named \`${args.host}\` (known: ${list})\n`)
    return 1
  }
  if (!host.cwd) {
    deps.stderr.write(`wagent-on: no --cwd given and host \`${args.host}\` has no default_cwd\n`)
    return 1
  }

  // host.cwd is checked above; narrow it for `dispatch`.
  const resolved: ResolvedHost & { cwd: string } = { ...host, cwd: host.cwd }
  try {
    return await dispatch(args, prompt, resolved, deps)
  } catch (err) {
    deps.stderr.write(`wagent-on: ${(err as Error).message}\n`)
    return 1
  }
}

async function dispatch(
  args: ParsedArgs,
  prompt: string,
  host: ResolvedHost & { cwd: string },
  deps: RunDeps,
): Promise<number> {
  const sessionBody: SessionCreateBody = {
    agent: 'claude',
    cwd: host.cwd,
  }
  if (args.model) sessionBody.model = args.model
  if (args.resume) sessionBody.options = { resume: args.resume }

  const sessionUrl = `${host.url}/v1/sessions`
  const sessionResp = await deps.fetch(sessionUrl, {
    method: 'POST',
    headers: authHeaders(host.authToken, { 'content-type': 'application/json' }),
    body: JSON.stringify(sessionBody),
  })
  if (!sessionResp.ok) {
    const body = await safeText(sessionResp)
    throw new Error(`session create failed (${sessionResp.status}): ${body}`)
  }
  const sessionJson = (await sessionResp.json()) as SessionCreateResp
  const sessionId = sessionJson.id

  const msgUrl = `${host.url}/v1/sessions/${sessionId}/message`
  const msgResp = await deps.fetch(msgUrl, {
    method: 'POST',
    headers: authHeaders(host.authToken, { 'content-type': 'application/json' }),
    body: JSON.stringify({ content: [{ type: 'text', text: prompt }] }),
  })
  if (!msgResp.ok) {
    const body = await safeText(msgResp)
    throw new Error(`message post failed (${msgResp.status}): ${body}`)
  }

  // SSE stream. Bare `/events` is a polling snapshot, not SSE — we
  // want `/events/stream` for the live feed.
  const eventsUrl = `${host.url}/v1/sessions/${sessionId}/events/stream`
  const eventsResp = await deps.fetch(eventsUrl, {
    method: 'GET',
    headers: authHeaders(host.authToken, {
      accept: 'text/event-stream',
      'last-event-id': '0',
    }),
  })
  if (!eventsResp.ok) {
    const body = await safeText(eventsResp)
    throw new Error(`events stream failed (${eventsResp.status}): ${body}`)
  }
  if (!eventsResp.body) {
    throw new Error('events stream had no body')
  }

  return await consumeStream(eventsResp.body, args, deps)
}

async function consumeStream(
  body: ReadableStream<Uint8Array>,
  args: ParsedArgs,
  deps: RunDeps,
): Promise<number> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buf = ''
  let finalText = ''
  let stopped = false
  let exit = 0
  let errorMessage: string | undefined

  outer: while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    while (true) {
      const idx = buf.indexOf('\n\n')
      if (idx === -1) break
      const rawEvent = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const data = parseSseData(rawEvent)
      if (data === null) continue

      let envelope: Record<string, unknown>
      try {
        envelope = JSON.parse(data) as Record<string, unknown>
      } catch {
        continue
      }

      if (args.json) {
        deps.stdout.write(`${data}\n`)
      }

      const kind = typeof envelope.kind === 'string' ? envelope.kind : ''
      const payloadRaw = envelope.payload
      const payload =
        payloadRaw && typeof payloadRaw === 'object'
          ? (payloadRaw as Record<string, unknown>)
          : envelope

      switch (kind) {
        case 'agent_message_chunk': {
          const text = typeof payload.text === 'string' ? payload.text : ''
          finalText += text
          if (args.verbose && text.length > 0) {
            deps.stderr.write(text)
          }
          break
        }
        case 'tool_call':
        case 'tool_started': {
          if (args.verbose) {
            const name = typeof payload.name === 'string' ? payload.name : '?'
            deps.stderr.write(`[tool] ${name}\n`)
          }
          break
        }
        case 'thinking':
        case 'agent_thought_chunk': {
          if (args.verbose) {
            const text = typeof payload.text === 'string' ? payload.text : ''
            deps.stderr.write(`[thinking] ${text}\n`)
          }
          break
        }
        case 'error': {
          const category =
            typeof payload.category === 'string' ? payload.category : 'internal'
          const message =
            typeof payload.message === 'string' ? payload.message : '(no message)'
          errorMessage = `wagent error [${category}]: ${message}`
          exit = 1
          stopped = true
          break outer
        }
        case 'subprocess_died': {
          errorMessage = 'wagent: harness subprocess died'
          exit = 1
          stopped = true
          break outer
        }
        case 'stop': {
          stopped = true
          break outer
        }
      }
    }
  }

  if (errorMessage) {
    deps.stderr.write(`${errorMessage}\n`)
    return exit
  }
  if (!stopped) {
    deps.stderr.write('wagent-on: stream closed before stop event\n')
    return 1
  }
  if (args.quiet || args.json) return 0

  // verbose has been streaming chunks to stderr; add a clean separator
  // before the final-text block lands on stdout.
  if (args.verbose) deps.stderr.write('\n')

  let out = finalText
  if (out.length > args.maxBytes) {
    const head = out.slice(0, args.maxBytes)
    const elided = out.length - args.maxBytes
    out = `${head}\n[…${elided} more bytes elided]`
  }
  deps.stdout.write(out)
  if (!out.endsWith('\n')) deps.stdout.write('\n')
  return 0
}

function authHeaders(
  token: string | undefined,
  base: Record<string, string>,
): Record<string, string> {
  if (!token) return base
  return { ...base, authorization: `Bearer ${token}` }
}

async function safeText(resp: Response): Promise<string> {
  try {
    return (await resp.text()).slice(0, 4096)
  } catch {
    return '<no body>'
  }
}

// SSE event has zero or more `field: value` lines. We only need the
// `data:` line — `event:` and `id:` are unused by this client.
function parseSseData(rawEvent: string): string | null {
  let data: string | null = null
  for (const line of rawEvent.split('\n')) {
    if (line.startsWith('data:')) {
      data = line.slice('data:'.length).replace(/^\s/, '')
    }
  }
  return data
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

// Suppress noise from the entry point so `--help` / config-not-found
// don't spit stack traces. Real bugs still go through.
async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${helpText()}\n`)
    process.exit(0)
  }
  const code = await run(argv, {
    fetch: globalThis.fetch.bind(globalThis),
    loadConfig: () => loadHostsConfig(),
    stdin: readStdin,
    stdout: { write: (s) => process.stdout.write(s) },
    stderr: { write: (s) => process.stderr.write(s) },
  })
  process.exit(code)
}

// Re-export defaults consumers might want when embedding the runner
// programmatically (e.g. tests).
export { DEFAULT_MAX_BYTES, parseArgs, helpText }
export { loadHostsConfig, resolveHost, knownHosts }

// Only run the CLI when this module is the program entry. Lets the
// integration test import `run` without firing main().
const isMain = (() => {
  if (!process.argv[1]) return false
  try {
    const entry = new URL(`file://${process.argv[1]}`).href
    return import.meta.url === entry
  } catch {
    return false
  }
})()
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`wagent-on: ${(err as Error).stack ?? err}\n`)
    process.exit(1)
  })
}
