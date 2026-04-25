import type { FastifyInstance, FastifyReply } from 'fastify'
import type { SessionStore } from '../sessions/store.js'
import type { SessionBus } from '../bus.js'
import type { AgentSupervisor } from '../agent/supervisor.js'
import { probeAgent } from '../agent/availability.js'
import type { AgentKind, ApiError } from '../types.js'

const VALID_AGENTS: AgentKind[] = ['claude', 'pi', 'echo']

function bad(reply: FastifyReply, status: number, code: string, message: string): ApiError {
  reply.code(status)
  return { error: { code, message } }
}

function validateCwd(cwd: unknown): string | null {
  if (typeof cwd !== 'string') return null
  const trimmed = cwd.trim()
  if (trimmed.length === 0) return null
  if (trimmed.startsWith('~')) return null
  if (!trimmed.startsWith('/')) return null
  return trimmed
}

export interface SessionsDeps {
  sessionStore: SessionStore
  bus: SessionBus
  supervisor: AgentSupervisor
}

export function registerSessionRoutes(app: FastifyInstance, deps: SessionsDeps) {
  const store = deps.sessionStore
  app.get('/v1/sessions', async (req) => {
    const includeDestroyed = (req.query as { destroyed?: string })?.destroyed === 'true'
    return { sessions: store.list({ includeDestroyed }) }
  })

  app.post<{
    Body: { agent?: string; cwd?: string; alias?: string | null; model?: string | null }
  }>('/v1/sessions', async (req, reply) => {
    const body = req.body ?? {}
    const agent = body.agent
    if (typeof agent !== 'string' || !VALID_AGENTS.includes(agent as AgentKind)) {
      return bad(reply, 400, 'invalid_agent', `agent must be one of ${VALID_AGENTS.join(', ')}`)
    }
    // Precheck: refuse early if the agent isn't available on this host
    // so the caller gets a meaningful error code instead of a 500 at
    // subprocess spawn time.
    const availability = await probeAgent(agent as AgentKind)
    if (!availability.installed) {
      return bad(
        reply,
        409,
        'agent_not_available',
        availability.notes ?? `agent ${agent} is not available on this host`,
      )
    }
    const cwd = validateCwd(body.cwd)
    if (!cwd) {
      return bad(
        reply,
        400,
        'invalid_cwd',
        'cwd must be an absolute path (no ~ expansion, no relative paths)',
      )
    }
    const session = store.create({
      agent: agent as AgentKind,
      cwd,
      alias: typeof body.alias === 'string' ? body.alias : null,
      model: typeof body.model === 'string' ? body.model : null,
    })
    reply.code(201)
    return session
  })

  app.get<{ Params: { id: string } }>('/v1/sessions/:id', async (req, reply) => {
    const session = store.get(req.params.id)
    if (!session) return bad(reply, 404, 'not_found', `session ${req.params.id} not found`)
    return session
  })

  app.patch<{
    Params: { id: string }
    Body: { alias?: string | null; model?: string | null }
  }>('/v1/sessions/:id', async (req, reply) => {
    const body = req.body ?? {}
    const updated = store.update(req.params.id, {
      alias: body.alias === undefined ? undefined : body.alias,
      model: body.model === undefined ? undefined : body.model,
    })
    if (!updated) return bad(reply, 404, 'not_found', `session ${req.params.id} not found`)
    return updated
  })

  app.delete<{ Params: { id: string } }>('/v1/sessions/:id', async (req, reply) => {
    const id = req.params.id
    if (!store.get(id)) return bad(reply, 404, 'not_found', `session ${id} not found`)
    // Close the running subprocess first so it can't append events
    // after the session row is gone (FK would reject anyway, but the
    // close is the right semantic).
    await deps.supervisor.closeOne(id)
    store.delete(id)
    deps.bus.drop(id)
    reply.code(204).send()
  })
}
