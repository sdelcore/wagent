import type { FastifyInstance } from 'fastify'
import { probeAll } from '../agent/availability.js'

export function registerAgentRoutes(app: FastifyInstance) {
  app.get('/v1/agents', async () => ({ agents: await probeAll() }))
}
