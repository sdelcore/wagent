import type { FastifyInstance, FastifyReply } from 'fastify'
import type { SessionStore } from '../sessions/store.js'
import type { AgentSupervisor } from '../agent/supervisor.js'
import type { ApiError, ContentBlock, PermissionReply } from '../types.js'

const VALID_REPLIES: PermissionReply[] = ['always', 'once', 'reject']

function bad(reply: FastifyReply, status: number, code: string, message: string): ApiError {
  reply.code(status)
  return { error: { code, message } }
}

function validateContent(raw: unknown): ContentBlock[] | null {
  if (!Array.isArray(raw)) return null
  const out: ContentBlock[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null
    const block = item as Record<string, unknown>
    if (block.type === 'text') {
      if (typeof block.text !== 'string') return null
      out.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      if (typeof block.data !== 'string' || typeof block.mimeType !== 'string') return null
      out.push({ type: 'image', data: block.data, mimeType: block.mimeType })
    } else {
      return null
    }
  }
  return out
}

export interface PromptDeps {
  sessionStore: SessionStore
  supervisor: AgentSupervisor
}

export function registerPromptRoutes(app: FastifyInstance, deps: PromptDeps) {
  app.post<{
    Params: { id: string }
    Body: { content?: unknown }
  }>('/v1/sessions/:id/prompts', async (req, reply) => {
    const session = deps.sessionStore.get(req.params.id)
    if (!session) return bad(reply, 404, 'not_found', `session ${req.params.id} not found`)
    if (session.destroyedAt !== null) {
      return bad(reply, 410, 'session_destroyed', 'session has been destroyed')
    }

    const content = validateContent(req.body?.content)
    if (!content || content.length === 0) {
      return bad(
        reply,
        400,
        'invalid_content',
        'content must be a non-empty array of { type: "text"|"image", ... } blocks',
      )
    }

    let process
    try {
      process = await deps.supervisor.ensure(req.params.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'spawn failed'
      return bad(reply, 500, 'spawn_failed', message)
    }

    // Fire and forget — events stream over SSE. The HTTP response
    // returns 202 once the prompt has been queued/sent to the agent.
    process.prompt(content).catch((err) => {
      app.log.error({ err, sessionId: req.params.id }, 'prompt failed')
    })

    reply.code(202)
    return { status: 'accepted', sessionId: req.params.id }
  })

  app.post<{ Params: { id: string } }>('/v1/sessions/:id/cancel', async (req, reply) => {
    const session = deps.sessionStore.get(req.params.id)
    if (!session) return bad(reply, 404, 'not_found', `session ${req.params.id} not found`)
    const proc = deps.supervisor.get(req.params.id)
    if (!proc) {
      // Idempotent: cancelling a session with no live process is a no-op.
      return { status: 'noop', sessionId: req.params.id }
    }
    try {
      await proc.cancel()
    } catch (err) {
      app.log.warn({ err, sessionId: req.params.id }, 'cancel failed')
    }
    return { status: 'cancelled', sessionId: req.params.id }
  })

  app.post<{
    Params: { id: string }
    Body: { requestId?: unknown; reply?: unknown }
  }>('/v1/sessions/:id/permissions', async (req, replyWriter) => {
    const session = deps.sessionStore.get(req.params.id)
    if (!session) return bad(replyWriter, 404, 'not_found', `session ${req.params.id} not found`)
    const requestId = req.body?.requestId
    const replyValue = req.body?.reply
    if (typeof requestId !== 'string' || requestId.length === 0) {
      return bad(replyWriter, 400, 'invalid_request_id', 'requestId must be a string')
    }
    if (typeof replyValue !== 'string' || !VALID_REPLIES.includes(replyValue as PermissionReply)) {
      return bad(
        replyWriter,
        400,
        'invalid_reply',
        `reply must be one of ${VALID_REPLIES.join(', ')}`,
      )
    }
    const proc = deps.supervisor.get(req.params.id)
    if (!proc) {
      // Already-resolved or never-running session — idempotent ok.
      return { status: 'noop', sessionId: req.params.id }
    }
    try {
      await proc.respondPermission(requestId, replyValue as PermissionReply)
    } catch (err) {
      // Permission already consumed / unknown id — idempotent. Don't 500.
      app.log.warn(
        { err, sessionId: req.params.id, requestId },
        'respondPermission failed (treating as noop)',
      )
      return { status: 'noop', sessionId: req.params.id }
    }
    return { status: 'accepted', sessionId: req.params.id }
  })
}
