import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { client, roomId, sleep, start, synced, testConfig, until } from './helpers.js'

describe('read-only links and locks', () => {
  test('editors learn the view link; viewers can read but not edit', async () => {
    const server = await start(testConfig())
    const room = roomId()
    const editor = client(server.ws, room)
    await synced(editor)
    editor.text.insert(0, 'secret plan')
    await until(() => editor.statuses.length > 0, 'editor status')
    const status = editor.statuses[0]
    assert.equal(status.readOnly, false)
    assert.equal(typeof status.viewId, 'string')

    const viewer = client(`${server.ws}/v`, String(status.viewId))
    await synced(viewer)
    await until(() => viewer.text.toString() === 'secret plan', 'viewer reads text')
    await until(() => viewer.statuses.length > 0, 'viewer status')
    assert.equal(viewer.statuses[0].readOnly, true)
    assert.equal(viewer.statuses[0].viewId, undefined, 'viewers must not learn the view ID mapping')

    viewer.text.insert(0, 'HACKED ')
    await sleep(200)
    assert.equal(editor.text.toString(), 'secret plan')

    editor.destroy()
    viewer.destroy()
    await server.stop()
  })

  test('an unknown view link is refused', async () => {
    const server = await start(testConfig())
    const viewer = client(`${server.ws}/v`, 'doesNotExist1')
    await until(() => viewer.closeCodes.includes(4404), 'closed with 4404')
    viewer.destroy()
    await server.stop()
  })

  test('a locked room rejects edits from everyone', async () => {
    const server = await start(testConfig())
    const room = roomId()
    const a = client(server.ws, room)
    const b = client(server.ws, room)
    const intruder = client(server.ws, room)
    try {
      await Promise.all([synced(a), synced(b), synced(intruder)])
      a.text.insert(0, 'before lock')
      await until(() => b.text.toString() === 'before lock', 'B synced')

      assert.equal(await server.app.rooms.setLocked(room, true), true)
      await until(() => a.statuses.some((s) => s.locked === true && s.readOnly === true), 'A told about the lock')
      // Real clients stop editing when locked; a client that ignores that is simply not heard.
      intruder.text.insert(0, 'X')
      await sleep(200)
      assert.equal(b.text.toString(), 'before lock')
      intruder.destroy()

      await server.app.rooms.setLocked(room, false)
      await until(() => a.statuses.some((s) => s.locked === false && s.readOnly === false), 'A told about unlock')
      a.text.insert(a.text.length, '!')
      await until(() => b.text.toString() === 'before lock!', 'edits flow after unlock')
    } finally {
      a.destroy()
      b.destroy()
      intruder.destroy()
      await server.stop()
    }
  })
})

describe('limits', () => {
  test('all limits are off by default', () => {
    const { limits } = testConfig()
    for (const [name, value] of Object.entries(limits)) assert.equal(value, 0, name)
  })

  test('edits beyond MAX_DOC_CHARS are reverted for everyone', async () => {
    const server = await start(testConfig({ limits: { maxDocChars: 20 } }))
    const room = roomId()
    const a = client(server.ws, room)
    const b = client(server.ws, room)
    await Promise.all([synced(a), synced(b)])
    a.text.insert(0, 'short')
    await until(() => b.text.toString() === 'short', 'small edit accepted')

    a.text.insert(5, ' and a lot more text that is too long')
    await until(() => a.statuses.some((s) => s.error === 'doc-too-large'), 'A told about the limit')
    await until(() => a.text.toString() === 'short' && b.text.toString() === 'short', 'oversized edit reverted')

    a.destroy()
    b.destroy()
    await server.stop()
  })

  test('MAX_CONNECTIONS_PER_IP refuses extra connections', async () => {
    const server = await start(testConfig({ limits: { maxConnectionsPerIp: 1 } }))
    const room = roomId()
    const a = client(server.ws, room)
    await synced(a)
    const b = client(server.ws, room)
    await until(() => b.closeCodes.includes(4429), 'second connection refused')
    a.destroy()
    b.destroy()
    await server.stop()
  })

  test('MAX_NEW_ROOMS_PER_HOUR limits new rooms but not existing ones', async () => {
    const server = await start(testConfig({ limits: { maxNewRoomsPerHour: 1 } }))
    const first = client(server.ws, roomId())
    await synced(first)
    const second = client(server.ws, roomId())
    await until(() => second.closeCodes.includes(4429), 'second new room refused')
    first.destroy()
    second.destroy()
    await server.stop()
  })
})
