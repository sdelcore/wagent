// Lookup table for child sessions spawned on a remote wagent. The
// remote owns the actual session + event log; we only persist enough
// to re-target it for delegate_status / delegate_cancel after the
// initial delegate() call has returned.
//
// Auth tokens and URLs are NOT stored — host_name is re-resolved
// against ~/.config/wagent/hosts.toml on every call, so a token
// rotation or hosts.toml edit takes effect on the next read with no
// migration step.

import type { DbHandle } from '../db.js'
import type { AgentKind } from '../types.js'

export interface RemoteChild {
  childSessionId: string
  parentSessionId: string
  hostName: string
  harness: AgentKind
  createdAt: number
}

interface Row {
  child_session_id: string
  parent_session_id: string
  host_name: string
  harness: string
  created_at: number
}

function rowToRemoteChild(row: Row): RemoteChild {
  return {
    childSessionId: row.child_session_id,
    parentSessionId: row.parent_session_id,
    hostName: row.host_name,
    harness: row.harness as AgentKind,
    createdAt: row.created_at,
  }
}

export class RemoteChildrenStore {
  constructor(private db: DbHandle) {}

  insert(c: Omit<RemoteChild, 'createdAt'> & { createdAt?: number }): RemoteChild {
    const createdAt = c.createdAt ?? Date.now()
    this.db.raw
      .prepare(
        `INSERT INTO remote_children
         (child_session_id, parent_session_id, host_name, harness, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(c.childSessionId, c.parentSessionId, c.hostName, c.harness, createdAt)
    return { ...c, createdAt }
  }

  get(childSessionId: string): RemoteChild | null {
    const row = this.db.raw
      .prepare(`SELECT * FROM remote_children WHERE child_session_id = ?`)
      .get(childSessionId) as Row | undefined
    return row ? rowToRemoteChild(row) : null
  }

  // Used by delegate_cancel cleanup once the remote has confirmed
  // the abort, and during parent-session destruction sweeps.
  delete(childSessionId: string): void {
    this.db.raw
      .prepare(`DELETE FROM remote_children WHERE child_session_id = ?`)
      .run(childSessionId)
  }

  listByParent(parentSessionId: string): RemoteChild[] {
    const rows = this.db.raw
      .prepare(
        `SELECT * FROM remote_children WHERE parent_session_id = ? ORDER BY created_at`,
      )
      .all(parentSessionId) as Row[]
    return rows.map(rowToRemoteChild)
  }
}
