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
  /** Admin UI and API are disabled when empty. */
  adminPassword: string
  /** Use X-Forwarded-For for client IPs (only behind a trusted reverse proxy). */
  trustProxy: boolean
  limits: Limits
}

/** Every limit is off when set to 0, which is the default. */
export interface Limits {
  /** Maximum characters in one room's document. */
  maxDocChars: number
  /** Maximum size of a single WebSocket message. */
  maxMessageBytes: number
  /** Sustained WebSocket messages per second per connection (bursts up to 4x). */
  maxMessagesPerSecond: number
  /** Simultaneous WebSocket connections per client IP. */
  maxConnectionsPerIp: number
  /** Rooms a client IP may open that do not exist yet, per hour. */
  maxNewRoomsPerHour: number
  /** Rooms held in memory at once. */
  maxActiveRooms: number
}

function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number.parseInt(raw, 10)
  if (Number.isNaN(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

function bool(name: string): boolean {
  return ['1', 'true', 'yes'].includes((process.env[name] ?? '').toLowerCase())
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
    roomTtlDays: int('ROOM_TTL_DAYS', 0),
    persistDebounceMs: int('PERSIST_DEBOUNCE_MS', 2000),
    staticDir: process.env.STATIC_DIR ?? null,
    adminPassword: process.env.ADMIN_PASSWORD ?? '',
    trustProxy: bool('TRUST_PROXY'),
    limits: {
      maxDocChars: int('MAX_DOC_CHARS', 0),
      maxMessageBytes: int('MAX_MESSAGE_BYTES', 0),
      maxMessagesPerSecond: int('MAX_MESSAGES_PER_SECOND', 0),
      maxConnectionsPerIp: int('MAX_CONNECTIONS_PER_IP', 0),
      maxNewRoomsPerHour: int('MAX_NEW_ROOMS_PER_HOUR', 0),
      maxActiveRooms: int('MAX_ACTIVE_ROOMS', 0),
    },
  }
}
