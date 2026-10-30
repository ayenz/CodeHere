import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Config } from './config.js'
import type { RoomStore } from './db.js'
import { WindowCounter } from './limits.js'
import { isRoomId, type RoomManager } from './rooms.js'

const COOKIE = 'codehere_admin'
const SESSION_MS = 12 * 60 * 60 * 1000
const MAX_BODY_BYTES = 16 * 1024
const PAGE_LIMIT_MAX = 100

export interface AdminContext {
  config: Config
  rooms: RoomManager
  store: RoomStore
  startedAt: number
  clientIp(req: IncomingMessage): string
}

function json(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status, { 'cache-control': 'no-store' }).end()
    return
  }
  res
    .writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    .end(JSON.stringify(body))
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('Body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return null
}

/** Handles /api/admin/*. Returns false for paths it does not own. */
export function createAdminHandler(ctx: AdminContext) {
  const sessions = new Map<string, number>()
  const loginAttempts = new WindowCounter(5, 60 * 1000)
  const passwordDigest = digest(ctx.config.adminPassword)

  function isSecure(req: IncomingMessage): boolean {
    if ('encrypted' in req.socket && req.socket.encrypted) return true
    return ctx.config.trustProxy && req.headers['x-forwarded-proto'] === 'https'
  }

  function authenticated(req: IncomingMessage): boolean {
    const token = cookieValue(req, COOKIE)
    if (!token) return false
    const expires = sessions.get(token)
    if (!expires || expires < Date.now()) {
      sessions.delete(token)
      return false
    }
    return true
  }

  function setCookie(req: IncomingMessage, res: ServerResponse, token: string, maxAgeSeconds: number): void {
    const secure = isSecure(req) ? '; Secure' : ''
    res.setHeader(
      'set-cookie',
      `${COOKIE}=${token}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`,
    )
  }

  return async function handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    if (!pathname.startsWith('/api/admin/')) return false
    if (!ctx.config.adminPassword) {
      json(res, 404, { error: 'Admin is disabled' })
      return true
    }

    const method = req.method ?? 'GET'
    // Cookies are SameSite=Strict; this header additionally blocks cross-site form posts.
    if (method !== 'GET' && req.headers['x-requested-with'] !== 'codehere') {
      json(res, 403, { error: 'Missing X-Requested-With header' })
      return true
    }

    const route = pathname.slice('/api/admin'.length)

    if (route === '/login' && method === 'POST') {
      if (!loginAttempts.hit(ctx.clientIp(req))) {
        json(res, 429, { error: 'Too many attempts' })
        return true
      }
      const body = (await readJson(req).catch(() => null)) as { password?: unknown } | null
      const password = typeof body?.password === 'string' ? body.password : ''
      if (!timingSafeEqual(digest(password), passwordDigest)) {
        json(res, 401, { error: 'Wrong password' })
        return true
      }
      const token = randomBytes(32).toString('base64url')
      sessions.set(token, Date.now() + SESSION_MS)
      setCookie(req, res, token, SESSION_MS / 1000)
      json(res, 204)
      return true
    }

    if (route === '/logout' && method === 'POST') {
      const token = cookieValue(req, COOKIE)
      if (token) sessions.delete(token)
      setCookie(req, res, '', 0)
      json(res, 204)
      return true
    }

    if (!authenticated(req)) {
      json(res, 401, { error: 'Not signed in' })
      return true
    }

    if (route === '/session' && method === 'GET') {
      json(res, 200, { authenticated: true })
      return true
    }

    if (route === '/stats' && method === 'GET') {
      const { activeRooms, connections } = ctx.rooms.stats()
      json(res, 200, {
        totalRooms: await ctx.store.count(),
        activeRooms,
        connections,
        uptimeSeconds: Math.round((Date.now() - ctx.startedAt) / 1000),
        memoryRssBytes: process.memoryUsage().rss,
        dbDriver: ctx.config.dbDriver,
        roomTtlDays: ctx.config.roomTtlDays,
        maxDocChars: ctx.config.limits.maxDocChars,
      })
      return true
    }

    if (route === '/rooms' && method === 'GET') {
      const params = new URL(req.url ?? '', 'http://localhost').searchParams
      const prefix = (params.get('q') ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)
      const offset = Math.max(0, Number.parseInt(params.get('offset') ?? '0', 10) || 0)
      const limit = Math.min(PAGE_LIMIT_MAX, Math.max(1, Number.parseInt(params.get('limit') ?? '25', 10) || 25))
      const page = await ctx.store.list({ prefix, offset, limit })
      const rooms = await Promise.all(
        page.rooms.map(async (room) => ({ ...room, online: await ctx.rooms.online(room.id) })),
      )
      json(res, 200, { total: page.total, rooms })
      return true
    }

    const match = /^\/rooms\/([^/]+)(\/lock)?$/.exec(route)
    const id = match ? decodeURIComponent(match[1]) : ''
    if (!match || !isRoomId(id)) {
      json(res, 404, { error: 'Not found' })
      return true
    }

    if (!match[2] && method === 'GET') {
      const detail = await ctx.rooms.detail(id)
      if (!detail) {
        json(res, 404, { error: 'Room not found' })
        return true
      }
      const summary = await ctx.store.summary(id)
      json(res, 200, {
        ...detail,
        createdAt: summary?.createdAt ?? null,
        updatedAt: summary?.updatedAt ?? null,
        sizeBytes: summary?.sizeBytes ?? 0,
      })
      return true
    }

    if (match[2] && method === 'POST') {
      const body = (await readJson(req).catch(() => null)) as { locked?: unknown } | null
      if (typeof body?.locked !== 'boolean') {
        json(res, 400, { error: 'Expected {"locked": boolean}' })
        return true
      }
      json(res, (await ctx.rooms.setLocked(id, body.locked)) ? 204 : 404)
      return true
    }

    if (!match[2] && method === 'DELETE') {
      json(res, (await ctx.rooms.delete(id)) ? 204 : 404)
      return true
    }

    json(res, 405, { error: 'Method not allowed' })
    return true
  }
}
