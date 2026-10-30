import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { WebSocket, type RawData } from 'ws'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import type { RoomStore } from './db.js'

// Message types of the y-websocket protocol, which the client's WebsocketProvider speaks.
const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

// Flush at least this often while a room is being edited continuously.
const MAX_PERSIST_WAIT_MS = 10_000

export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{4,32}$/

class Room {
  readonly doc = new Y.Doc({ gc: true })
  readonly awareness = new awarenessProtocol.Awareness(this.doc)
  /** Each connection and the awareness client IDs it controls. */
  readonly conns = new Map<WebSocket, Set<number>>()

  private dirty = false
  private saveTimer: NodeJS.Timeout | null = null
  private firstDirtyAt = 0
  private saving: Promise<void> = Promise.resolve()

  constructor(
    readonly id: string,
    private readonly store: RoomStore,
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

    this.awareness.on('update', ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
      const changed = [...added, ...updated, ...removed]
      if (origin instanceof WebSocket) {
        const owned = this.conns.get(origin)
        if (owned) {
          for (const id of added) owned.add(id)
          for (const id of removed) owned.delete(id)
        }
      }
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed))
      this.broadcast(encoding.toUint8Array(encoder))
    })
  }

  async loadFromStore(): Promise<void> {
    const stored = await this.store.load(this.id)
    if (stored) Y.applyUpdate(this.doc, stored)
    this.dirty = false
  }

  join(conn: WebSocket): void {
    this.conns.set(conn, new Set())

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
    const decoder = decoding.createDecoder(data)
    const type = decoding.readVarUint(decoder)
    if (type === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, conn)
      // Only reply when the sync message produced a response (step 1 → step 2).
      if (encoding.length(encoder) > 1) send(conn, encoding.toUint8Array(encoder))
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), conn)
    }
  }

  leave(conn: WebSocket): void {
    const owned = this.conns.get(conn)
    if (!owned) return
    this.conns.delete(conn)
    awarenessProtocol.removeAwarenessStates(this.awareness, [...owned], null)
  }

  /** Writes pending changes now. Safe to call repeatedly. */
  flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.dirty) return this.saving
    this.dirty = false
    const snapshot = Y.encodeStateAsUpdate(this.doc)
    this.saving = this.saving
      .then(() => this.store.save(this.id, snapshot))
      .catch((error) => {
        this.dirty = true
        console.error(`[room ${this.id}] failed to save`, error)
      })
    return this.saving
  }

  destroy(): void {
    this.awareness.destroy()
    this.doc.destroy()
  }

  private scheduleSave(): void {
    const now = Date.now()
    if (!this.dirty) this.firstDirtyAt = now
    this.dirty = true
    if (this.saveTimer) clearTimeout(this.saveTimer)
    const wait = Math.min(this.debounceMs, Math.max(0, this.firstDirtyAt + MAX_PERSIST_WAIT_MS - now))
    this.saveTimer = setTimeout(() => void this.flush(), wait)
  }

  private broadcast(message: Uint8Array): void {
    for (const conn of this.conns.keys()) send(conn, message)
  }
}

interface AwarenessChange {
  added: number[]
  updated: number[]
  removed: number[]
}

function send(conn: WebSocket, message: Uint8Array): void {
  if (conn.readyState !== WebSocket.OPEN) return
  conn.send(message, (error) => {
    if (error) conn.terminate()
  })
}

function toUint8Array(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

export class RoomManager {
  private readonly rooms = new Map<string, Promise<Room>>()

  constructor(
    private readonly store: RoomStore,
    private readonly debounceMs: number,
  ) {}

  activeRoomIds(): string[] {
    return [...this.rooms.keys()]
  }

  /** Attaches a WebSocket to a room, loading the room from the database first if needed. */
  connect(conn: WebSocket, roomId: string): void {
    conn.binaryType = 'nodebuffer'

    // Messages can arrive while the room is still loading; queue them until it is ready.
    let room: Room | null = null
    const queue: Uint8Array[] = []
    let closed = false

    conn.on('message', (data) => {
      const message = toUint8Array(data)
      if (!room) {
        queue.push(message)
        return
      }
      try {
        room.handleMessage(conn, message)
      } catch (error) {
        console.error(`[room ${roomId}] bad message`, error)
        conn.close(1003, 'Invalid message')
      }
    })

    conn.on('close', () => {
      closed = true
      if (room) this.release(room, conn)
    })

    this.acquire(roomId)
      .then((loaded) => {
        if (closed) {
          void this.releaseIfEmpty(loaded)
          return
        }
        room = loaded
        loaded.join(conn)
        for (const message of queue.splice(0)) loaded.handleMessage(conn, message)
      })
      .catch((error) => {
        console.error(`[room ${roomId}] failed to open`, error)
        conn.close(1011, 'Room unavailable')
      })
  }

  async closeAll(): Promise<void> {
    const rooms = await Promise.allSettled(this.rooms.values())
    await Promise.all(
      rooms.map((result) => (result.status === 'fulfilled' ? result.value.flush() : undefined)),
    )
  }

  private acquire(roomId: string): Promise<Room> {
    let pending = this.rooms.get(roomId)
    if (!pending) {
      const room = new Room(roomId, this.store, this.debounceMs)
      pending = room.loadFromStore().then(() => room)
      pending.catch(() => this.rooms.delete(roomId))
      this.rooms.set(roomId, pending)
    }
    return pending
  }

  private release(room: Room, conn: WebSocket): void {
    room.leave(conn)
    void this.releaseIfEmpty(room)
  }

  private async releaseIfEmpty(room: Room): Promise<void> {
    if (room.conns.size > 0) return
    await room.flush()
    // Someone may have joined while the final save was running.
    if (room.conns.size > 0) return
    this.rooms.delete(room.id)
    room.destroy()
  }
}
