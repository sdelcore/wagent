import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyBaseLogger } from 'fastify'
import cors from '@fastify/cors'
import { loadConfig } from './config.js'
import { registerAuthHook } from './auth.js'
import { openDatabase } from './db.js'
import { SessionStore } from './sessions/store.js'
import { EventStore } from './events/store.js'
import { ProjectStore } from './projects/store.js'
import { SessionBus } from './bus.js'
import { AgentSupervisor } from './agent/supervisor.js'
import { DelegateTokenStore } from './agent/delegate_tokens.js'
import { echoFactory } from './agent/echo.js'
import { claudeSdkFactory } from './agent/claude_sdk.js'
import { piSdkFactory } from './agent/pi_sdk.js'
import { registerSessionRoutes } from './routes/sessions.js'
import { registerEventRoutes } from './routes/events.js'
import { registerPromptRoutes } from './routes/prompts.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerAgentRoutes } from './routes/agents.js'
import { registerFsRoutes } from './routes/fs.js'
import { registerDelegateMcpRoutes } from './routes/delegate_mcp.js'
import { probeAll } from './agent/availability.js'
import type { Session, SessionUpdate } from './types.js'

const PKG_PATH = fileURLToPath(new URL('../package.json', import.meta.url))
const PKG = JSON.parse(readFileSync(PKG_PATH, 'utf8')) as { version: string }
const VERSION = PKG.version

async function main() {
  const config = loadConfig()
  const db = openDatabase(config.dbPath)

  const app = Fastify({ logger: { level: config.logLevel } })

  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type'],
  })

  if (config.token) {
    registerAuthHook(app, config.token)
    app.log.info('auth: enabled (token configured via WAGENT_AUTH_TOKEN)')
  } else {
    app.log.info('auth: disabled (loopback-only deployment assumed)')
  }

  // Shallow by default: just confirms Fastify is accepting requests.
  // ?deep=1 runs a one-shot echo round-trip — spawns an EchoAgent (no DB
  // row, no persisted events, no bus traffic) and waits for its `stop`
  // event. Useful as a `systemd` `After=` gate for downstream services
  // that want the agent supervisor + factory wiring to be reachable,
  // not just the socket. Sub-second under normal conditions; budget
  // capped at 2s.
  app.get<{ Querystring: { deep?: string } }>('/v1/health', async (req, reply) => {
    if (req.query?.deep !== '1') return { status: 'ok' }
    const result = await runDeepProbe(app.log)
    if (!result.ok) {
      reply.code(503)
      return {
        status: 'fail',
        deep: { stage: result.stage, error: result.error, durationMs: result.durationMs },
      }
    }
    return { status: 'ok', deep: { agent: 'echo', durationMs: result.durationMs } }
  })

  app.get('/v1/meta', async () => {
    const agents = await probeAll()
    return {
      name: 'wagent',
      version: VERSION,
      hostname: config.hostname,
      home: config.home,
      capabilities: {
        // Live probe — only includes agents that are actually installed.
        // Use GET /v1/agents to see all candidates and why missing ones aren't.
        agents: agents.filter((a) => a.installed).map((a) => a.id),
        auth: config.token ? 'bearer' : 'none',
      },
    }
  })

  const sessionStore = new SessionStore(db)
  const eventStore = new EventStore(db)
  const projectStore = new ProjectStore(db)
  const bus = new SessionBus()
  const delegateTokens = new DelegateTokenStore()

  // Loopback URL the daemon advertises to harness children for the
  // delegate-MCP endpoint. Always 127.0.0.1 — the public bind host
  // (0.0.0.0 by default) is irrelevant for in-host MCP traffic.
  const delegateBaseUrl = `http://127.0.0.1:${config.port}`

  const supervisor = new AgentSupervisor({
    sessionStore,
    eventStore,
    bus,
    log: app.log,
    factories: {
      echo: echoFactory,
      claude: claudeSdkFactory,
      pi: piSdkFactory,
    },
    delegateTokens,
    delegateBaseUrl,
  })

  registerSessionRoutes(app, { sessionStore, eventStore, bus, supervisor })
  registerEventRoutes(app, { sessionStore, eventStore, bus })
  registerPromptRoutes(app, { sessionStore, supervisor })
  registerProjectRoutes(app, { projectStore })
  registerAgentRoutes(app)
  registerFsRoutes(app)
  registerDelegateMcpRoutes(app, {
    sessionStore,
    eventStore,
    bus,
    supervisor,
    delegateTokens,
  })

  const shutdown = async () => {
    try {
      await supervisor.closeAll()
    } catch (err) {
      app.log.warn({ err }, 'agent supervisor closeAll failed')
    }
    try {
      await app.close()
    } finally {
      db.close()
    }
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  await app.listen({ host: config.host, port: config.port })
  app.log.info(
    {
      port: config.port,
      dbPath: config.dbPath,
      cors: config.corsOrigins === true ? '*' : config.corsOrigins,
      tokenProtected: !!config.token,
      hostname: config.hostname,
      version: VERSION,
    },
    'wagent ready',
  )
}

type DeepProbeResult =
  | { ok: true; durationMs: number }
  | { ok: false; stage: 'spawn' | 'prompt' | 'timeout'; error: string; durationMs: number }

const DEEP_PROBE_TIMEOUT_MS = 2_000

// One-shot echo round-trip. Spawns an EchoAgent in isolation (no DB row,
// no event persistence, no bus), sends a trivial prompt, waits for the
// `stop` event. Verifies the supervisor's factory wiring is reachable
// end-to-end without polluting any persistent state.
async function runDeepProbe(log: FastifyBaseLogger): Promise<DeepProbeResult> {
  const start = Date.now()
  const fakeSession: Session = {
    id: `health-${randomUUID()}`,
    agent: 'echo',
    cwd: '/',
    alias: null,
    model: null,
    createdAt: start,
    updatedAt: start,
    destroyedAt: null,
    parentSessionId: null,
    parentToolCallId: null,
    delegationDepth: 0,
    delegationMode: null,
    options: null,
  }

  let stopResolve: (() => void) | null = null
  let stopReject: ((reason: Error) => void) | null = null
  const stopped = new Promise<void>((resolve, reject) => {
    stopResolve = resolve
    stopReject = reject
  })

  const onUpdate = (update: SessionUpdate) => {
    if (update.kind === 'stop') stopResolve?.()
    if (update.kind === 'subprocess_died') {
      stopReject?.(new Error(`subprocess_died: ${String(update.reason ?? 'unknown')}`))
    }
  }

  let proc: Awaited<ReturnType<typeof echoFactory.spawn>> | null = null
  try {
    proc = await echoFactory.spawn(fakeSession, {
      log: log.child({ healthDeep: true }),
      emit: onUpdate,
      markDead: (reason) => stopReject?.(new Error(`markDead: ${reason}`)),
    })
  } catch (err) {
    return {
      ok: false,
      stage: 'spawn',
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    }
  }

  let timer: NodeJS.Timeout | null = null
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('deep probe exceeded budget')),
      DEEP_PROBE_TIMEOUT_MS,
    )
  })

  try {
    await proc.prompt([{ type: 'text', text: 'ping' }])
    await Promise.race([stopped, budget])
    return { ok: true, durationMs: Date.now() - start }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const stage: 'timeout' | 'prompt' =
      message === 'deep probe exceeded budget' ? 'timeout' : 'prompt'
    return { ok: false, stage, error: message, durationMs: Date.now() - start }
  } finally {
    if (timer) clearTimeout(timer)
    try {
      await proc.close()
    } catch (err) {
      log.warn({ err }, 'deep probe: echo close failed')
    }
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('wagent failed to start', err)
  process.exit(1)
})
