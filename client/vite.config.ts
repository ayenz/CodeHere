import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          editor: ['codemirror', '@codemirror/state', '@codemirror/view', '@codemirror/language'],
          collab: ['yjs', 'y-websocket', 'y-codemirror.next'],
        },
      },
    },
  },
})
