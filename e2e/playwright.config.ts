import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

const PORT = 3199
const dataDir = mkdtempSync(join(tmpdir(), 'codehere-e2e-'))

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
  // Runs the production build, so `npm run build` must have run first.
  webServer: {
    command: 'node server/dist/index.js',
    cwd: '..',
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      SQLITE_PATH: join(dataDir, 'e2e.db'),
      ADMIN_PASSWORD: 'e2e-admin',
      MAX_DOC_CHARS: '5000',
      PERSIST_DEBOUNCE_MS: '100',
    },
  },
})
