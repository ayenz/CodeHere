import { fileURLToPath } from 'node:url'
import { defineConfig, type Connect, type Plugin } from 'vite'

// Serve /admin as admin.html in dev and preview (production routing is the server's job).
const rewriteAdmin: Connect.NextHandleFunction = (req, _res, next) => {
  if (req.method === 'GET' && req.url && /^\/admin\/?(\?|$)/.test(req.url)) {
    req.url = req.url.replace(/^\/admin\/?/, '/admin.html')
  }
  next()
}

const adminRoute: Plugin = {
  name: 'codehere-admin-route',
  configureServer(server) {
    server.middlewares.use(rewriteAdmin)
  },
  configurePreviewServer(server) {
    server.middlewares.use(rewriteAdmin)
  },
}

export default defineConfig({
  plugins: [adminRoute],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:3000', ws: true },
      '/api': { target: 'http://localhost:3000' },
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
})
