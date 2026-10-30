import { createApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig()
const app = await createApp(config)

app.server.listen(config.port, config.host, () => {
  console.log(`[server] listening on http://${config.host}:${config.port} (db: ${config.dbDriver})`)
  console.log(`[server] admin ${config.adminPassword ? 'enabled at /admin' : 'disabled (set ADMIN_PASSWORD)'}`)
})

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[server] ${signal} received, saving rooms…`)
  // server.close waits for open HTTP keep-alive sockets; don't let that block exit forever.
  setTimeout(() => process.exit(1), 10_000).unref()
  await app.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
