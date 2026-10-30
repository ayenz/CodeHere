import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as decoding from 'lib0/decoding'
import WebSocket from 'ws'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { createApp, type App } from '../src/app.js'
import { loadConfig, type Config, type Limits } from '../src/config.js'
import { MESSAGE_STATUS } from '../src/rooms.js'

/**
 * Config for tests. The database comes from the environment (DB_DRIVER / DATABASE_URL),
 * so the same suite runs against SQLite, MySQL and Postgres; SQLite uses a fresh temp file.
 */
export function testConfig(overrides: Partial<Omit<Config, 'limits'>> & { limits?: Partial<Limits> } = {}): Config {
  const base = loadConfig()
  return {
    ...base,
    host: '127.0.0.1',
    port: 0,
    sqlitePath: join(mkdtempSync(join(tmpdir(), 'codehere-test-')), 'test.db'),
    persistDebounceMs: 20,
    roomTtlDays: 0,
    staticDir: '/nonexistent',
    adminPassword: '',
    ...overrides,
    limits: { ...base.limits, ...overrides.limits },
  }
}

export interface Running {
  app: App
  config: Config
  http: string
  ws: string
  stop(): Promise<void>
}

export async function start(config: Config): Promise<Running> {
  const app = await createApp(config)
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done))
  const { port } = app.server.address() as AddressInfo
  return {
    app,
    config,
    http: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}/ws`,
    stop: () => app.close(),
  }
}

export function roomId(): string {
  return `t${randomBytes(6).toString('hex')}`
}

export interface Client {
  doc: Y.Doc
  text: Y.Text
  provider: WebsocketProvider
  statuses: Array<Record<string, unknown>>
  closeCodes: number[]
  destroy(): void
}

export function client(serverUrl: string, room: string, params: Record<string, string> = {}): Client {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(serverUrl, room, doc, {
    params,
    WebSocketPolyfill: WebSocket as never,
    // Clients in one process would otherwise sync through BroadcastChannel, bypassing the server.
    disableBc: true,
  })
  const statuses: Array<Record<string, unknown>> = []
  const closeCodes: number[] = []
  provider.messageHandlers[MESSAGE_STATUS] = (_encoder, decoder) => {
    statuses.push(JSON.parse(decoding.readVarString(decoder)))
  }
  provider.on('connection-close', (event: { code: number } | null) => {
    if (event) closeCodes.push(event.code)
  })
  return {
    doc,
    text: doc.getText('code'),
    provider,
    statuses,
    closeCodes,
    destroy: () => {
      provider.destroy()
      doc.destroy()
    },
  }
}

export function synced(c: Client): Promise<void> {
  return new Promise((done) => {
    if (c.provider.synced) done()
    else c.provider.once('sync', () => done())
  })
}

export async function until(check: () => boolean, label: string, timeout = 3000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
