import { randomUUID } from 'node:crypto'
import type { DbHandle } from '../db.js'
import type { AgentKind, Session } from '../types.js'

interface SessionRow {
  id: string
  agent: string
  cwd: string
  alias: string | null
  model: string | null
  created_at: number
  updated_at: number
  destroyed_at: number | null
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    agent: row.agent as AgentKind,
    cwd: row.cwd,
    alias: row.alias,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    destroyedAt: row.destroyed_at,
  }
}

export interface CreateSessionInput {
  agent: AgentKind
  cwd: string
  alias?: string | null
  model?: string | null
}

export class SessionStore {
  constructor(private readonly db: DbHandle) {}

  create(input: CreateSessionInput): Session {
    const id = randomUUID()
    const now = Date.now()
    this.db.raw
      .prepare(
        `INSERT INTO sessions (id, agent, cwd, alias, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.agent, input.cwd, input.alias ?? null, input.model ?? null, now, now)
    return {
      id,
      agent: input.agent,
      cwd: input.cwd,
      alias: input.alias ?? null,
      model: input.model ?? null,
      createdAt: now,
      updatedAt: now,
      destroyedAt: null,
    }
  }

  get(id: string): Session | null {
    const row = this.db.raw
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as SessionRow | undefined
    return row ? rowToSession(row) : null
  }

  list(opts: { includeDestroyed?: boolean } = {}): Session[] {
    const rows = (
      opts.includeDestroyed
        ? this.db.raw.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all()
        : this.db.raw
            .prepare('SELECT * FROM sessions WHERE destroyed_at IS NULL ORDER BY created_at DESC')
            .all()
    ) as SessionRow[]
    return rows.map(rowToSession)
  }

  update(id: string, patch: { alias?: string | null; model?: string | null }): Session | null {
    const existing = this.get(id)
    if (!existing) return null
    const now = Date.now()
    this.db.raw
      .prepare(
        `UPDATE sessions
         SET alias = ?, model = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.alias !== undefined ? patch.alias : existing.alias,
        patch.model !== undefined ? patch.model : existing.model,
        now,
        id,
      )
    return this.get(id)
  }

  // Hard delete — FK on events cascades.
  delete(id: string): boolean {
    const result = this.db.raw.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    return result.changes > 0
  }
}
