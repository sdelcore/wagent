import type { FastifyInstance, FastifyReply } from 'fastify'
import type { ProjectStore } from '../projects/store.js'
import type { ApiError } from '../types.js'

function bad(reply: FastifyReply, status: number, code: string, message: string): ApiError {
  reply.code(status)
  return { error: { code, message } }
}

function validateDirectory(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (trimmed.startsWith('~')) return null
  if (!trimmed.startsWith('/')) return null
  return trimmed
}

export interface ProjectsDeps {
  projectStore: ProjectStore
}

export function registerProjectRoutes(app: FastifyInstance, deps: ProjectsDeps) {
  app.get('/v1/projects', async () => {
    return { projects: deps.projectStore.list() }
  })

  // POST upserts by directory; idempotent — re-POSTing bumps updated_at.
  app.post<{
    Body: { directory?: unknown; name?: unknown }
  }>('/v1/projects', async (req, reply) => {
    const directory = validateDirectory(req.body?.directory)
    if (!directory) {
      return bad(
        reply,
        400,
        'invalid_directory',
        'directory must be an absolute path (no ~, no relative)',
      )
    }
    const rawName = req.body?.name
    const name =
      typeof rawName === 'string' && rawName.trim().length > 0
        ? rawName.trim()
        : (directory.replace(/\/+$/, '').split('/').pop() || directory)
    return deps.projectStore.upsert(directory, name)
  })

  app.delete<{ Querystring: { directory?: string } }>('/v1/projects', async (req, reply) => {
    const directory = validateDirectory(req.query.directory)
    if (!directory) {
      return bad(reply, 400, 'invalid_directory', 'directory query param is required and must be absolute')
    }
    const ok = deps.projectStore.delete(directory)
    if (!ok) return bad(reply, 404, 'not_found', `project ${directory} not found`)
    reply.code(204).send()
  })
}
