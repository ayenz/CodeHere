import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { client, roomId, start, synced, testConfig, until } from './helpers.js'

describe('room owners', () => {
  test('only the creator token can delete a room', async () => {
    const server = await start(testConfig())
    const room = roomId()
    const creator = client(server.ws, room, { owner: 'creator-secret' })
    try {
      await synced(creator)
      creator.text.insert(0, 'mine')
      // A later visitor's token never replaces the owner.
      const visitor = client(server.ws, room, { owner: 'visitor-secret' })
      await synced(visitor)

      const del = (token: string) =>
        fetch(`${server.http}/api/rooms/${room}`, {
          method: 'DELETE',
          headers: { 'x-requested-with': 'codehere', 'x-owner-token': token },
        }).then((res) => res.status)

      assert.equal(await del('visitor-secret'), 403)
      assert.equal(await del(''), 403)
      assert.equal(await del('creator-secret'), 204)
      await until(() => visitor.closeCodes.includes(4404), 'visitor disconnected')
      assert.equal(await del('creator-secret'), 404)
      visitor.destroy()
    } finally {
      creator.destroy()
      await server.stop()
    }
  })

  test('the owner survives the room being unloaded and saved', async () => {
    const server = await start(testConfig())
    const room = roomId()
    try {
      const creator = client(server.ws, room, { owner: 'tok' })
      await synced(creator)
      creator.text.insert(0, 'saved')
      await until(() => server.app.rooms.activeRoomIds().includes(room), 'active')
      creator.destroy()
      await until(() => !server.app.rooms.activeRoomIds().includes(room), 'unloaded')
      assert.equal(await server.app.rooms.isOwner(room, 'tok'), true)
      assert.equal(await server.app.rooms.isOwner(room, 'other'), false)
    } finally {
      await server.stop()
    }
  })
})
