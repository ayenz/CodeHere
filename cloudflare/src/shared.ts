import type { Registry } from './registry'
import type { Room } from './room'

export interface Env {
  ROOMS: DurableObjectNamespace<Room>
  REGISTRY: DurableObjectNamespace<Registry>
  ASSETS: Fetcher
  /** Editor Worker only; optional so the admin Worker and tests can run without it. */
  CONNECT_LIMITER?: RateLimit
  MAX_DOC_CHARS?: string
  MAX_MESSAGE_BYTES?: string
  MAX_CONNECTIONS_PER_ROOM?: string
  MAX_NEW_ROOMS_PER_HOUR?: string
  ROOM_TTL_DAYS?: string
  // Admin Worker only.
  ADMIN_PASSWORD?: string
  /** Random key for signing admin sessions (wrangler secret put SESSION_SECRET). */
  SESSION_SECRET?: string
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
  return pathname.startsWith('/assets/') || pathname === '/favicon.svg' || pathname === '/theme.js'
}

export function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? 'local'
}

export function json(body: unknown, status = 200): Response {
  return withSecurityHeaders(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    }),
  )
}

/**
 * Same policy as server/src/app.ts. CodeMirror injects <style> elements and remote cursors use
 * inline styles, so styles need 'unsafe-inline'; scripts are strictly same-origin.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

export function withSecurityHeaders(response: Response): Response {
  // WebSocket upgrades must be returned untouched.
  if (response.status === 101) return response
  const secured = new Response(response.body, response)
  secured.headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  secured.headers.set('X-Content-Type-Options', 'nosniff')
  secured.headers.set('X-Frame-Options', 'DENY')
  secured.headers.set('Referrer-Policy', 'same-origin')
  secured.headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  secured.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  secured.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  return secured
}

export function roomStub(env: Env, id: string): DurableObjectStub<Room> {
  return env.ROOMS.get(env.ROOMS.idFromName(id))
}

export function registry(env: Env): DurableObjectStub<Registry> {
  return env.REGISTRY.get(env.REGISTRY.idFromName('registry'))
}
