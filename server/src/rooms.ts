import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { WebSocket, type RawData } from 'ws'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import type { Limits } from './config.js'
import type { RoomStore } from './db.js'
import { TokenBucket, WindowCounter } from './limits.js'
import { hasPendingUpdates, isAllowedUpdate, sanitizeAwarenessUpdate } from './protocol.js'

// Message types of the y-websocket protocol, which the client's WebsocketProvider speaks.
const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
// CodeHere's own server → client message (JSON payload); y-websocket reserves 0-3.
export const MESSAGE_STATUS = 100

// Flush at least this often while a room is being edited continuously.
const MAX_PERSIST_WAIT_MS = 10_000

// Messages a connection may send before its room has finished loading.
const MAX_QUEUED_MESSAGES = 200

// Close codes in 4400-4499 tell y-websocket clients not to reconnect.
export const CLOSE_NOT_FOUND = 4404
export const CLOSE_RATE_LIMITED = 4429
const CLOSE_TRY_AGAIN_LATER = 1013

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{4,32}$/
// Paths the server or client use for something other than rooms. The admin UI lives on
// its own host (ADMIN_HOST), so "admin" stays available as a room name.
const RESERVED_IDS = new Set(['api', 'assets', 'healthz', 'v', 'ws'])

export function isRoomId(id: string): boolean {
  return ROOM_ID_PATTERN.test(id) && !RESERVED_IDS.has(id.toLowerCase())
}

function newViewId(): string {
  return randomBytes(9).toString('base64url')
}

export type Access =
  | { kind: 'edit'; roomId: string; /** Secret sent by the browser that creates the room. */ ownerToken?: string }
  | { kind: 'view'; viewId: string }

export function hashOwnerToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Sent to clients when they join and whenever their permissions change. */
export interface RoomStatus {
  readOnly: boolean
  locked: boolean
  /** Only sent to editors; viewers must not learn anything that leads back to the editable room. */
  viewId?: string
  /** 0 means unlimited. */
  maxDocChars: number
}

interface ConnectionState {
  viewer: boolean
  /** Awareness client IDs this connection controls. */
  clientIds: Set<number>
}

interface AwarenessChange {
  added: number[]
  updated: number[]
  removed: number[]
}

class Room {
  readonly doc = new Y.Doc({ gc: true })
  readonly text = this.doc.getText('code')
  readonly awareness = new awarenessProtocol.Awareness(this.doc)
  readonly conns = new Map<WebSocket, ConnectionState>()
  deleted = false

  // Tracks edits from any WebSocket so an edit that breaks the size limit can be reverted.
  private readonly undoManager = new Y.UndoManager(this.text, {
    trackedOrigins: new Set([WebSocket]),
    captureTimeout: 0,
  })
  private dirty = false
  private saveTimer: NodeJS.Timeout | null = null
  private firstDirtyAt = 0
  private saving: Promise<void> = Promise.resolve()

  constructor(
    readonly id: string,
    public viewId: string,
    public locked: boolean,
    readonly ownerHash: string | null,
    private readonly store: RoomStore,
    private readonly limits: Limits,
    private readonly debounceMs: number,
  ) {
    // The server holds no awareness state of its own.
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
      const origin = transaction.origin
      const max = this.limits.maxDocChars
      if (max > 0 && origin instanceof WebSocket && this.text.length > max) {
        this.undoManager.undo()
        sendJson(origin, { error: 'doc-too-large', maxDocChars: max })
      }
      // Nothing else is ever undone, so keep the stack empty.
      this.undoManager.clear()
    })

    this.awareness.on('update', ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
      const changed = [...added, ...updated, ...removed]
      if (origin instanceof WebSocket) {
        const state = this.conns.get(origin)
        if (state) {
          for (const id of added) state.clientIds.add(id)
          for (const id of removed) state.clientIds.delete(id)
        }
      }
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed))
      this.broadcast(encoding.toUint8Array(encoder))
    })
  }

  join(conn: WebSocket, viewer: boolean): void {
    this.conns.set(conn, { viewer, clientIds: new Set() })
    this.sendStatus(conn)

    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(encoder, this.doc)
    send(conn, encoding.toUint8Array(encoder))

    const states = this.awareness.getStates()
    if (states.size > 0) {
      const awarenessEncoder = encoding.createEncoder()
      encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]),
      )
      send(conn, encoding.toUint8Array(awarenessEncoder))
    }
  }

  handleMessage(conn: WebSocket, data: Uint8Array): void {
    const state = this.conns.get(conn)
    if (!state) return
    const decoder = decoding.createDecoder(data)
    const type = decoding.readVarUint(decoder)
    if (type === MESSAGE_SYNC) {
      const syncType = decoding.readVarUint(decoder)
      if (syncType === syncProtocol.messageYjsSyncStep1) {
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_SYNC)
        syncProtocol.readSyncStep1(decoder, encoder, this.doc)
        send(conn, encoding.toUint8Array(encoder))
        return
      }
      // Read-only connections may ask for the document (step 1 above) but never change it.
      if (state.viewer || this.locked) return
      if (syncType !== syncProtocol.messageYjsSyncStep2 && syncType !== syncProtocol.messageYjsUpdate) return
      const update = decoding.readVarUint8Array(decoder)
      if (!isAllowedUpdate(update)) {
        conn.close(1008, 'Invalid update')
        return
      }
      Y.applyUpdate(this.doc, update, conn)
      // Updates that cannot be integrated would be stored and resent forever; drop them.
      if (hasPendingUpdates(this.doc)) {
        this.doc.store.pendingStructs = null
        this.doc.store.pendingDs = null
        conn.close(1008, 'Invalid update')
      }
    } else if (type === MESSAGE_AWARENESS) {
      const update = sanitizeAwarenessUpdate(decoding.readVarUint8Array(decoder), {
        viewer: state.viewer,
        owned: state.clientIds,
        ownedByOthers: (clientId) => [...this.conns].some(([other, s]) => other !== conn && s.clientIds.has(clientId)),
      })
      if (update) awarenessProtocol.applyAwarenessUpdate(this.awareness, update, conn)
    }
  }

  leave(conn: WebSocket): void {
    const state = this.conns.get(conn)
    if (!state) return
    this.conns.delete(conn)
    awarenessProtocol.removeAwarenessStates(this.awareness, [...state.clientIds], null)
  }

  setLocked(locked: boolean): void {
    this.locked = locked
    this.markDirty()
    for (const conn of this.conns.keys()) this.sendStatus(conn)
  }

  /** Writes pending changes now. Safe to call repeatedly. */
  flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.dirty || this.deleted) return this.saving
    this.dirty = false
    const snapshot = {
      doc: Y.encodeStateAsUpdate(this.doc),
      viewId: this.viewId,
      locked: this.locked,
      ownerHash: this.ownerHash,
    }
    this.saving = this.saving
      .then(() => (this.deleted ? undefined : this.store.save(this.id, snapshot)))
      .catch((error) => {
        this.dirty = true
        console.error(`[room ${this.id}] failed to save`, error)
      })
    return this.saving
  }

  closeAll(code: number, reason: string): void {
    for (const conn of this.conns.keys()) conn.close(code, reason)
  }

  destroy(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.undoManager.destroy()
    this.awareness.destroy()
    this.doc.destroy()
  }

  private sendStatus(conn: WebSocket): void {
    const viewer = this.conns.get(conn)?.viewer ?? true
    const status: RoomStatus = {
      readOnly: viewer || this.locked,
      locked: this.locked,
      maxDocChars: this.limits.maxDocChars,
      ...(viewer ? {} : { viewId: this.viewId }),
    }
    sendJson(conn, status)
  }

  private markDirty(): void {
    const now = Date.now()
    if (!this.dirty) this.firstDirtyAt = now
    this.dirty = true
  }

  private scheduleSave(): void {
    this.markDirty()
    if (this.saveTimer) clearTimeout(this.saveTimer)
    const wait = Math.min(this.debounceMs, Math.max(0, this.firstDirtyAt + MAX_PERSIST_WAIT_MS - Date.now()))
    this.saveTimer = setTimeout(() => void this.flush(), wait)
  }

  private broadcast(message: Uint8Array): void {
    for (const conn of this.conns.keys()) send(conn, message)
  }
}

function send(conn: WebSocket, message: Uint8Array): void {
  if (conn.readyState !== WebSocket.OPEN) return
  conn.send(message, (error) => {
    if (error) conn.terminate()
  })
}

function sendJson(conn: WebSocket, payload: object): void {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_STATUS)
  encoding.writeVarString(encoder, JSON.stringify(payload))
  send(conn, encoding.toUint8Array(encoder))
}

function toUint8Array(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

class RoomUnavailable extends Error {
  constructor(
    readonly code: number,
    reason: string,
  ) {
    super(reason)
  }
}

export interface RoomDetail {
  id: string
  viewId: string | null
  locked: boolean
  online: number
  language: string | null
  text: string
}

export class RoomManager {
  private readonly rooms = new Map<string, Promise<Room>>()
  private readonly viewIndex = new Map<string, string>()
  private readonly connectionsPerIp = new Map<string, number>()
  private readonly newRooms: WindowCounter | null

  constructor(
    private readonly store: RoomStore,
    private readonly limits: Limits,
    private readonly debounceMs: number,
  ) {
    this.newRooms = limits.maxNewRoomsPerHour > 0 ? new WindowCounter(limits.maxNewRoomsPerHour, 60 * 60 * 1000) : null
  }

  /** Attaches a WebSocket to a room, loading the room from the database first if needed. */
  connect(conn: WebSocket, access: Access, ip: string): void {
    conn.binaryType = 'nodebuffer'

    const open = this.connectionsPerIp.get(ip) ?? 0
    const maxConnections = this.limits.maxConnectionsPerIp
    if (maxConnections > 0 && open >= maxConnections) {
      conn.close(CLOSE_RATE_LIMITED, 'Too many connections')
      return
    }
    this.connectionsPerIp.set(ip, open + 1)

    // Messages can arrive while the room is still loading; queue them until it is ready.
    let room: Room | null = null
    const queue: Uint8Array[] = []
    let closed = false
    const rate = this.limits.maxMessagesPerSecond
    const bucket = rate > 0 ? new TokenBucket(rate, rate * 4) : null

    conn.on('message', (data) => {
      if (bucket && !bucket.take()) {
        conn.close(CLOSE_RATE_LIMITED, 'Too many messages')
        return
      }
      const message = toUint8Array(data)
      if (!room) {
        if (queue.length >= MAX_QUEUED_MESSAGES) {
          conn.close(CLOSE_RATE_LIMITED, 'Too many messages')
          return
        }
        queue.push(message)
        return
      }
      try {
        room.handleMessage(conn, message)
      } catch (error) {
        console.error(`[room ${room.id}] bad message`, error)
        conn.close(1003, 'Invalid message')
      }
    })

    conn.on('close', () => {
      closed = true
      const remaining = (this.connectionsPerIp.get(ip) ?? 1) - 1
      if (remaining > 0) this.connectionsPerIp.set(ip, remaining)
      else this.connectionsPerIp.delete(ip)
      if (room) this.release(room, conn)
    })

    this.resolve(access, ip)
      .then((loaded) => {
        if (closed || loaded.deleted) {
          void this.releaseIfEmpty(loaded)
          if (!closed) conn.close(CLOSE_NOT_FOUND, 'Room not found')
          return
        }
        room = loaded
        loaded.join(conn, access.kind === 'view')
        for (const message of queue.splice(0)) loaded.handleMessage(conn, message)
      })
      .catch((error) => {
        if (error instanceof RoomUnavailable) {
          conn.close(error.code, error.message)
          return
        }
        console.error('[rooms] failed to open room', error)
        conn.close(1011, 'Room unavailable')
      })
  }

  stats(): { activeRooms: number; connections: number } {
    let connections = 0
    for (const count of this.connectionsPerIp.values()) connections += count
    return { activeRooms: this.rooms.size, connections }
  }

  activeRoomIds(): string[] {
    return [...this.rooms.keys()]
  }

  async online(id: string): Promise<number> {
    const room = await this.rooms.get(id)?.catch(() => null)
    return room ? room.conns.size : 0
  }

  async detail(id: string): Promise<RoomDetail | null> {
    const active = await this.rooms.get(id)?.catch(() => null)
    if (active) {
      return {
        id,
        viewId: active.viewId,
        locked: active.locked,
        online: active.conns.size,
        language: active.doc.getMap<string>('meta').get('language') ?? null,
        text: active.text.toString(),
      }
    }
    const stored = await this.store.load(id)
    if (!stored) return null
    const doc = new Y.Doc()
    Y.applyUpdate(doc, stored.doc)
    const detail = {
      id,
      viewId: stored.viewId,
      locked: stored.locked,
      online: 0,
      language: doc.getMap<string>('meta').get('language') ?? null,
      text: doc.getText('code').toString(),
    }
    doc.destroy()
    return detail
  }

  /** Locks or unlocks a room for everyone. Returns false if the room does not exist. */
  async setLocked(id: string, locked: boolean): Promise<boolean> {
    const active = await this.rooms.get(id)?.catch(() => null)
    if (active) {
      active.setLocked(locked)
      await active.flush()
      return true
    }
    return this.store.setLocked(id, locked)
  }

  /** Checks a creator's token against the room's owner. Null if the room does not exist. */
  async isOwner(id: string, token: string): Promise<boolean | null> {
    const active = await this.rooms.get(id)?.catch(() => null)
    const ownerHash = active ? active.ownerHash : (await this.store.load(id))?.ownerHash
    if (ownerHash === undefined) return null
    if (!ownerHash) return false
    return timingSafeEqual(Buffer.from(hashOwnerToken(token)), Buffer.from(ownerHash))
  }

  /** Deletes a room, disconnecting everyone in it. Returns false if it did not exist. */
  async delete(id: string): Promise<boolean> {
    const active = await this.rooms.get(id)?.catch(() => null)
    if (active) {
      active.deleted = true
      active.closeAll(CLOSE_NOT_FOUND, 'Room deleted')
    }
    // Keep the deleted room in memory until the row is gone, so that anyone connecting in
    // the meantime is refused instead of loading the old row again.
    const stored = await this.store.delete(id)
    if (active) this.unload(active)
    return Boolean(active) || stored
  }

  async closeAll(): Promise<void> {
    const rooms = await Promise.allSettled(this.rooms.values())
    await Promise.all(
      rooms.map((result) => (result.status === 'fulfilled' ? result.value.flush() : undefined)),
    )
  }

  pruneCounters(): void {
    this.newRooms?.prune()
  }

  private async resolve(access: Access, ip: string): Promise<Room> {
    if (access.kind === 'edit') return this.acquire(access.roomId, ip, true, access.ownerToken)
    const roomId = this.viewIndex.get(access.viewId) ?? (await this.store.findIdByViewId(access.viewId))
    if (!roomId) throw new RoomUnavailable(CLOSE_NOT_FOUND, 'Room not found')
    return this.acquire(roomId, ip, false)
  }

  private acquire(roomId: string, ip: string, mayCreate: boolean, ownerToken?: string): Promise<Room> {
    let pending = this.rooms.get(roomId)
    if (!pending) {
      const maxActive = this.limits.maxActiveRooms
      if (maxActive > 0 && this.rooms.size >= maxActive) {
        return Promise.reject(new RoomUnavailable(CLOSE_TRY_AGAIN_LATER, 'Server busy'))
      }
      pending = this.load(roomId, ip, mayCreate, ownerToken)
      pending.catch(() => this.rooms.delete(roomId))
      this.rooms.set(roomId, pending)
    }
    return pending
  }

  private async load(roomId: string, ip: string, mayCreate: boolean, ownerToken?: string): Promise<Room> {
    const stored = await this.store.load(roomId)
    if (!stored) {
      if (!mayCreate) throw new RoomUnavailable(CLOSE_NOT_FOUND, 'Room not found')
      if (this.newRooms && !this.newRooms.hit(ip)) throw new RoomUnavailable(CLOSE_RATE_LIMITED, 'Too many new rooms')
    }
    const room = new Room(
      roomId,
      stored?.viewId ?? newViewId(),
      stored?.locked ?? false,
      // Only whoever opens a room that does not exist yet can claim it.
      stored ? stored.ownerHash : ownerToken ? hashOwnerToken(ownerToken) : null,
      this.store,
      this.limits,
      this.debounceMs,
    )
    if (stored) Y.applyUpdate(room.doc, stored.doc)
    this.viewIndex.set(room.viewId, roomId)
    return room
  }

  private release(room: Room, conn: WebSocket): void {
    room.leave(conn)
    void this.releaseIfEmpty(room)
  }

  private async releaseIfEmpty(room: Room): Promise<void> {
    if (room.conns.size > 0) return
    await room.flush()
    // Someone may have joined while the final save was running.
    if (room.conns.size > 0 || !this.rooms.has(room.id)) return
    this.unload(room)
  }

  private unload(room: Room): void {
    this.rooms.delete(room.id)
    this.viewIndex.delete(room.viewId)
    room.destroy()
  }
}
