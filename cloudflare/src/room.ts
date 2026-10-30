import { DurableObject } from 'cloudflare:workers'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import { intVar, randomId, registry, sha256Hex, type Env } from './shared'

// Same wire protocol as server/src/rooms.ts, so the client works unchanged.
const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const MESSAGE_QUERY_AWARENESS = 3
const MESSAGE_STATUS = 100
const CLOSE_NOT_FOUND = 4404
const CLOSE_RATE_LIMITED = 4429
const CLOSE_TOO_BIG = 1009

// Edits are collected briefly before writing, to stay well inside the free plan's daily
// row-write budget. A pending timer also keeps the object awake until the write happens.
const SAVE_DEBOUNCE_MS = 1000
const SAVE_MAX_WAIT_MS = 5000
// The registry (room list for the admin page) only needs to be roughly up to date.
const REGISTRY_UPDATE_MS = 30_000
const DAY_MS = 24 * 60 * 60 * 1000

interface RoomMeta {
  id: string
  viewId: string
  ownerHash: string | null
  locked: boolean
  createdAt: number
  updatedAt: number
}

/** Kept on each WebSocket so it survives hibernation. */
interface Attachment {
  viewer: boolean
  /** Awareness client IDs this connection controls, with their latest clock. */
  clients: Record<string, number>
}

export interface RoomDetail {
  id: string
  viewId: string
  locked: boolean
  online: number
  language: string | null
  text: string
  createdAt: number
  updatedAt: number
  sizeBytes: number
}

function encodeStatus(payload: object): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_STATUS)
  encoding.writeVarString(encoder, JSON.stringify(payload))
  return encoding.toUint8Array(encoder)
}

function send(ws: WebSocket, message: Uint8Array): void {
  try {
    ws.send(message)
  } catch {
    // The socket is already closing; webSocketClose will clean up.
  }
}

/**
 * One room: holds the Yjs document and every connection to it. Uses the WebSocket
 * Hibernation API, so an idle room costs nothing; the document is reloaded from storage
 * when the object wakes up.
 */
export class Room extends DurableObject<Env> {
  private readonly sql: SqlStorage
  private meta: RoomMeta | null = null
  private readonly doc = new Y.Doc({ gc: true })
  private readonly text = this.doc.getText('code')
  private readonly awareness = new awarenessProtocol.Awareness(this.doc)
  // Tracks edits from any WebSocket so an edit that breaks the size limit can be reverted.
  private readonly undoManager = new Y.UndoManager(this.text, { trackedOrigins: new Set([WebSocket]), captureTimeout: 0 })
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private firstDirtyAt = 0
  private dirty = false
  private lastRegistryUpdate = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value BLOB)')

    const rows = this.sql.exec<{ key: string; value: ArrayBuffer | string }>('SELECT key, value FROM kv').toArray()
    for (const row of rows) {
      if (row.key === 'meta') this.meta = JSON.parse(row.value as string)
      if (row.key === 'doc') Y.applyUpdate(this.doc, new Uint8Array(row.value as ArrayBuffer))
    }

    // Awareness checks for stale peers on a timer, which would keep the object from
    // hibernating. Connections clean up their own state on close instead.
    clearInterval((this.awareness as unknown as { _checkInterval: ReturnType<typeof setInterval> })._checkInterval)
    this.awareness.setLocalState(null)

    this.doc.on('update', (update: Uint8Array) => {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.writeUpdate(encoder, update)
      this.broadcast(encoding.toUint8Array(encoder))
      this.scheduleSave()
    })

    // Registered after the UndoManager's own handler, so the edit is already on its stack.
    this.doc.on('afterTransaction', (transaction: Y.Transaction) => {
      const max = intVar(this.env.MAX_DOC_CHARS)
      if (max > 0 && transaction.origin instanceof WebSocket && this.text.length > max) {
        this.undoManager.undo()
        send(transaction.origin, encodeStatus({ error: 'doc-too-large', maxDocChars: max }))
      }
      this.undoManager.clear()
    })

    this.awareness.on(
      'update',
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (origin instanceof WebSocket) {
          const attachment = origin.deserializeAttachment() as Attachment
          for (const id of [...added, ...updated]) {
            const clock = this.awareness.meta.get(id)?.clock
            if (clock !== undefined) attachment.clients[id] = clock
          }
          for (const id of removed) delete attachment.clients[id]
          origin.serializeAttachment(attachment)
        }
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]),
        )
        this.broadcast(encoding.toUint8Array(encoder))
      },
    )
  }

  // --- Connections -------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket', { status: 426 })
    }
    const roomId = request.headers.get('x-room-id') ?? ''
    const viewer = request.headers.get('x-access') === 'view'
    const ownerToken = request.headers.get('x-owner-token') ?? ''
    const ip = request.headers.get('x-client-ip') ?? 'local'

    const [client, server] = Object.values(new WebSocketPair())
    const refuse = (code: number, reason: string) => {
      server.accept()
      server.close(code, reason)
      return new Response(null, { status: 101, webSocket: client })
    }

    if (!this.meta) {
      if (viewer) return refuse(CLOSE_NOT_FOUND, 'Room not found')
      const maxNewRooms = intVar(this.env.MAX_NEW_ROOMS_PER_HOUR)
      if (maxNewRooms > 0 && !(await registry(this.env).hit(`new-room:${ip}`, maxNewRooms, 60 * 60 * 1000))) {
        return refuse(CLOSE_RATE_LIMITED, 'Too many new rooms')
      }
      await this.create(roomId, ownerToken)
    }

    const maxConnections = intVar(this.env.MAX_CONNECTIONS_PER_ROOM)
    if (maxConnections > 0 && this.ctx.getWebSockets().length >= maxConnections) {
      return refuse(CLOSE_RATE_LIMITED, 'Room is full')
    }

    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ viewer, clients: {} } satisfies Attachment)
    this.join(server)
    await this.reportOnline()
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === 'string') return
    const maxBytes = intVar(this.env.MAX_MESSAGE_BYTES)
    if (maxBytes > 0 && message.byteLength > maxBytes) {
      ws.close(CLOSE_TOO_BIG, 'Message too large')
      return
    }
    try {
      this.handleMessage(ws, new Uint8Array(message))
    } catch (error) {
      console.error(`[room ${this.meta?.id}] bad message`, error)
      ws.close(1003, 'Invalid message')
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.leave(ws)
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code)
    } catch {
      // Already closed.
    }
    await this.reportOnline(ws)
    if (this.ctx.getWebSockets().filter((socket) => socket !== ws).length === 0) await this.flush()
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011)
  }

  // --- Admin and owner operations (RPC) ---------------------------------------------

  detail(): RoomDetail | null {
    if (!this.meta) return null
    return {
      id: this.meta.id,
      viewId: this.meta.viewId,
      locked: this.meta.locked,
      online: this.ctx.getWebSockets().length,
      language: this.doc.getMap<string>('meta').get('language') ?? null,
      text: this.text.toString(),
      createdAt: this.meta.createdAt,
      updatedAt: this.meta.updatedAt,
      sizeBytes: Y.encodeStateAsUpdate(this.doc).byteLength,
    }
  }

  async setLocked(locked: boolean): Promise<boolean> {
    if (!this.meta) return false
    this.meta.locked = locked
    this.writeMeta()
    for (const ws of this.ctx.getWebSockets()) this.sendStatus(ws)
    await registry(this.env).update(this.meta.id, { locked })
    return true
  }

  /** Deletes the room if `token` belongs to its creator. */
  async deleteAsOwner(token: string): Promise<'deleted' | 'forbidden' | 'missing'> {
    if (!this.meta) return 'missing'
    if (!token || !this.meta.ownerHash || (await sha256Hex(token)) !== this.meta.ownerHash) return 'forbidden'
    await this.destroy()
    return 'deleted'
  }

  /** Deletes the room and disconnects everyone. Returns false if it did not exist. */
  async destroy(): Promise<boolean> {
    if (!this.meta) return false
    const id = this.meta.id
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(CLOSE_NOT_FOUND, 'Room deleted')
      } catch {
        // Already closing.
      }
    }
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    this.dirty = false
    this.meta = null
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    await registry(this.env).remove(id)
    return true
  }

  // --- Expiry --------------------------------------------------------------------

  async alarm(): Promise<void> {
    const ttlDays = intVar(this.env.ROOM_TTL_DAYS)
    if (!this.meta || ttlDays === 0) return
    const expiresAt = this.meta.updatedAt + ttlDays * DAY_MS
    if (this.ctx.getWebSockets().length > 0 || expiresAt > Date.now()) {
      await this.ctx.storage.setAlarm(Math.max(expiresAt, Date.now() + DAY_MS))
      return
    }
    await this.destroy()
  }

  // --- Internals -------------------------------------------------------------------

  private async create(roomId: string, ownerToken: string): Promise<void> {
    const now = Date.now()
    this.meta = {
      id: roomId,
      viewId: randomId(),
      // Only whoever opens a room that does not exist yet can claim it.
      ownerHash: ownerToken ? await sha256Hex(ownerToken) : null,
      locked: false,
      createdAt: now,
      updatedAt: now,
    }
    this.writeMeta()
    await registry(this.env).register(roomId, this.meta.viewId, now)
    const ttlDays = intVar(this.env.ROOM_TTL_DAYS)
    if (ttlDays > 0) await this.ctx.storage.setAlarm(now + ttlDays * DAY_MS)
  }

  private join(ws: WebSocket): void {
    this.sendStatus(ws)

    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(encoder, this.doc)
    send(ws, encoding.toUint8Array(encoder))

    const states = this.awareness.getStates()
    if (states.size > 0) {
      const awarenessEncoder = encoding.createEncoder()
      encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(awarenessEncoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]))
      send(ws, encoding.toUint8Array(awarenessEncoder))
    }

    // After hibernation the server has forgotten who is here; ask the others to say so again.
    const query = encoding.createEncoder()
    encoding.writeVarUint(query, MESSAGE_QUERY_AWARENESS)
    const message = encoding.toUint8Array(query)
    for (const other of this.ctx.getWebSockets()) if (other !== ws) send(other, message)
  }

  private handleMessage(ws: WebSocket, data: Uint8Array): void {
    const attachment = ws.deserializeAttachment() as Attachment
    const decoder = decoding.createDecoder(data)
    const type = decoding.readVarUint(decoder)
    if (type === MESSAGE_SYNC) {
      // Read-only connections may ask for the document (step 1) but never change it.
      const canEdit = !attachment.viewer && !this.meta?.locked
      if (!canEdit && decoding.peekVarUint(decoder) !== syncProtocol.messageYjsSyncStep1) return
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, ws)
      if (encoding.length(encoder) > 1) send(ws, encoding.toUint8Array(encoder))
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), ws)
    }
  }

  private leave(ws: WebSocket): void {
    const attachment = ws.deserializeAttachment() as Attachment | null
    const ids = Object.keys(attachment?.clients ?? {}).map(Number)
    if (ids.length === 0) return
    // After hibernation the awareness instance may not know these clients any more;
    // restore their last clock so the removal is encoded with a newer one.
    for (const id of ids) {
      if (!this.awareness.meta.has(id)) {
        this.awareness.meta.set(id, { clock: attachment!.clients[id], lastUpdated: Date.now() })
        this.awareness.states.set(id, {})
      }
    }
    awarenessProtocol.removeAwarenessStates(this.awareness, ids, null)
  }

  private sendStatus(ws: WebSocket): void {
    const attachment = ws.deserializeAttachment() as Attachment | null
    const viewer = attachment?.viewer ?? true
    send(
      ws,
      encodeStatus({
        readOnly: viewer || Boolean(this.meta?.locked),
        locked: Boolean(this.meta?.locked),
        maxDocChars: intVar(this.env.MAX_DOC_CHARS),
        // Viewers must not learn anything that leads back to the editable room.
        ...(viewer ? {} : { viewId: this.meta?.viewId }),
      }),
    )
  }

  private scheduleSave(): void {
    const now = Date.now()
    if (!this.dirty) this.firstDirtyAt = now
    this.dirty = true
    if (this.saveTimer) clearTimeout(this.saveTimer)
    const wait = Math.min(SAVE_DEBOUNCE_MS, Math.max(0, this.firstDirtyAt + SAVE_MAX_WAIT_MS - now))
    this.saveTimer = setTimeout(() => void this.flush(), wait)
  }

  private async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (!this.dirty || !this.meta) return
    this.dirty = false
    const snapshot = Y.encodeStateAsUpdate(this.doc)
    this.meta.updatedAt = Date.now()
    this.sql.exec('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', 'doc', snapshot)
    this.writeMeta()
    if (Date.now() - this.lastRegistryUpdate > REGISTRY_UPDATE_MS || this.ctx.getWebSockets().length === 0) {
      this.lastRegistryUpdate = Date.now()
      await registry(this.env).update(this.meta.id, { updatedAt: this.meta.updatedAt, size: snapshot.byteLength })
    }
  }

  private writeMeta(): void {
    if (this.meta) this.sql.exec('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', 'meta', JSON.stringify(this.meta))
  }

  private async reportOnline(closing?: WebSocket): Promise<void> {
    if (!this.meta) return
    const online = this.ctx.getWebSockets().filter((ws) => ws !== closing).length
    await registry(this.env).update(this.meta.id, { online })
  }

  private broadcast(message: Uint8Array): void {
    for (const ws of this.ctx.getWebSockets()) send(ws, message)
  }
}
