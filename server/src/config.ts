export type DbDriver = 'sqlite' | 'mysql' | 'postgres'

export interface Config {
  port: number
  host: string
  dbDriver: DbDriver
  sqlitePath: string
  databaseUrl: string
  roomTtlDays: number
  persistDebounceMs: number
  staticDir: string | null
}

function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number.parseInt(raw, 10)
  if (Number.isNaN(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

function driver(): DbDriver {
  const raw = (process.env.DB_DRIVER ?? 'sqlite').toLowerCase()
  if (raw === 'postgresql' || raw === 'pg') return 'postgres'
  if (raw === 'sqlite' || raw === 'mysql' || raw === 'postgres') return raw
  throw new Error(`Unsupported DB_DRIVER "${raw}" (use sqlite, mysql or postgres)`)
}

export function loadConfig(): Config {
  const dbDriver = driver()
  const databaseUrl = process.env.DATABASE_URL ?? ''
  if (dbDriver !== 'sqlite' && !databaseUrl) {
    throw new Error(`DATABASE_URL is required when DB_DRIVER=${dbDriver}`)
  }
  return {
    port: int('PORT', 3000),
    host: process.env.HOST ?? '0.0.0.0',
    dbDriver,
    sqlitePath: process.env.SQLITE_PATH ?? './data/codehere.db',
    databaseUrl,
    roomTtlDays: int('ROOM_TTL_DAYS', 30),
    persistDebounceMs: int('PERSIST_DEBOUNCE_MS', 2000),
    staticDir: process.env.STATIC_DIR ?? null,
  }
}
