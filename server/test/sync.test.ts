import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { client, roomId, start, synced, testConfig, until, type Running } from './helpers.js'

describe('sync', () => {
  let server: Running
  before(async () => {
    server = await start(testConfig())
  })
  after(() => server.stop())

  test('concurrent edits converge and presence reaches others', async () => {
    const room = roomId()
    const a = client(server.ws, room)
    const b = client(server.ws, room)
    await Promise.all([synced(a), synced(b)])

    a.text.insert(0, 'hello')
    await until(() => b.text.toString() === 'hello', 'B receives A')
    b.text.insert(5, ' world')
    a.text.insert(0, '> ')
    await until(() => a.text.toString() === b.text.toString() && a.text.length === 13, 'edits converge')

    a.provider.awareness.setLocalStateField('user', { name: 'A' })
    await until(
      () => b.provider.awareness.getStates().get(a.doc.clientID)?.user?.name === 'A',
      'awareness reaches B',
    )
    a.destroy()
    b.destroy()
  })

  test('a room unloaded from memory is restored from the database', async () => {
    const room = roomId()
    const a = client(server.ws, room)
    await synced(a)
    a.text.insert(0, 'persist me')
    await until(() => server.app.rooms.activeRoomIds().includes(room), 'room active')
    a.destroy()
    await until(() => !server.app.rooms.activeRoomIds().includes(room), 'room unloaded')

    const b = client(server.ws, room)
    await synced(b)
    await until(() => b.text.toString() === 'persist me', 'B loads saved text')
    b.destroy()
  })

  test('rooms survive a server restart', async () => {
    const config = testConfig()
    const first = await start(config)
    const room = roomId()
    const a = client(first.ws, room)
    await synced(a)
    a.text.insert(0, 'still here')
    await until(() => first.app.rooms.activeRoomIds().includes(room), 'room active')
    a.destroy()
    await first.stop()

    const second = await start(config)
    const b = client(second.ws, room)
    await synced(b)
    await until(() => b.text.toString() === 'still here', 'text after restart')
    b.destroy()
    await second.stop()
  })

  test('"admin" is an ordinary room name', async () => {
    const a = client(server.ws, 'admin')
    await synced(a)
    a.text.insert(0, 'not the admin page')
    await until(() => server.app.rooms.activeRoomIds().includes('admin'), 'room "admin" opened')
    a.destroy()
  })

  test('reserved and malformed room IDs are rejected', async () => {
    for (const path of ['api', 'assets', 'ab', 'bad%20id']) {
      const status = await fetch(`${server.http}/ws/${path}`, {
        headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
      })
        .then((res) => res.status)
        .catch(() => 400)
      assert.equal(status, 400, path)
    }
  })
})
