import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { client, roomId, start, synced, testConfig, until, type Running } from './helpers.js'

const HEADERS = { 'x-requested-with': 'codehere', 'content-type': 'application/json' }

describe('admin API', () => {
  let server: Running
  let cookie = ''

  async function api(path: string, init: RequestInit = {}) {
    return fetch(`${server.http}/api/admin${path}`, {
      ...init,
      headers: { ...HEADERS, cookie, ...(init.headers as Record<string, string>) },
    })
  }

  before(async () => {
    server = await start(testConfig({ adminPassword: 'correct horse' }))
  })
  after(() => server.stop())

  test('is disabled without ADMIN_PASSWORD', async () => {
    const disabled = await start(testConfig())
    const res = await fetch(`${disabled.http}/api/admin/session`)
    assert.equal(res.status, 404)
    await disabled.stop()
  })

  test('requires a session and the CSRF header', async () => {
    assert.equal((await fetch(`${server.http}/api/admin/stats`)).status, 401)
    const noHeader = await fetch(`${server.http}/api/admin/login`, { method: 'POST', body: '{"password":"x"}' })
    assert.equal(noHeader.status, 403)
  })

  test('rejects a wrong password and accepts the right one', async () => {
    const wrong = await api('/login', { method: 'POST', body: JSON.stringify({ password: 'nope' }) })
    assert.equal(wrong.status, 401)
    const right = await api('/login', { method: 'POST', body: JSON.stringify({ password: 'correct horse' }) })
    assert.equal(right.status, 204)
    const setCookie = right.headers.get('set-cookie') ?? ''
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /SameSite=Strict/)
    cookie = setCookie.split(';')[0]
    assert.equal((await api('/session')).status, 200)
  })

  test('reports stats and lists, shows, locks and deletes rooms', async () => {
    const room = roomId()
    const editor = client(server.ws, room)
    await synced(editor)
    editor.doc.getMap('meta').set('language', 'Python')
    editor.text.insert(0, 'print("hi")')
    await until(() => server.app.rooms.activeRoomIds().includes(room), 'room active')
    // Wait for the debounced save so the room is in the database.
    await until(() => false, 'save', 200).catch(() => {})

    const stats = await (await api('/stats')).json()
    assert.ok(stats.totalRooms >= 1)
    assert.ok(stats.connections >= 1)

    const list = await (await api(`/rooms?q=${room}`)).json()
    assert.equal(list.total, 1)
    assert.equal(list.rooms[0].id, room)
    assert.equal(list.rooms[0].online, 1)
    assert.ok(list.rooms[0].sizeBytes > 0)

    const detail = await (await api(`/rooms/${room}`)).json()
    assert.equal(detail.text, 'print("hi")')
    assert.equal(detail.language, 'Python')

    assert.equal((await api(`/rooms/${room}/lock`, { method: 'POST', body: '{"locked":true}' })).status, 204)
    await until(() => editor.statuses.some((s) => s.locked === true), 'editor sees lock')

    assert.equal((await api(`/rooms/${room}`, { method: 'DELETE' })).status, 204)
    await until(() => editor.closeCodes.includes(4404), 'editor disconnected')
    assert.equal((await api(`/rooms/${room}`)).status, 404)
    assert.equal((await api(`/rooms/${room}`, { method: 'DELETE' })).status, 404)
    editor.destroy()
  })

  test('limits login attempts', async () => {
    let last = 0
    for (let i = 0; i < 6; i++) {
      last = (await api('/login', { method: 'POST', body: '{"password":"nope"}' })).status
    }
    assert.equal(last, 429)
  })

  test('signing out ends the session', async () => {
    assert.equal((await api('/logout', { method: 'POST' })).status, 204)
    assert.equal((await api('/session')).status, 401)
  })
})
