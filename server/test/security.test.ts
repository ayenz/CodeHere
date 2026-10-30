import assert from 'node:assert/strict'
import net from 'node:net'
import { after, before, describe, test } from 'node:test'
import * as encoding from 'lib0/encoding'
import WebSocket from 'ws'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import { isAllowedUpdate } from '../src/protocol.js'
import { client, requestWithHost, roomId, sleep, start, synced, testConfig, until, type Running } from './helpers.js'

/** Sends raw bytes so the request line can contain what fetch would refuse to send. */
function rawRequest(port: number, requestLine: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.end(`${requestLine}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`)
    })
    let data = ''
    socket.on('data', (chunk) => (data += chunk))
    socket.on('end', () => resolve(data.split('\r\n')[0]))
    socket.on('error', reject)
  })
}

function syncUpdateMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0)
  syncProtocol.writeUpdate(encoder, update)
  return encoding.toUint8Array(encoder)
}

/** An awareness message for `clientId`; a high clock lets it win over the real owner's state. */
function awarenessMessage(state: Record<string, unknown>, clientId: number, clock = 1000): Uint8Array {
  const awareness = new awarenessProtocol.Awareness(new Y.Doc())
  awareness.clientID = clientId
  awareness.setLocalState(state)
  awareness.meta.set(clientId, { clock, lastUpdated: Date.now() })
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 1)
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, [clientId]))
  awareness.destroy()
  return encoding.toUint8Array(encoder)
}

function rawSocket(url: string): Promise<{ ws: WebSocket; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const closed = new Promise<number>((done) => ws.on('close', (code) => done(code)))
    ws.on('open', () => resolve({ ws, closed }))
    ws.on('error', reject)
  })
}

describe('security', () => {
  let server: Running
  before(async () => {
    server = await start(testConfig())
  })
  after(() => server.stop())

  test('malformed URLs are rejected without crashing the server', async () => {
    const port = Number(new URL(server.http).port)
    assert.match(await rawRequest(port, 'GET // HTTP/1.1'), / 400 /)
    assert.match(await rawRequest(port, 'DELETE /api/rooms/%E0 HTTP/1.1'), / 40\d /)
    const upgrade = await requestWithHost(`${server.http}/ws/%E0`, '127.0.0.1', {
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
    })
    assert.equal(upgrade.status, 400)
    assert.equal((await fetch(`${server.http}/healthz`)).status, 200)
  })

  test('responses carry security headers', async () => {
    const res = await fetch(`${server.http}/healthz`)
    assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self'/)
    assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.get('x-frame-options'), 'DENY')
  })

  test('only plain text in "code" and short settings in "meta" are accepted', () => {
    const ok = new Y.Doc()
    ok.getText('code').insert(0, 'hello')
    ok.getMap('meta').set('language', 'Python')
    assert.equal(isAllowedUpdate(Y.encodeStateAsUpdate(ok)), true)

    const otherRoot = new Y.Doc()
    otherRoot.getText('elsewhere').insert(0, 'x'.repeat(1000))
    assert.equal(isAllowedUpdate(Y.encodeStateAsUpdate(otherRoot)), false)

    const unknownKey = new Y.Doc()
    unknownKey.getMap('meta').set('payload', 'x')
    assert.equal(isAllowedUpdate(Y.encodeStateAsUpdate(unknownKey)), false)

    const nested = new Y.Doc()
    nested.getMap('meta').set('language', new Y.Map() as never)
    assert.equal(isAllowedUpdate(Y.encodeStateAsUpdate(nested)), false)

    const longValue = new Y.Doc()
    longValue.getMap('meta').set('language', 'x'.repeat(1000))
    assert.equal(isAllowedUpdate(Y.encodeStateAsUpdate(longValue)), false)

    assert.equal(isAllowedUpdate(new Uint8Array([1, 2, 3, 4])), false)
  })

  test('a connection writing to another shared type is closed and nothing is stored', async () => {
    const room = roomId()
    const watcher = client(server.ws, room)
    await synced(watcher)
    const { ws, closed } = await rawSocket(`${server.ws}/${room}`)
    const attack = new Y.Doc()
    attack.getArray('junk').insert(0, ['x'.repeat(10_000)])
    ws.send(syncUpdateMessage(Y.encodeStateAsUpdate(attack)))
    assert.equal(await closed, 1008)
    await sleep(100)
    assert.equal(watcher.doc.share.has('junk'), false)
    watcher.destroy()
  })

  test('presence is sanitised: colours, unknown fields and the viewer flag', async () => {
    const room = roomId()
    const watcher = client(server.ws, room)
    await synced(watcher)
    const { ws } = await rawSocket(`${server.ws}/${room}`)
    const attacker = 424242
    ws.send(
      awarenessMessage(
        { user: { name: 'Mallory', color: 'red;background:url(https://evil.example/x)', viewer: true }, extra: 'x' },
        attacker,
      ),
    )
    await until(() => watcher.provider.awareness.getStates().has(attacker), 'state relayed')
    // The unsafe colour never reaches anyone: the user field is dropped entirely.
    assert.equal((watcher.provider.awareness.getStates().get(attacker) as Record<string, unknown>).user, undefined)

    // A newer clock replaces the previous state.
    ws.send(awarenessMessage({ user: { name: 'Mallory', color: '#ff0000', viewer: true }, extra: 1 }, attacker, 1001))
    await until(
      () => (watcher.provider.awareness.getStates().get(attacker) as { user?: { color?: string } })?.user?.color === '#ff0000',
      'valid colour relayed',
    )
    const state = watcher.provider.awareness.getStates().get(attacker) as Record<string, unknown>
    assert.equal(state.extra, undefined)
    // An editor connection can't claim to be a viewer (and vice versa).
    assert.equal((state.user as { viewer: boolean }).viewer, false)
    ws.close()
    watcher.destroy()
  })

  test("a connection cannot overwrite someone else's presence", async () => {
    const room = roomId()
    const alice = client(server.ws, room)
    const watcher = client(server.ws, room)
    await Promise.all([synced(alice), synced(watcher)])
    alice.provider.awareness.setLocalStateField('user', { name: 'Alice', color: '#00ff00' })
    await until(() => (watcher.provider.awareness.getStates().get(alice.doc.clientID) as { user?: { name?: string } })?.user?.name === 'Alice', 'Alice visible')

    const { ws } = await rawSocket(`${server.ws}/${room}`)
    ws.send(awarenessMessage({ user: { name: 'Fake Alice', color: '#000000' } }, alice.doc.clientID))
    await sleep(200)
    const name = (watcher.provider.awareness.getStates().get(alice.doc.clientID) as { user?: { name?: string } })?.user?.name
    assert.equal(name, 'Alice')
    ws.close()
    alice.destroy()
    watcher.destroy()
  })
})

describe('client IPs behind a proxy', () => {
  test('the right-most X-Forwarded-For entry is used, so a forged one cannot dodge limits', async () => {
    const server = await start(testConfig({ trustProxy: true, limits: { maxNewRoomsPerHour: 1 } }))
    try {
      const open = (forged: string) =>
        new Promise<number>((resolve) => {
          const ws = new WebSocket(`${server.ws}/${roomId()}`, { headers: { 'x-forwarded-for': `${forged}, 203.0.113.7` } })
          ws.on('close', (code) => resolve(code))
          ws.on('message', () => {
            ws.close(1000)
          })
        })
      assert.equal(await open('1.1.1.1'), 1000)
      // A different forged first entry, same real address: still rate limited.
      assert.equal(await open('2.2.2.2'), 4429)
    } finally {
      await server.stop()
    }
  })
})
