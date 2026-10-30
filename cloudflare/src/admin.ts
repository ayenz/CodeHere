// The admin Worker: the same admin page and API as server/src/admin.ts, on its own host.
// Sessions are signed cookies because Workers keep no memory between requests.
import { safeDecode } from './protocol'
import { clientIp, intVar, isRoomId, isStaticAsset, json, registry, roomStub, withSecurityHeaders, type Env } from './shared'

const COOKIE = 'codehere_admin'
const SESSION_MS = 12 * 60 * 60 * 1000
const PAGE_LIMIT_MAX = 100

const encoder = new TextEncoder()

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Sessions are signed with a separate random secret rather than anything derived from the
 * password, so a leaked cookie can't be used to guess the password offline.
 */
async function hmacKey(sessionSecret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(sessionSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

async function sign(key: CryptoKey, value: string): Promise<string> {
  return base64url(await crypto.subtle.sign('HMAC', key, encoder.encode(value)))
}

function equal(a: string, b: string): boolean {
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right)
}

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return null
}

function sessionCookie(value: string, maxAgeSeconds: number): string {
  return `${COOKIE}=${value}; Path=/api/admin; HttpOnly; SameSite=Strict; Secure; Max-Age=${maxAgeSeconds}`
}

async function authenticated(request: Request, key: CryptoKey): Promise<boolean> {
  const [expires, signature] = (cookieValue(request, COOKIE) ?? '').split('.')
  if (!expires || !signature || Number(expires) < Date.now()) return false
  return equal(signature, await sign(key, expires))
}

async function handleApi(request: Request, env: Env, route: string): Promise<Response> {
  const password = env.ADMIN_PASSWORD ?? ''
  const sessionSecret = env.SESSION_SECRET ?? ''
  // Both secrets are required; a short session secret would be guessable.
  if (!password || sessionSecret.length < 32) return json({ error: 'Admin is disabled' }, 404)
  const method = request.method
  // Cookies are SameSite=Strict; this header additionally blocks cross-site form posts.
  if (method !== 'GET' && request.headers.get('x-requested-with') !== 'codehere') {
    return json({ error: 'Missing X-Requested-With header' }, 403)
  }
  const key = await hmacKey(sessionSecret)

  if (route === '/login' && method === 'POST') {
    const limits = registry(env)
    // Per IP, plus a ceiling across all IPs for attackers who rotate addresses.
    const allowed = (await limits.hit('login:all', 30, 60 * 1000)) && (await limits.hit(`login:${clientIp(request)}`, 5, 60 * 1000))
    if (!allowed) return json({ error: 'Too many attempts' }, 429)
    const body = (await request.json().catch(() => null)) as { password?: unknown } | null
    const given = typeof body?.password === 'string' ? body.password : ''
    // Compare signatures rather than the raw strings so the comparison is fixed-length.
    if (!equal(await sign(key, `pw:${given}`), await sign(key, `pw:${password}`))) return json({ error: 'Wrong password' }, 401)
    const expires = String(Date.now() + SESSION_MS)
    return new Response(null, {
      status: 204,
      headers: { 'set-cookie': sessionCookie(`${expires}.${await sign(key, expires)}`, SESSION_MS / 1000) },
    })
  }

  if (route === '/logout' && method === 'POST') {
    return new Response(null, { status: 204, headers: { 'set-cookie': sessionCookie('', 0) } })
  }

  if (!(await authenticated(request, key))) return json({ error: 'Not signed in' }, 401)

  if (route === '/session' && method === 'GET') {
    return json({ authenticated: true, editorOrigin: (env.PUBLIC_URL ?? '').replace(/\/+$/, '') })
  }

  if (route === '/stats' && method === 'GET') {
    return json({
      ...(await registry(env).stats()),
      // Not meaningful on Workers: there is no single long-running process.
      uptimeSeconds: null,
      memoryRssBytes: null,
      dbDriver: 'cloudflare',
      roomTtlDays: intVar(env.ROOM_TTL_DAYS),
      maxDocChars: intVar(env.MAX_DOC_CHARS),
    })
  }

  if (route === '/rooms' && method === 'GET') {
    const params = new URL(request.url).searchParams
    const prefix = (params.get('q') ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)
    const offset = Math.max(0, Number.parseInt(params.get('offset') ?? '0', 10) || 0)
    const limit = Math.min(PAGE_LIMIT_MAX, Math.max(1, Number.parseInt(params.get('limit') ?? '25', 10) || 25))
    return json(await registry(env).list(prefix, offset, limit))
  }

  const match = /^\/rooms\/([^/]+)(\/lock)?$/.exec(route)
  const id = match ? (safeDecode(match[1]) ?? '') : ''
  // Only rooms the registry knows about: looking up any other ID would create an empty object.
  if (!match || !isRoomId(id) || !(await registry(env).get(id))) return json({ error: 'Room not found' }, 404)
  const room = roomStub(env, id)

  if (!match[2] && method === 'GET') {
    const detail = await room.detail()
    return detail ? json(detail) : json({ error: 'Room not found' }, 404)
  }
  if (match[2] && method === 'POST') {
    const body = (await request.json().catch(() => null)) as { locked?: unknown } | null
    if (typeof body?.locked !== 'boolean') return json({ error: 'Expected {"locked": boolean}' }, 400)
    return new Response(null, { status: (await room.setLocked(body.locked)) ? 204 : 404 })
  }
  if (!match[2] && method === 'DELETE') {
    const existed = await room.destroy()
    if (!existed) await registry(env).remove(id)
    return new Response(null, { status: existed ? 204 : 404 })
  }
  return json({ error: 'Method not allowed' }, 405)
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/healthz') return new Response('ok')
    if (url.pathname.startsWith('/api/admin/')) return handleApi(request, env, url.pathname.slice('/api/admin'.length))
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return json({ error: 'Not found' }, 404)
    if (isStaticAsset(url.pathname)) return withSecurityHeaders(await env.ASSETS.fetch(request))
    // Every page on this host is the admin page ("/admin" is admin.html in the assets).
    return withSecurityHeaders(await env.ASSETS.fetch(new Request(new URL('/admin', url), request)))
  },
} satisfies ExportedHandler<Env>
