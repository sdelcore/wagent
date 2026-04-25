import type { FastifyInstance, FastifyReply } from 'fastify'
import type { SessionStore } from '../sessions/store.js'
import type { AgentSupervisor } from '../agent/supervisor.js'
import type { ApiError, ContentBlock, PermissionOutcome } from '../types.js'

const VALID_OUTCOMES: PermissionOutcome[] = ['allow_always', 'allow_once', 'reject']

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
  // POST /v1/sessions/:id/message — submit a user prompt to the session.
  // Singular "message" matches OpenCode's REST shape; ACP says `session/prompt`.
  app.post<{
    Params: { id: string }
    Body: { content?: unknown }
  }>('/v1/sessions/:id/message', async (req, reply) => {
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

    // Fire and forget — events stream over SSE. HTTP returns 202 once
    // the prompt has been queued/sent to the agent.
    process.prompt(content).catch((err) => {
      app.log.error({ err, sessionId: req.params.id }, 'prompt failed')
    })

    reply.code(202)
    return { status: 'accepted', sessionId: req.params.id }
  })

  // POST /v1/sessions/:id/abort — stop the in-flight prompt turn.
  // "abort" is the industry verb (Anthropic SDK, OpenAI, OpenCode all
  // use it); ACP uses `session/cancel`.
  app.post<{ Params: { id: string } }>('/v1/sessions/:id/abort', async (req, reply) => {
    const session = deps.sessionStore.get(req.params.id)
    if (!session) return bad(reply, 404, 'not_found', `session ${req.params.id} not found`)
    const proc = deps.supervisor.get(req.params.id)
    if (!proc) {
      // Idempotent: aborting a session with no live process is a no-op.
      return { status: 'noop', sessionId: req.params.id }
    }
    try {
      await proc.cancel()
    } catch (err) {
      app.log.warn({ err, sessionId: req.params.id }, 'abort failed')
    }
    return { status: 'aborted', sessionId: req.params.id }
  })

  // POST /v1/sessions/:id/permissions/:requestId — respond to a pending
  // permission request. requestId is in the path (matches OpenCode +
  // ACP) so it's loggable, retryable, and routable. Body uses ACP
  // outcome vocabulary: 'allow_always' | 'allow_once' | 'reject'.
  app.post<{
    Params: { id: string; requestId: string }
    Body: { outcome?: unknown }
  }>('/v1/sessions/:id/permissions/:requestId', async (req, replyWriter) => {
    const session = deps.sessionStore.get(req.params.id)
    if (!session) return bad(replyWriter, 404, 'not_found', `session ${req.params.id} not found`)
    const outcome = req.body?.outcome
    if (typeof outcome !== 'string' || !VALID_OUTCOMES.includes(outcome as PermissionOutcome)) {
      return bad(
        replyWriter,
        400,
        'invalid_outcome',
        `outcome must be one of ${VALID_OUTCOMES.join(', ')}`,
      )
    }
    const proc = deps.supervisor.get(req.params.id)
    if (!proc) {
      // Already-resolved or never-running session — idempotent ok.
      return { status: 'noop', sessionId: req.params.id }
    }
    try {
      await proc.respondPermission(req.params.requestId, outcome as PermissionOutcome)
    } catch (err) {
      // Permission already consumed / unknown id — idempotent. Don't 500.
      app.log.warn(
        { err, sessionId: req.params.id, requestId: req.params.requestId },
        'respondPermission failed (treating as noop)',
      )
      return { status: 'noop', sessionId: req.params.id }
    }
    return { status: 'accepted', sessionId: req.params.id }
  })
}
