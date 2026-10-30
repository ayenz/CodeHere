import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

// E2E_TARGET=cloudflare runs the same tests against `wrangler dev` (cloudflare/), where the
// editor and the admin page are two Workers on two ports, like their two workers.dev hosts.
const cloudflare = process.env.E2E_TARGET === 'cloudflare'
const PORT = cloudflare ? 8787 : 3199
const ADMIN_PORT = cloudflare ? 8788 : PORT
// Chromium resolves *.localhost to the loopback address, so no DNS setup is needed.
export const ADMIN_URL = cloudflare ? `http://localhost:${ADMIN_PORT}` : `http://admin.localhost:${PORT}`

const dataDir = mkdtempSync(join(tmpdir(), 'codehere-e2e-'))
// A private wrangler dev registry: the admin Worker finds the editor's Durable Objects through
// it, and stale entries left by earlier (killed) sessions would otherwise break that lookup.
const wranglerEnv = { WRANGLER_REGISTRY_PATH: join(dataDir, 'wrangler-registry') }
// Fresh Durable Object storage per run, like the fresh SQLite file for the Node target; otherwise
// rate-limit counters (e.g. failed admin sign-ins) carry over from earlier runs.
const persist = `--persist-to ${join(dataDir, 'wrangler-state')}`

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // Optional: point at an installed Chromium-based browser instead of Playwright's download.
    launchOptions: process.env.E2E_BROWSER ? { executablePath: process.env.E2E_BROWSER } : {},
    trace: 'retain-on-failure',
  },
  // Both targets run the production client build, so `npm run build` must have run first.
  webServer: cloudflare
    ? [
        {
          command: `npx wrangler dev -c wrangler.jsonc --port 8787 --ip 127.0.0.1 ${persist} --var MAX_DOC_CHARS:5000 --var MAX_NEW_ROOMS_PER_HOUR:0`,
          cwd: '../cloudflare',
          url: 'http://127.0.0.1:8787/healthz',
          reuseExistingServer: false,
          timeout: 120_000,
          env: wranglerEnv,
        },
        {
          // The admin Worker binds to the editor's Durable Objects, so it must start second.
          command:
            `until curl -sf http://127.0.0.1:8787/healthz > /dev/null; do sleep 1; done; npx wrangler dev -c admin.wrangler.jsonc --port 8788 --ip 127.0.0.1 ${persist} ` +
            '--var ADMIN_PASSWORD:e2e-admin --var SESSION_SECRET:e2e-session-secret-0123456789abcdef --var PUBLIC_URL:http://localhost:8787 --var MAX_DOC_CHARS:5000',
          cwd: '../cloudflare',
          url: 'http://127.0.0.1:8788/healthz',
          reuseExistingServer: false,
          timeout: 120_000,
          env: wranglerEnv,
        },
      ]
    : {
        command: 'node server/dist/index.js',
        cwd: '..',
        url: `http://127.0.0.1:${PORT}/healthz`,
        reuseExistingServer: false,
        env: {
          PORT: String(PORT),
          HOST: '127.0.0.1',
          SQLITE_PATH: join(dataDir, 'e2e.db'),
          ADMIN_PASSWORD: 'e2e-admin',
          ADMIN_HOST: 'admin.localhost',
          MAX_DOC_CHARS: '5000',
          PERSIST_DEBOUNCE_MS: '100',
        },
      },
})
