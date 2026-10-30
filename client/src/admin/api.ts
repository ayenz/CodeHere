// Thin client for the server's /api/admin endpoints (cookie auth, same origin).

export type DbDriver = 'sqlite' | 'mysql' | 'postgres'

export interface Stats {
  totalRooms: number
  activeRooms: number
  connections: number
  uptimeSeconds: number
  memoryRssBytes: number
  dbDriver: DbDriver | string
  roomTtlDays: number
  maxDocChars: number
}

export interface RoomSummary {
  id: string
  viewId: string | null
  createdAt: number
  updatedAt: number
  sizeBytes: number
  online: number
  locked: boolean
}

export interface RoomDetail extends RoomSummary {
  language: string | null
  text: string
}

export interface RoomPage {
  total: number
  rooms: RoomSummary[]
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message = `Request failed (${status})`,
  ) {
    super(message)
  }
}

const BASE = '/api/admin'

async function request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  // The custom header is the server's CSRF check; it is harmless on reads too.
  const headers: Record<string, string> = { 'X-Requested-With': 'codehere', Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  let response: Response
  try {
    response = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    })
  } catch (error) {
    if (isAbort(error)) throw error
    throw new ApiError(0, 'Could not reach the server')
  }
  if (!response.ok) throw new ApiError(response.status)
  return response
}

async function getJson(path: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await request('GET', path, undefined, signal)
  // A dev server without a backend may answer with index.html; never treat that as data.
  try {
    const data: unknown = await response.json()
    if (data && typeof data === 'object') return data as Record<string, unknown>
  } catch (error) {
    if (isAbort(error)) throw error
  }
  throw new ApiError(response.status, 'Unexpected response from the server')
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)

function toRoom(raw: unknown): RoomSummary {
  const room = (raw ?? {}) as Record<string, unknown>
  return {
    id: String(room.id ?? ''),
    viewId: str(room.viewId),
    createdAt: num(room.createdAt),
    updatedAt: num(room.updatedAt),
    sizeBytes: num(room.sizeBytes),
    online: num(room.online),
    locked: room.locked === true,
  }
}

export async function login(password: string): Promise<void> {
  await request('POST', '/login', { password })
}

export async function logout(): Promise<void> {
  await request('POST', '/logout')
}

/** Resolves true when signed in, false on 401; throws on 404 (admin disabled) and other errors. */
export async function checkSession(): Promise<boolean> {
  try {
    const data = await getJson('/session')
    return data.authenticated === true
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return false
    throw error
  }
}

export async function getStats(signal?: AbortSignal): Promise<Stats> {
  const data = await getJson('/stats', signal)
  return {
    totalRooms: num(data.totalRooms),
    activeRooms: num(data.activeRooms),
    connections: num(data.connections),
    uptimeSeconds: num(data.uptimeSeconds),
    memoryRssBytes: num(data.memoryRssBytes),
    dbDriver: str(data.dbDriver) ?? 'unknown',
    roomTtlDays: num(data.roomTtlDays),
    maxDocChars: num(data.maxDocChars),
  }
}

export async function listRooms(query: string, offset: number, limit: number, signal?: AbortSignal): Promise<RoomPage> {
  const params = new URLSearchParams({ q: query, offset: String(offset), limit: String(limit) })
  const data = await getJson(`/rooms?${params}`, signal)
  return {
    total: num(data.total),
    rooms: Array.isArray(data.rooms) ? data.rooms.map(toRoom) : [],
  }
}

export async function getRoom(id: string): Promise<RoomDetail> {
  const data = await getJson(`/rooms/${encodeURIComponent(id)}`)
  return { ...toRoom(data), language: str(data.language), text: str(data.text) ?? '' }
}

export async function setLocked(id: string, locked: boolean): Promise<void> {
  await request('POST', `/rooms/${encodeURIComponent(id)}/lock`, { locked })
}

export async function deleteRoom(id: string): Promise<void> {
  await request('DELETE', `/rooms/${encodeURIComponent(id)}`)
}
