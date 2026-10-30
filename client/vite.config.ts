import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite'

// Mirrors the server's routing in development: on ADMIN_HOST every page is the admin page,
// on any other host every page is the editor (so "/admin" is an ordinary room).
function adminHostRoute(adminHost: string): Plugin {
  const rewrite: Connect.NextHandleFunction = (req, _res, next) => {
    const host = (req.headers.host ?? '').split(':')[0].toLowerCase()
    const path = req.url ?? '/'
    const isPage =
      req.method === 'GET' && !/^\/(@|src\/|node_modules\/|assets\/|api\/|ws\/)|\.[a-z0-9]+(\?|$)/i.test(path)
    if (isPage) req.url = host === adminHost ? '/admin.html' : '/index.html'
    next()
  }
  return {
    name: 'codehere-admin-host',
    configureServer: (server) => void server.middlewares.use(rewrite),
    configurePreviewServer: (server) => void server.middlewares.use(rewrite),
  }
}

export default defineConfig(({ mode }) => {
  // Shares the server's .env so ADMIN_HOST is configured once (admin.localhost in development).
  const env = loadEnv(mode, fileURLToPath(new URL('..', import.meta.url)), '')
  const adminHost = (env.ADMIN_HOST || 'admin.localhost').toLowerCase().split(':')[0]
  const serverPort = env.PORT || '3000'

  return {
    plugins: [adminHostRoute(adminHost)],
    server: {
      port: 5173,
      proxy: {
        '/ws': { target: `ws://localhost:${serverPort}`, ws: true },
        // Keeps the Host header, which the server uses to tell the admin host apart.
        '/api': { target: `http://localhost:${serverPort}`, changeOrigin: false },
      },
    },
    build: {
      target: 'es2022',
      outDir: 'dist',
      rollupOptions: {
        input: {
          main: fileURLToPath(new URL('./index.html', import.meta.url)),
          admin: fileURLToPath(new URL('./admin.html', import.meta.url)),
        },
        output: {
          manualChunks: {
            editor: ['codemirror', '@codemirror/state', '@codemirror/view', '@codemirror/language'],
            collab: ['yjs', 'y-websocket', 'y-codemirror.next'],
          },
        },
      },
    },
  }
})
