import { DurableObject } from 'cloudflare:workers'
import type { Env } from './shared'

export interface RoomSummary {
  id: string
  viewId: string | null
  createdAt: number
  updatedAt: number
  sizeBytes: number
  locked: boolean
  online: number
}

interface RoomRow extends Record<string, SqlStorageValue> {
  id: string
  view_id: string | null
  created_at: number
  updated_at: number
  size: number
  locked: number
  online: number
}

function toSummary(row: RoomRow): RoomSummary {
  return {
    id: row.id,
    viewId: row.view_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sizeBytes: row.size,
    locked: row.locked === 1,
    online: row.online,
  }
}

/**
 * The one place that knows about every room. Durable Objects cannot be listed, so rooms
 * register here; it also maps view-only IDs to rooms and keeps rate-limit counters.
 */
export class Registry extends DurableObject<Env> {
  private readonly sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      view_id TEXT UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      locked INTEGER NOT NULL DEFAULT 0,
      online INTEGER NOT NULL DEFAULT 0
    )`)
    this.sql.exec('CREATE INDEX IF NOT EXISTS rooms_updated_at ON rooms (updated_at)')
    this.sql.exec('CREATE TABLE IF NOT EXISTS hits (key TEXT PRIMARY KEY, reset_at INTEGER NOT NULL, count INTEGER NOT NULL)')
  }

  /** Counts one event for `key` in a fixed window; false once the key is over `limit`. */
  hit(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now()
    // Expired counters are dropped lazily, a few at a time.
    this.sql.exec('DELETE FROM hits WHERE key IN (SELECT key FROM hits WHERE reset_at <= ? LIMIT 20)', now)
    const row = this.sql.exec<{ count: number; reset_at: number }>('SELECT count, reset_at FROM hits WHERE key = ?', key).toArray()[0]
    if (!row || row.reset_at <= now) {
      this.sql.exec('INSERT OR REPLACE INTO hits (key, reset_at, count) VALUES (?, ?, 1)', key, now + windowMs)
      return true
    }
    this.sql.exec('UPDATE hits SET count = count + 1 WHERE key = ?', key)
    return row.count + 1 <= limit
  }

  register(id: string, viewId: string, createdAt: number): void {
    this.sql.exec(
      'INSERT OR IGNORE INTO rooms (id, view_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
      id,
      viewId,
      createdAt,
      createdAt,
    )
  }

  update(id: string, fields: { updatedAt?: number; size?: number; locked?: boolean; online?: number }): void {
    const columns: Array<[string, SqlStorageValue | undefined]> = [
      ['updated_at', fields.updatedAt],
      ['size', fields.size],
      ['locked', fields.locked === undefined ? undefined : fields.locked ? 1 : 0],
      ['online', fields.online],
    ]
    const changed = columns.filter((column): column is [string, SqlStorageValue] => column[1] !== undefined)
    if (changed.length === 0) return
    const sets = changed.map(([column]) => `${column} = ?`).join(', ')
    this.sql.exec(`UPDATE rooms SET ${sets} WHERE id = ?`, ...changed.map(([, value]) => value), id)
  }

  remove(id: string): void {
    this.sql.exec('DELETE FROM rooms WHERE id = ?', id)
  }

  roomIdForView(viewId: string): string | null {
    return this.sql.exec<{ id: string }>('SELECT id FROM rooms WHERE view_id = ?', viewId).toArray()[0]?.id ?? null
  }

  get(id: string): RoomSummary | null {
    const row = this.sql.exec<RoomRow>('SELECT * FROM rooms WHERE id = ?', id).toArray()[0]
    return row ? toSummary(row) : null
  }

  list(prefix: string, offset: number, limit: number): { total: number; rooms: RoomSummary[] } {
    // '|' escapes LIKE wildcards; '_' is a legal room ID character.
    const pattern = `${prefix.replace(/[|%_]/g, (char) => `|${char}`)}%`
    const total = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM rooms WHERE id LIKE ? ESCAPE '|'", pattern).one().n
    const rooms = this.sql
      .exec<RoomRow>("SELECT * FROM rooms WHERE id LIKE ? ESCAPE '|' ORDER BY updated_at DESC LIMIT ? OFFSET ?", pattern, limit, offset)
      .toArray()
      .map(toSummary)
    return { total, rooms }
  }

  stats(): { totalRooms: number; activeRooms: number; connections: number } {
    const row = this.sql
      .exec<{ total: number; active: number; connections: number }>(
        'SELECT COUNT(*) AS total, COALESCE(SUM(online > 0), 0) AS active, COALESCE(SUM(online), 0) AS connections FROM rooms',
      )
      .one()
    return { totalRooms: row.total, activeRooms: row.active, connections: row.connections }
  }
}
