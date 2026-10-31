import { defineConfig } from '@playwright/test'
if (!process.env.E2E_DATABASE_URL)
  throw new Error(
    'Set E2E_DATABASE_URL to a migrated, isolated PostgreSQL test database',
  )
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: 'http://localhost:5174',
    viewport: { width: 1793, height: 1376 },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --filter @kloud/api dev',
      cwd: '../..',
      url: 'http://localhost:3100/health',
      env: {
        DATABASE_URL: process.env.E2E_DATABASE_URL,
        PUBLIC_ORIGIN: 'http://localhost:5174',
        WEBAUTHN_RP_ID: 'localhost',
        PORT: '3100',
        PLATFORM_ENCRYPTION_KEY: 'ab'.repeat(32),
      },
      reuseExistingServer: false,
    },
    {
      command: 'pnpm dev --port 5174 --strictPort',
      url: 'http://localhost:5174/login',
      env: { API_PROXY_TARGET: 'http://localhost:3100' },
      reuseExistingServer: false,
    },
  ],
})
