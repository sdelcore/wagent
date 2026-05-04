import type { FastifyInstance } from 'fastify'
import { probeAll } from '../agent/availability.js'

export function registerAgentRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { include?: string } }>('/v1/agents', async (req) => {
    const includeModels = parseInclude(req.query?.include).has('models')
    return { agents: await probeAll({ includeModels }) }
  })
}

function parseInclude(value: string | undefined): Set<string> {
  if (!value) return new Set()
  return new Set(
    value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
}
