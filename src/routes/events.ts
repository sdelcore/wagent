import type { FastifyInstance, FastifyReply } from 'fastify'
import type { EventStore } from '../events/store.js'
import type { SessionStore } from '../sessions/store.js'
import type { SessionBus } from '../bus.js'
import type { ApiError, EventEnvelope } from '../types.js'

const KEEP_ALIVE_MS = 15_000

function bad(reply: FastifyReply, status: number, code: string, message: string): ApiError {
  reply.code(status)
  return { error: { code, message } }
}

export interface EventsDeps {
  sessionStore: SessionStore
  eventStore: EventStore
  bus: SessionBus
}

export function registerEventRoutes(app: FastifyInstance, deps: EventsDeps) {
  // Paged JSON list — used for backfill.
  app.get<{
    Params: { id: string }
    Querystring: { after?: string; limit?: string }
  }>('/v1/sessions/:id/events', async (req, reply) => {
    if (!deps.sessionStore.get(req.params.id)) {
      return bad(reply, 404, 'not_found', `session ${req.params.id} not found`)
    }
    const after = req.query.after !== undefined ? Number.parseInt(req.query.after, 10) : undefined
    const limit = req.query.limit !== undefined ? Number.parseInt(req.query.limit, 10) : undefined
    const events = deps.eventStore.list(req.params.id, {
      afterIndex: after !== undefined && Number.isFinite(after) ? after : undefined,
      limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
    })
    return { events }
  })

  // SSE stream — replays from `Last-Event-ID` (or 0) then subscribes live.
  app.get<{ Params: { id: string } }>(
    '/v1/sessions/:id/events/stream',
    async (req, reply) => {
      const sessionId = req.params.id
      if (!deps.sessionStore.get(sessionId)) {
        return bad(reply, 404, 'not_found', `session ${sessionId} not found`)
      }

      const lastEventIdHeader = req.headers['last-event-id']
      const lastEventId = typeof lastEventIdHeader === 'string'
        ? Number.parseInt(lastEventIdHeader, 10)
        : NaN
      const startAfter = Number.isFinite(lastEventId) ? lastEventId : 0

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })

      const write = (event: EventEnvelope) => {
        reply.raw.write(`event: session_update\n`)
        reply.raw.write(`id: ${event.eventIndex}\n`)
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
      }

      // Replay any events the client missed before subscribing live.
      let highestSent = startAfter
      const backfill = deps.eventStore.list(sessionId, { afterIndex: startAfter, limit: 2000 })
      for (const event of backfill) {
        write(event)
        if (event.eventIndex > highestSent) highestSent = event.eventIndex
      }

      // Subscribe — but de-dupe events <= highestSent in case adapter
      // appended while we were replaying.
      const unsubscribe = deps.bus.subscribe(sessionId, (event) => {
        if (event.eventIndex <= highestSent) return
        write(event)
        if (event.eventIndex > highestSent) highestSent = event.eventIndex
      })

      // Keep-alive pings so mobile proxies / nginx don't kill an idle
      // connection. SSE comments are ignored by the EventSource API.
      const keepAlive = setInterval(() => {
        reply.raw.write(`: keep-alive ${Date.now()}\n\n`)
      }, KEEP_ALIVE_MS)

      const cleanup = () => {
        clearInterval(keepAlive)
        unsubscribe()
      }
      req.raw.on('close', cleanup)
      reply.raw.on('close', cleanup)
    },
  )
}
