import type { DbHandle } from '../db.js'
import type { EventEnvelope, SessionUpdate, SessionUpdateKind } from '../types.js'

interface EventRow {
  session_id: string
  event_index: number
  kind: string
  payload_json: string
  created_at: number
}

function rowToEvent(row: EventRow): EventEnvelope {
  return {
    sessionId: row.session_id,
    eventIndex: row.event_index,
    kind: row.kind as SessionUpdateKind,
    createdAt: row.created_at,
    payload: JSON.parse(row.payload_json) as SessionUpdate,
  }
}

export class EventStore {
  constructor(private readonly db: DbHandle) {}

  // Allocate the next monotonic event_index for a session and append.
  // Wrapped in an immediate transaction so two concurrent appends can't
  // both see the same MAX().
  append(sessionId: string, update: SessionUpdate): EventEnvelope {
    const tx = this.db.raw.transaction((sId: string, u: SessionUpdate): EventEnvelope => {
      const row = this.db.raw
        .prepare(
          `SELECT COALESCE(MAX(event_index), 0) AS max_idx
           FROM events WHERE session_id = ?`,
        )
        .get(sId) as { max_idx: number }
      const nextIndex = row.max_idx + 1
      const now = Date.now()
      this.db.raw
        .prepare(
          `INSERT INTO events
            (session_id, event_index, kind, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(sId, nextIndex, u.kind, JSON.stringify(u), now)
      return {
        sessionId: sId,
        eventIndex: nextIndex,
        kind: u.kind,
        createdAt: now,
        payload: u,
      }
    })
    return tx(sessionId, update)
  }

  list(
    sessionId: string,
    opts: { afterIndex?: number; limit?: number } = {},
  ): EventEnvelope[] {
    const limit = Math.min(2000, Math.max(1, opts.limit ?? 500))
    const rows =
      opts.afterIndex !== undefined && Number.isFinite(opts.afterIndex)
        ? (this.db.raw
            .prepare(
              `SELECT * FROM events
               WHERE session_id = ? AND event_index > ?
               ORDER BY event_index ASC
               LIMIT ?`,
            )
            .all(sessionId, opts.afterIndex, limit) as EventRow[])
        : (this.db.raw
            .prepare(
              `SELECT * FROM events
               WHERE session_id = ?
               ORDER BY event_index ASC
               LIMIT ?`,
            )
            .all(sessionId, limit) as EventRow[])
    return rows.map(rowToEvent)
  }
}
