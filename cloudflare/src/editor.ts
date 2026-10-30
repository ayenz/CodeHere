// The editor Worker: serves the client and routes WebSockets to one Durable Object per room.
// Mirrors server/src/app.ts.
import { safeDecode } from './protocol'
import { clientIp, intVar, isRoomId, isStaticAsset, isViewId, json, registry, roomStub, withSecurityHeaders, type Env } from './shared'

export { Registry } from './registry'
export { Room } from './room'

async function connect(request: Request, env: Env, pathname: string): Promise<Response> {
  const view = /^\/ws\/v\/([^/]+)$/.exec(pathname)
  const edit = view ? null : /^\/ws\/([^/]+)$/.exec(pathname)
  if (env.CONNECT_LIMITER && !(await env.CONNECT_LIMITER.limit({ key: clientIp(request) })).success) {
    return closedSocket(4429, 'Too many connections')
  }
  let roomId: string | null = null
  if (view) {
    const viewId = safeDecode(view[1])
    if (!viewId || !isViewId(viewId)) return new Response('Bad Request', { status: 400 })
    roomId = await registry(env).roomIdForView(viewId)
    // The client still needs an open socket to learn why: the room answers with 4404.
    if (!roomId) return closedSocket(4404, 'Room not found')
  } else if (edit) {
    roomId = safeDecode(edit[1])
    if (!roomId || !isRoomId(roomId)) return new Response('Bad Request', { status: 400 })
  } else {
    return new Response('Bad Request', { status: 400 })
  }

  const headers = new Headers(request.headers)
  headers.set('x-room-id', roomId)
  headers.set('x-access', view ? 'view' : 'edit')
  headers.set('x-client-ip', clientIp(request))
  headers.set('x-owner-token', view ? '' : (new URL(request.url).searchParams.get('owner') ?? ''))
  return roomStub(env, roomId).fetch(new Request(request.url, { headers }))
}

function closedSocket(code: number, reason: string): Response {
  const [client, server] = Object.values(new WebSocketPair())
  server.accept()
  server.close(code, reason)
  return new Response(null, { status: 101, webSocket: client })
}

/** DELETE /api/rooms/:id with the creator's X-Owner-Token. */
async function deleteAsOwner(request: Request, env: Env, id: string): Promise<Response> {
  const token = request.headers.get('x-owner-token') ?? ''
  if (request.headers.get('x-requested-with') !== 'codehere' || !token) return new Response(null, { status: 403 })
  if (!isRoomId(id) || !(await registry(env).get(id))) return new Response(null, { status: 404 })
  const result = await roomStub(env, id).deleteAsOwner(token)
  return new Response(null, { status: result === 'deleted' ? 204 : result === 'forbidden' ? 403 : 404 })
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    const { pathname } = url

    if (pathname === '/healthz') return new Response('ok')
    if (pathname === '/api/config') return json({ maxDocChars: intVar(env.MAX_DOC_CHARS) })
    const ownerDelete = /^\/api\/rooms\/([^/]+)$/.exec(pathname)
    if (ownerDelete && request.method === 'DELETE') return deleteAsOwner(request, env, safeDecode(ownerDelete[1]) ?? '')
    if (pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404)
    if (pathname.startsWith('/ws/')) {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket', { status: 426 })
      return connect(request, env, pathname)
    }
    if (isStaticAsset(pathname)) return withSecurityHeaders(await env.ASSETS.fetch(request))
    // Every other path is a room, so it gets the editor page (the admin page has its own Worker).
    return withSecurityHeaders(await env.ASSETS.fetch(new Request(new URL('/', url), request)))
  },
} satisfies ExportedHandler<Env>
