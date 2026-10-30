// End-to-end check against a running server: two clients edit the same room,
// then a third client joins later and must receive the saved document.
//   node scripts/smoke.mjs [ws://localhost:3000/ws]
import WebSocket from 'ws'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'

const url = process.argv[2] ?? 'ws://localhost:3000/ws'
const room = `smoke-${Date.now().toString(36)}`

function client() {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(url, room, doc, { WebSocketPolyfill: WebSocket })
  const synced = new Promise((resolve) => provider.once('sync', resolve))
  return { doc, provider, text: doc.getText('code'), synced }
}

function until(check, label, timeout = 5000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve()
      if (Date.now() - started > timeout) return reject(new Error(`Timed out: ${label}`))
      setTimeout(tick, 25)
    }
    tick()
  })
}

const a = client()
const b = client()
await Promise.all([a.synced, b.synced])

a.text.insert(0, 'hello')
await until(() => b.text.toString() === 'hello', 'B receives A')
b.text.insert(5, ' world')
a.text.insert(0, '> ')
await until(() => a.text.toString() === b.text.toString() && a.text.length === 13, 'concurrent edits converge')
console.log(`converged: ${JSON.stringify(a.text.toString())}`)

a.provider.awareness.setLocalStateField('user', { name: 'A', color: '#f59e0b' })
await until(() => b.provider.awareness.getStates().get(a.doc.clientID)?.user?.name === 'A', 'awareness reaches B')
console.log('awareness ok')

const expected = a.text.toString()
a.provider.destroy()
b.provider.destroy()

// Give the server time to persist after the last client leaves, then rejoin.
await new Promise((resolve) => setTimeout(resolve, 500))
const c = client()
await c.synced
await until(() => c.text.toString() === expected, 'late joiner loads saved doc')
console.log('persistence ok')
c.provider.destroy()
process.exit(0)
