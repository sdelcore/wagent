import Fastify from 'fastify'
import cors from '@fastify/cors'
import { loadConfig } from './config.js'
import { openDatabase } from './db.js'
import { SessionStore } from './sessions/store.js'
import { EventStore } from './events/store.js'
import { ProjectStore } from './projects/store.js'
import { SessionBus } from './bus.js'
import { AgentSupervisor } from './agent/supervisor.js'
import { echoFactory } from './agent/echo.js'
import { claudeAcpFactory } from './agent/claude_acp.js'
import { piRpcFactory } from './agent/pi_rpc.js'
import { registerSessionRoutes } from './routes/sessions.js'
import { registerEventRoutes } from './routes/events.js'
import { registerPromptRoutes } from './routes/prompts.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerAgentRoutes } from './routes/agents.js'
import { registerFsRoutes } from './routes/fs.js'
import { probeAll } from './agent/availability.js'

const VERSION = '0.1.0'

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
    app.addHook('onRequest', async (req, reply) => {
      if (req.method === 'OPTIONS') return
      const header = req.headers.authorization ?? ''
      const match = /^Bearer\s+(.+)$/i.exec(header)
      if (!match || match[1] !== config.token) {
        reply.code(401).send({ error: { code: 'unauthorized' } })
      }
    })
  }

  app.get('/v1/health', async () => ({ status: 'ok' }))

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

  const supervisor = new AgentSupervisor({
    sessionStore,
    eventStore,
    bus,
    log: app.log,
    factories: {
      echo: echoFactory,
      claude: claudeAcpFactory,
      pi: piRpcFactory,
    },
  })

  registerSessionRoutes(app, { sessionStore, eventStore, bus, supervisor })
  registerEventRoutes(app, { sessionStore, eventStore, bus })
  registerPromptRoutes(app, { sessionStore, supervisor })
  registerProjectRoutes(app, { projectStore })
  registerAgentRoutes(app)
  registerFsRoutes(app)

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

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('wagent failed to start', err)
  process.exit(1)
})
