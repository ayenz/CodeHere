import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Kysely, MysqlDialect, PostgresDialect, SqliteDialect, sql, type Dialect } from 'kysely'
import { Migrator, type Migration } from 'kysely/migration'
import type { Config, DbDriver } from './config.js'

interface RoomTable {
  id: string
  doc: Uint8Array
  // Epoch milliseconds. Stored as BIGINT so every driver agrees on the format.
  created_at: number
  updated_at: number
  /** Public ID of the read-only link. */
  view_id: string | null
  /** 0 or 1; an integer rather than a boolean so all three databases agree. */
  locked: number
  /** SHA-256 (hex) of the creator's secret token, which lets them delete the room. */
  owner_hash: string | null
}

interface Database {
  rooms: RoomTable
}

export interface StoredRoom {
  doc: Uint8Array
  viewId: string | null
  locked: boolean
  ownerHash: string | null
}

export interface RoomSummary {
  id: string
  viewId: string | null
  createdAt: number
  updatedAt: number
  sizeBytes: number
  locked: boolean
}

export interface RoomStore {
  load(id: string): Promise<StoredRoom | null>
  findIdByViewId(viewId: string): Promise<string | null>
  save(id: string, room: StoredRoom): Promise<void>
  setLocked(id: string, locked: boolean): Promise<boolean>
  delete(id: string): Promise<boolean>
  summary(id: string): Promise<RoomSummary | null>
  list(options: { prefix: string; offset: number; limit: number }): Promise<{ total: number; rooms: RoomSummary[] }>
  count(): Promise<number>
  deleteOlderThan(cutoff: number, keep: Iterable<string>): Promise<number>
  close(): Promise<void>
}

async function createDialect(config: Config): Promise<Dialect> {
  switch (config.dbDriver) {
    case 'sqlite': {
      const { default: SQLite } = await import('better-sqlite3')
      const path = config.sqlitePath === ':memory:' ? ':memory:' : resolve(config.sqlitePath)
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
      const database = new SQLite(path)
      database.pragma('journal_mode = WAL')
      return new SqliteDialect({ database })
    }
    case 'mysql': {
      const { createPool } = await import('mysql2')
      return new MysqlDialect({ pool: createPool({ uri: config.databaseUrl, connectionLimit: 10 }) })
    }
    case 'postgres': {
      const { default: pg } = await import('pg')
      return new PostgresDialect({ pool: new pg.Pool({ connectionString: config.databaseUrl, max: 10 }) })
    }
  }
}

function migrations(driver: DbDriver): Record<string, Migration> {
  const blob = driver === 'postgres' ? sql`bytea` : driver === 'mysql' ? sql`longblob` : sql`blob`
  // Room IDs are case-sensitive; MySQL's default collation is not.
  const roomId = driver === 'mysql' ? sql`varchar(32) collate utf8mb4_bin` : sql`varchar(32)`
  return {
    '0001_rooms': {
      async up(db: Kysely<any>) {
        await db.schema
          .createTable('rooms')
          .addColumn('id', roomId, (col) => col.primaryKey())
          .addColumn('doc', blob, (col) => col.notNull())
          .addColumn('created_at', 'bigint', (col) => col.notNull())
          .addColumn('updated_at', 'bigint', (col) => col.notNull())
          .execute()
        await db.schema.createIndex('rooms_updated_at_idx').on('rooms').column('updated_at').execute()
      },
      async down(db: Kysely<any>) {
        await db.schema.dropTable('rooms').execute()
      },
    },
    '0002_view_links_and_locks': {
      async up(db: Kysely<any>) {
        await db.schema.alterTable('rooms').addColumn('view_id', roomId).execute()
        await db.schema
          .alterTable('rooms')
          .addColumn('locked', 'integer', (col) => col.notNull().defaultTo(0))
          .execute()
        await db.schema.createIndex('rooms_view_id_idx').unique().on('rooms').column('view_id').execute()
      },
      async down(db: Kysely<any>) {
        await db.schema.dropIndex('rooms_view_id_idx').on('rooms').execute()
        await db.schema.alterTable('rooms').dropColumn('locked').execute()
        await db.schema.alterTable('rooms').dropColumn('view_id').execute()
      },
    },
    '0003_room_owners': {
      async up(db: Kysely<any>) {
        await db.schema.alterTable('rooms').addColumn('owner_hash', 'varchar(64)').execute()
      },
      async down(db: Kysely<any>) {
        await db.schema.alterTable('rooms').dropColumn('owner_hash').execute()
      },
    },
  }
}

interface SummaryRow {
  id: string
  view_id: string | null
  created_at: number | string
  updated_at: number | string
  locked: number | string
  size: number | string
}

// Postgres returns BIGINT and COUNT as strings, so normalise every numeric column.
function toSummary(row: SummaryRow): RoomSummary {
  return {
    id: row.id,
    viewId: row.view_id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    sizeBytes: Number(row.size),
    locked: Number(row.locked) === 1,
  }
}

export async function openRoomStore(config: Config): Promise<RoomStore> {
  const db = new Kysely<Database>({ dialect: await createDialect(config) })

  const migrator = new Migrator({
    db,
    provider: { getMigrations: async () => migrations(config.dbDriver) },
  })
  const { error, results } = await migrator.migrateToLatest()
  for (const result of results ?? []) {
    if (result.status === 'Success') console.log(`[db] applied migration ${result.migrationName}`)
  }
  if (error) throw error

  return {
    async load(id) {
      const row = await db
        .selectFrom('rooms')
        .select(['doc', 'view_id', 'locked', 'owner_hash'])
        .where('id', '=', id)
        .executeTakeFirst()
      if (!row) return null
      return {
        doc: new Uint8Array(row.doc),
        viewId: row.view_id,
        locked: Number(row.locked) === 1,
        ownerHash: row.owner_hash,
      }
    },

    async findIdByViewId(viewId) {
      const row = await db.selectFrom('rooms').select('id').where('view_id', '=', viewId).executeTakeFirst()
      return row?.id ?? null
    },

    async save(id, room) {
      const now = Date.now()
      const values = {
        doc: Buffer.from(room.doc),
        view_id: room.viewId,
        locked: room.locked ? 1 : 0,
        owner_hash: room.ownerHash,
        updated_at: now,
      }
      const existing = await db.selectFrom('rooms').select('id').where('id', '=', id).executeTakeFirst()
      if (existing) {
        await db.updateTable('rooms').set(values).where('id', '=', id).execute()
      } else {
        await db.insertInto('rooms').values({ id, created_at: now, ...values }).execute()
      }
    },

    async setLocked(id, locked) {
      const result = await db
        .updateTable('rooms')
        .set({ locked: locked ? 1 : 0 })
        .where('id', '=', id)
        .executeTakeFirst()
      return Number(result.numUpdatedRows) > 0
    },

    async delete(id) {
      const result = await db.deleteFrom('rooms').where('id', '=', id).executeTakeFirst()
      return Number(result.numDeletedRows) > 0
    },

    async summary(id) {
      const row = await db
        .selectFrom('rooms')
        .select(['id', 'view_id', 'created_at', 'updated_at', 'locked', sql<number | string>`length(doc)`.as('size')])
        .where('id', '=', id)
        .executeTakeFirst()
      return row ? toSummary(row) : null
    },

    async list({ prefix, offset, limit }) {
      // '|' escapes LIKE wildcards; '_' is a legal room ID character.
      const pattern = `${prefix.replace(/[|%_]/g, (char) => `|${char}`)}%`
      const matching = sql<boolean>`${sql.ref('id')} like ${pattern} escape '|'`
      const [{ total }] = await db
        .selectFrom('rooms')
        .select((eb) => eb.fn.countAll<number | string>().as('total'))
        .where(matching)
        .execute()
      const rows = await db
        .selectFrom('rooms')
        .select(['id', 'view_id', 'created_at', 'updated_at', 'locked', sql<number | string>`length(doc)`.as('size')])
        .where(matching)
        .orderBy('updated_at', 'desc')
        .offset(offset)
        .limit(limit)
        .execute()
      return {
        total: Number(total),
        rooms: rows.map(toSummary),
      }
    },

    async count() {
      const [{ total }] = await db
        .selectFrom('rooms')
        .select((eb) => eb.fn.countAll<number | string>().as('total'))
        .execute()
      return Number(total)
    },

    async deleteOlderThan(cutoff, keep) {
      const keepIds = [...keep]
      let query = db.deleteFrom('rooms').where('updated_at', '<', cutoff)
      if (keepIds.length > 0) query = query.where('id', 'not in', keepIds)
      const result = await query.executeTakeFirst()
      return Number(result.numDeletedRows)
    },

    close: () => db.destroy(),
  }
}
