import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface DbHandle {
  raw: Database.Database
  close: () => void
}

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  cwd TEXT NOT NULL,
  alias TEXT,
  model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  destroyed_at INTEGER,
  parent_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  parent_tool_call_id TEXT,
  delegation_depth INTEGER NOT NULL DEFAULT 0,
  delegation_mode TEXT,
  options_json TEXT
);
CREATE INDEX IF NOT EXISTS sessions_by_parent ON sessions (parent_session_id);

CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  event_index INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, event_index)
);
CREATE INDEX IF NOT EXISTS events_by_session_time ON events (session_id, created_at);

CREATE TABLE IF NOT EXISTS projects (
  directory TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Tracks children spawned on a *remote* wagent via
-- delegate({ host: ... }). The remote owns the actual session and
-- event log; this table is just enough to let delegate_status /
-- delegate_cancel re-target the remote later. We deliberately do not
-- persist URLs or auth tokens — host_name is re-resolved against
-- ~/.config/wagent/hosts.toml on every call so token rotations and
-- registry edits take effect immediately.
CREATE TABLE IF NOT EXISTS remote_children (
  child_session_id  TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  host_name         TEXT NOT NULL,
  harness           TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS remote_children_by_parent ON remote_children (parent_session_id);
`

export function openDatabase(path: string): DbHandle {
  mkdirSync(dirname(path), { recursive: true })
  const raw = new Database(path)
  raw.pragma('journal_mode = WAL')
  raw.pragma('foreign_keys = ON')
  raw.exec(SCHEMA_V1)
  const v = raw.prepare('SELECT version FROM schema_version').get() as
    | { version: number }
    | undefined
  if (!v) {
    raw.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1)
  }
  // Idempotent column additions for databases created before delegation
  // landed. SQLite has no "ADD COLUMN IF NOT EXISTS" so we swallow the
  // duplicate-column error.
  for (const stmt of [
    `ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE`,
    `ALTER TABLE sessions ADD COLUMN parent_tool_call_id TEXT`,
    `ALTER TABLE sessions ADD COLUMN delegation_depth INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE sessions ADD COLUMN delegation_mode TEXT`,
    `ALTER TABLE sessions ADD COLUMN options_json TEXT`,
  ]) {
    try {
      raw.exec(stmt)
    } catch (err) {
      const msg = (err as Error).message
      if (!/duplicate column name/i.test(msg)) throw err
    }
  }
  raw.exec(`CREATE INDEX IF NOT EXISTS sessions_by_parent ON sessions (parent_session_id)`)
  return {
    raw,
    close: () => raw.close(),
  }
}
