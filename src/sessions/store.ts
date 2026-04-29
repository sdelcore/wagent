import { randomUUID } from 'node:crypto'
import type { DbHandle } from '../db.js'
import type { AgentKind, DelegationMode, Session, SessionOptions } from '../types.js'

interface SessionRow {
  id: string
  agent: string
  cwd: string
  alias: string | null
  model: string | null
  created_at: number
  updated_at: number
  destroyed_at: number | null
  parent_session_id: string | null
  parent_tool_call_id: string | null
  delegation_depth: number
  delegation_mode: string | null
  options_json: string | null
}

function parseOptions(json: string | null): SessionOptions | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as SessionOptions
    return parsed
  } catch {
    // Corrupt row — better to drop the options than fail the read.
    return null
  }
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
    parentSessionId: row.parent_session_id,
    parentToolCallId: row.parent_tool_call_id,
    delegationDepth: row.delegation_depth,
    delegationMode: row.delegation_mode as DelegationMode | null,
    options: parseOptions(row.options_json),
  }
}

export interface CreateSessionInput {
  agent: AgentKind
  cwd: string
  alias?: string | null
  model?: string | null
  parentSessionId?: string | null
  parentToolCallId?: string | null
  delegationDepth?: number
  delegationMode?: DelegationMode | null
  options?: SessionOptions | null
}

export class SessionStore {
  constructor(private readonly db: DbHandle) {}

  create(input: CreateSessionInput): Session {
    const id = randomUUID()
    const now = Date.now()
    const optionsJson = input.options ? JSON.stringify(input.options) : null
    this.db.raw
      .prepare(
        `INSERT INTO sessions (
           id, agent, cwd, alias, model, created_at, updated_at,
           parent_session_id, parent_tool_call_id, delegation_depth, delegation_mode,
           options_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.agent,
        input.cwd,
        input.alias ?? null,
        input.model ?? null,
        now,
        now,
        input.parentSessionId ?? null,
        input.parentToolCallId ?? null,
        input.delegationDepth ?? 0,
        input.delegationMode ?? null,
        optionsJson,
      )
    return {
      id,
      agent: input.agent,
      cwd: input.cwd,
      alias: input.alias ?? null,
      model: input.model ?? null,
      createdAt: now,
      updatedAt: now,
      destroyedAt: null,
      parentSessionId: input.parentSessionId ?? null,
      parentToolCallId: input.parentToolCallId ?? null,
      delegationDepth: input.delegationDepth ?? 0,
      delegationMode: input.delegationMode ?? null,
      options: input.options ?? null,
    }
  }

  get(id: string): Session | null {
    const row = this.db.raw
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as SessionRow | undefined
    return row ? rowToSession(row) : null
  }

  list(opts: { includeDestroyed?: boolean; parentSessionId?: string } = {}): Session[] {
    const where: string[] = []
    const args: unknown[] = []
    if (!opts.includeDestroyed) where.push('destroyed_at IS NULL')
    if (opts.parentSessionId !== undefined) {
      where.push('parent_session_id = ?')
      args.push(opts.parentSessionId)
    }
    const sql = `SELECT * FROM sessions${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`
    const rows = this.db.raw.prepare(sql).all(...args) as SessionRow[]
    return rows.map(rowToSession)
  }

  // Walk the parent->child tree breadth-first. Returns descendants only
  // (not the root). Order: parents before children, useful for top-down
  // operations; reverse for bottom-up (e.g. close subprocesses before
  // their parent).
  listDescendants(rootId: string): Session[] {
    const out: Session[] = []
    const queue = [rootId]
    const stmt = this.db.raw.prepare(
      'SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY created_at ASC',
    )
    while (queue.length > 0) {
      const id = queue.shift()!
      const children = stmt.all(id) as SessionRow[]
      for (const row of children) {
        out.push(rowToSession(row))
        queue.push(row.id)
      }
    }
    return out
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

  // Hard delete — FK on events cascades, FK on parent_session_id cascades to children.
  delete(id: string): boolean {
    const result = this.db.raw.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    return result.changes > 0
  }
}
