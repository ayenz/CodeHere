import type { Registry } from './registry'
import type { Room } from './room'

export interface Env {
  ROOMS: DurableObjectNamespace<Room>
  REGISTRY: DurableObjectNamespace<Registry>
  ASSETS: Fetcher
  MAX_DOC_CHARS?: string
  MAX_MESSAGE_BYTES?: string
  MAX_CONNECTIONS_PER_ROOM?: string
  MAX_NEW_ROOMS_PER_HOUR?: string
  ROOM_TTL_DAYS?: string
  // Admin Worker only.
  ADMIN_PASSWORD?: string
  PUBLIC_URL?: string
}

const ID_PATTERN = /^[A-Za-z0-9_-]{4,32}$/
// Mirrors server/src/rooms.ts. The admin page lives on its own host, so "admin" is a normal room.
const RESERVED_IDS = new Set(['api', 'assets', 'healthz', 'v', 'ws'])

export function isRoomId(id: string): boolean {
  return ID_PATTERN.test(id) && !RESERVED_IDS.has(id.toLowerCase())
}

export function isViewId(id: string): boolean {
  return ID_PATTERN.test(id)
}

/** Non-negative integer from a Worker variable; 0 means "no limit". */
export function intVar(value: string | undefined, fallback = 0): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function randomId(bytes = 9): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Built files served as-is; every other path is a page. */
export function isStaticAsset(pathname: string): boolean {
  return pathname.startsWith('/assets/') || pathname === '/favicon.svg'
}

export function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? 'local'
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

export function roomStub(env: Env, id: string): DurableObjectStub<Room> {
  return env.ROOMS.get(env.ROOMS.idFromName(id))
}

export function registry(env: Env): DurableObjectStub<Registry> {
  return env.REGISTRY.get(env.REGISTRY.idFromName('registry'))
}
