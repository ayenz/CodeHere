import { createApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig()
const app = await createApp(config)

app.server.listen(config.port, config.host, () => {
  console.log(`[server] listening on http://${config.host}:${config.port} (db: ${config.dbDriver})`)
  if (config.adminPassword && config.adminHost) console.log(`[server] admin enabled on host ${config.adminHost}`)
  else if (config.adminPassword) console.warn('[server] admin disabled: ADMIN_PASSWORD is set but ADMIN_HOST is not')
  else console.log('[server] admin disabled (set ADMIN_PASSWORD and ADMIN_HOST)')
  if (config.trustProxy && (config.host === '0.0.0.0' || config.host === '::')) {
    console.warn(
      '[server] TRUST_PROXY is on while listening on all interfaces: make sure only your proxy can reach this port, ' +
        'or clients can fake their IP and host.',
    )
  }
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
