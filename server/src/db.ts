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
}

interface Database {
  rooms: RoomTable
}

async function createDialect(config: Config): Promise<Dialect> {
  switch (config.dbDriver) {
    case 'sqlite': {
      const { default: SQLite } = await import('better-sqlite3')
      const path = resolve(config.sqlitePath)
      mkdirSync(dirname(path), { recursive: true })
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
  }
}

export interface RoomStore {
  load(id: string): Promise<Uint8Array | null>
  save(id: string, doc: Uint8Array): Promise<void>
  deleteOlderThan(cutoff: number, keep: Iterable<string>): Promise<number>
  close(): Promise<void>
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
      const row = await db.selectFrom('rooms').select('doc').where('id', '=', id).executeTakeFirst()
      return row ? new Uint8Array(row.doc) : null
    },

    async save(id, doc) {
      const now = Date.now()
      const data = Buffer.from(doc)
      const existing = await db.selectFrom('rooms').select('id').where('id', '=', id).executeTakeFirst()
      if (existing) {
        await db.updateTable('rooms').set({ doc: data, updated_at: now }).where('id', '=', id).execute()
      } else {
        await db.insertInto('rooms').values({ id, doc: data, created_at: now, updated_at: now }).execute()
      }
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
