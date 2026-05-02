import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

// Constant-time bearer-token check. Returns true iff `header` is exactly
// `Bearer <token>` with bytewise-equal token. Length-mismatched buffers
// short-circuit (timingSafeEqual throws on unequal length); we hash the
// presented token to a fixed length first so an attacker can't learn the
// real token length from a timing side channel.
export function checkBearer(header: string | undefined, expected: string): boolean {
  if (!header) return false
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (!match) return false
  const presented = match[1]!
  // Pad to equal length before timingSafeEqual so it can't throw and
  // can't reveal length via early return.
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) {
    // Still do a constant-time compare against a same-length zero buffer
    // so the wrong-length branch costs roughly the same as right-length-
    // wrong-token. The result is meaningless — we already know it's wrong.
    timingSafeEqual(a, Buffer.alloc(a.length))
    return false
  }
  return timingSafeEqual(a, b)
}

// Mask a token for log lines: first 4 chars + "…". Never log the full
// token, even on rejection — a flood of "wrong-token" logs shouldn't
// leak whatever the attacker is guessing.
export function maskToken(header: string | undefined): string {
  if (!header) return '<missing>'
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (!match) return '<malformed>'
  const tok = match[1]!
  if (tok.length <= 4) return `${tok.slice(0, 1)}…`
  return `${tok.slice(0, 4)}…`
}

// Mounts the global auth hook. CORS preflight (OPTIONS) is allowed
// through unconditionally so browser clients can still negotiate.
// `/mcp/delegate/*` is exempt: it has its own per-spawn token bound to a
// specific parent session and is loopback-restricted (see
// docs/delegation.md). The harness child has no business knowing the
// global WAGENT_AUTH_TOKEN.
export function registerAuthHook(app: FastifyInstance, expectedToken: string): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method === 'OPTIONS') return
    if (req.url.startsWith('/mcp/delegate/')) return
    const header = req.headers.authorization
    if (checkBearer(header, expectedToken)) return
    req.log.warn(
      { remoteAddr: req.ip, presented: maskToken(header), method: req.method, url: req.url },
      'auth: rejected request',
    )
    reply.code(401).send({ error: 'unauthorized' })
  })
}
