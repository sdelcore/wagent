import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { ApiError } from '../types.js'

export interface FsEntry {
  name: string
  path: string
  entryType: 'directory' | 'file' | 'symlink' | 'unknown'
  size?: number
  modified?: string
}

function bad(reply: FastifyReply, status: number, code: string, message: string): ApiError {
  reply.code(status)
  return { error: { code, message } }
}

function isAbsolute(p: string): boolean {
  return typeof p === 'string' && p.startsWith('/') && !p.startsWith('~')
}

export function registerFsRoutes(app: FastifyInstance) {
  // GET /v1/fs/entries?path=/abs/dir — list immediate children of an
  // absolute directory path. Read-only. No tilde expansion (matches the
  // session/cwd validation policy). Used by clients to drive folder
  // pickers without needing to re-implement filesystem access on the
  // client side.
  app.get<{ Querystring: { path?: string } }>('/v1/fs/entries', async (req, reply) => {
    const raw = req.query.path
    if (!raw || !isAbsolute(raw)) {
      return bad(
        reply,
        400,
        'invalid_path',
        'path query parameter must be an absolute path (no ~ expansion)',
      )
    }
    const target = resolve(raw)

    let names: string[]
    try {
      names = await readdir(target)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return bad(reply, 404, 'not_found', `path not found: ${target}`)
      if (code === 'ENOTDIR') return bad(reply, 400, 'not_a_directory', `not a directory: ${target}`)
      if (code === 'EACCES') return bad(reply, 403, 'permission_denied', `permission denied: ${target}`)
      return bad(reply, 500, 'fs_error', String((err as Error).message))
    }

    const entries: FsEntry[] = []
    await Promise.all(
      names.map(async (name) => {
        const full = join(target, name)
        try {
          const s = await stat(full)
          let entryType: FsEntry['entryType'] = 'unknown'
          if (s.isDirectory()) entryType = 'directory'
          else if (s.isFile()) entryType = 'file'
          else if (s.isSymbolicLink()) entryType = 'symlink'
          entries.push({
            name,
            path: full,
            entryType,
            size: entryType === 'file' ? s.size : undefined,
            modified: s.mtime.toISOString(),
          })
        } catch {
          // Permission denied on stat (e.g. /proc/self) — surface as unknown.
          entries.push({ name, path: full, entryType: 'unknown' })
        }
      }),
    )
    return entries
  })
}
