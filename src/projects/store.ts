import type { DbHandle } from '../db.js'

export interface Project {
  directory: string
  name: string
  createdAt: number
  updatedAt: number
}

interface ProjectRow {
  directory: string
  name: string
  created_at: number
  updated_at: number
}

function rowToProject(row: ProjectRow): Project {
  return {
    directory: row.directory,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class ProjectStore {
  constructor(private readonly db: DbHandle) {}

  list(): Project[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM projects ORDER BY updated_at DESC')
      .all() as ProjectRow[]
    return rows.map(rowToProject)
  }

  get(directory: string): Project | null {
    const row = this.db.raw
      .prepare('SELECT * FROM projects WHERE directory = ?')
      .get(directory) as ProjectRow | undefined
    return row ? rowToProject(row) : null
  }

  upsert(directory: string, name: string): Project {
    const now = Date.now()
    const existing = this.get(directory)
    if (existing) {
      this.db.raw
        .prepare('UPDATE projects SET name = ?, updated_at = ? WHERE directory = ?')
        .run(name, now, directory)
      return { ...existing, name, updatedAt: now }
    }
    this.db.raw
      .prepare(
        `INSERT INTO projects (directory, name, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(directory, name, now, now)
    return { directory, name, createdAt: now, updatedAt: now }
  }

  delete(directory: string): boolean {
    const r = this.db.raw
      .prepare('DELETE FROM projects WHERE directory = ?')
      .run(directory)
    return r.changes > 0
  }
}
