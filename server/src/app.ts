import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sirv from 'sirv'
import { WebSocketServer, type WebSocket } from 'ws'
import { createAdminHandler } from './admin.js'
import { hostname, type Config } from './config.js'
import { openRoomStore, type RoomStore } from './db.js'
import { safeDecode } from './protocol.js'
import { isRoomId, RoomManager, type Access } from './rooms.js'

const HEARTBEAT_MS = 30_000
// Used when MAX_MESSAGE_BYTES is 0: ws treats an explicit 0 as "no limit at all", which would
// let one client exhaust memory with a single huge frame. This matches ws's own default.
const DEFAULT_MAX_MESSAGE_BYTES = 100 * 1024 * 1024
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000

export interface App {
  server: Server
  rooms: RoomManager
  store: RoomStore
  /** Saves every open room and closes connections and the database. */
  close(): Promise<void>
}

/** The request URL, or null when it is malformed (e.g. "//", which new URL() rejects). */
function parseUrl(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? '/', 'http://localhost')
  } catch {
    return null
  }
}

/**
 * Sent with every response. CodeMirror injects <style> elements and remote cursors use
 * inline styles, so styles need 'unsafe-inline'; scripts are strictly same-origin.
 */
function setSecurityHeaders(req: IncomingMessage, res: ServerResponse): void {
  const host = req.headers.host ?? ''
  // 'self' covers WebSockets in current browsers; the explicit ws/wss origins help older ones.
  const sockets = /^[A-Za-z0-9.:[\]-]+$/.test(host) ? ` ws://${host} wss://${host}` : ''
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      `connect-src 'self'${sockets}`,
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  )
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
}

/** Built files that are served as-is on both hosts; every other path is a page. */
function isStaticAsset(pathname: string): boolean {
  return pathname.startsWith('/assets/') || pathname === '/favicon.svg' || pathname === '/theme.js'
}

/** Parses /ws/<roomId> (edit) and /ws/v/<viewId> (read-only). */
function parseAccess(pathname: string, searchParams: URLSearchParams): Access | null {
  const view = /^\/ws\/v\/([^/]+)$/.exec(pathname)
  if (view) {
    const viewId = safeDecode(view[1])
    return viewId && /^[A-Za-z0-9_-]{4,32}$/.test(viewId) ? { kind: 'view', viewId } : null
  }
  const edit = /^\/ws\/([^/]+)$/.exec(pathname)
  if (edit) {
    const roomId = safeDecode(edit[1])
    const ownerToken = searchParams.get('owner') ?? undefined
    return roomId && isRoomId(roomId) ? { kind: 'edit', roomId, ownerToken } : null
  }
  return null
}

export async function createApp(config: Config): Promise<App> {
  const startedAt = Date.now()
  const store = await openRoomStore(config)
  const rooms = new RoomManager(store, config.limits, config.persistDebounceMs)

  function clientIp(req: IncomingMessage): string {
    if (config.trustProxy) {
      // The right-most entry is the one our own proxy appended; anything to its left came
      // from the client and can be forged.
      const forwarded = req.headers['x-forwarded-for']
      const last = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded)?.split(',').pop()?.trim()
      if (last) return last
    }
    return req.socket.remoteAddress ?? 'unknown'
  }

  /** True for requests addressed to ADMIN_HOST (e.g. admin.example.com). */
  function isAdminHost(req: IncomingMessage): boolean {
    if (!config.adminHost) return false
    const forwarded = config.trustProxy ? req.headers['x-forwarded-host'] : undefined
    const host = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0] ?? req.headers.host ?? ''
    return hostname(host) === config.adminHost
  }

  const adminEnabled = Boolean(config.adminPassword && config.adminHost)
  const handleAdmin = createAdminHandler({ config, rooms, store, startedAt, clientIp, enabled: adminEnabled })

  /** DELETE /api/rooms/:id with the creator's X-Owner-Token. */
  async function deleteAsOwner(req: IncomingMessage, id: string): Promise<number> {
    const token = req.headers['x-owner-token']
    if (req.headers['x-requested-with'] !== 'codehere' || typeof token !== 'string' || !token) return 403
    if (!isRoomId(id)) return 404
    const owner = await rooms.isOwner(id, token)
    if (owner === null) return 404
    if (!owner) return 403
    await rooms.delete(id)
    return 204
  }

  // Serve the built client when it exists (production). In development Vite serves it.
  const here = dirname(fileURLToPath(import.meta.url))
  const staticDir = resolve(config.staticDir ?? resolve(here, '../../client/dist'))
  const serveStatic = existsSync(staticDir)
    ? sirv(staticDir, {
        single: true,
        etag: true,
        gzip: true,
        brotli: true,
        setHeaders(res, pathname) {
          // Hashed assets never change; the HTML must be revalidated so deploys take effect.
          res.setHeader(
            'Cache-Control',
            pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
          )
        },
      })
    : null

  const server = createServer((req, res) => {
    setSecurityHeaders(req, res)
    const url = parseUrl(req)
    if (!url) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('Bad Request')
      return
    }
    try {
      handleRequest(req, res, url.pathname)
    } catch (error) {
      console.error('[http] request failed', error)
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('Internal error')
    }
  })

  function handleRequest(req: IncomingMessage, res: ServerResponse, pathname: string): void {
    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
      return
    }
    if (isAdminHost(req)) {
      serveAdminHost(req, res, pathname)
      return
    }
    if (pathname.startsWith('/api/admin/')) {
      // The admin API only exists on ADMIN_HOST.
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Not found"}')
      return
    }
    if (pathname === '/api/config') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ maxDocChars: config.limits.maxDocChars }))
      return
    }
    const ownerDelete = /^\/api\/rooms\/([^/]+)$/.exec(pathname)
    if (ownerDelete && req.method === 'DELETE') {
      deleteAsOwner(req, safeDecode(ownerDelete[1]) ?? '')
        .then((status) => res.writeHead(status).end())
        .catch((error) => {
          console.error('[api] delete failed', error)
          res.writeHead(500).end()
        })
      return
    }
    if (pathname.startsWith('/api/')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Not found"}')
      return
    }
    // Every other path is a room, so it gets the editor page (the admin page only exists on ADMIN_HOST).
    if (!isStaticAsset(pathname)) req.url = '/'
    if (serveStatic) {
      serveStatic(req, res, () => {
        res.writeHead(404).end('Not found')
      })
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Client not built. Run `npm run build`.')
  }

  /** ADMIN_HOST serves only the admin page, its assets and the admin API. */
  function serveAdminHost(req: IncomingMessage, res: ServerResponse, pathname: string): void {
    if (pathname.startsWith('/api/')) {
      handleAdmin(req, res, pathname)
        .then((handled) => {
          if (!handled) res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Not found"}')
        })
        .catch((error) => {
          console.error('[api] request failed', error)
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
          res.end('{"error":"Internal error"}')
        })
      return
    }
    if (!adminEnabled || !serveStatic) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
      return
    }
    if (!isStaticAsset(pathname)) req.url = '/admin.html'
    serveStatic(req, res, () => {
      res.writeHead(404).end('Not found')
    })
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.limits.maxMessageBytes || DEFAULT_MAX_MESSAGE_BYTES,
  })
  const alive = new WeakSet<WebSocket>()

  server.on('upgrade', (req, socket, head) => {
    const url = parseUrl(req)
    const access = !url || isAdminHost(req) ? null : parseAccess(url.pathname, url.searchParams)
    if (!access) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (conn) => {
      alive.add(conn)
      conn.on('pong', () => alive.add(conn))
      rooms.connect(conn, access, clientIp(req))
    })
  })

  const heartbeat = setInterval(() => {
    for (const conn of wss.clients) {
      if (!alive.has(conn)) {
        conn.terminate()
        continue
      }
      alive.delete(conn)
      conn.ping()
    }
  }, HEARTBEAT_MS)

  async function cleanupExpiredRooms(): Promise<void> {
    rooms.pruneCounters()
    if (config.roomTtlDays === 0) return
    const cutoff = Date.now() - config.roomTtlDays * 24 * 60 * 60 * 1000
    try {
      const deleted = await store.deleteOlderThan(cutoff, rooms.activeRoomIds())
      if (deleted > 0) console.log(`[cleanup] deleted ${deleted} expired room(s)`)
    } catch (error) {
      console.error('[cleanup] failed', error)
    }
  }
  void cleanupExpiredRooms()
  const cleanup = setInterval(() => void cleanupExpiredRooms(), CLEANUP_INTERVAL_MS)

  return {
    server,
    rooms,
    store,
    async close() {
      clearInterval(heartbeat)
      clearInterval(cleanup)
      for (const conn of wss.clients) conn.close(1001, 'Server shutting down')
      const closed = new Promise<void>((done) => server.close(() => done()))
      // Idle keep-alive sockets would otherwise hold close() open.
      server.closeIdleConnections()
      await closed
      await rooms.closeAll()
      await store.close()
    },
  }
}
