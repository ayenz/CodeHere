import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sirv from 'sirv'
import { WebSocketServer, type WebSocket } from 'ws'
import { loadConfig } from './config.js'
import { openRoomStore } from './db.js'
import { ROOM_ID_PATTERN, RoomManager } from './rooms.js'

const HEARTBEAT_MS = 30_000
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024

const config = loadConfig()
const store = await openRoomStore(config)
const rooms = new RoomManager(store, config.persistDebounceMs)

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
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
    return
  }
  if (serveStatic) {
    serveStatic(req, res, () => {
      res.writeHead(404).end('Not found')
    })
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' }).end('Client not built. Run `npm run build`.')
})

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
const alive = new WeakSet<WebSocket>()

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')
  const match = /^\/ws\/([^/]+)$/.exec(pathname)
  const roomId = match ? decodeURIComponent(match[1]) : ''
  if (!ROOM_ID_PATTERN.test(roomId)) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    return
  }
  wss.handleUpgrade(req, socket, head, (conn) => {
    alive.add(conn)
    conn.on('pong', () => alive.add(conn))
    rooms.connect(conn, roomId)
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

server.listen(config.port, config.host, () => {
  console.log(`[server] listening on http://${config.host}:${config.port} (db: ${config.dbDriver})`)
  if (!serveStatic) console.log('[server] client build not found; serving WebSocket only')
})

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[server] ${signal} received, saving rooms…`)
  clearInterval(heartbeat)
  clearInterval(cleanup)
  for (const conn of wss.clients) conn.close(1001, 'Server shutting down')
  server.close()
  await rooms.closeAll()
  await store.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
