import { defineConfig } from '@playwright/test'
// These suites intercept every API request; no database or API server is needed.
export default defineConfig({
  testDir: './tests',
  testMatch: [
    'connector-workspace.spec.ts',
    'project-picker.spec.ts',
    'layout.spec.ts',
    'shadcn.spec.ts',
  ],
  outputDir: '.cache/connector-workspace-e2e',
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:5175',
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm dev --port 5175 --strictPort',
    url: 'http://localhost:5175/login',
    reuseExistingServer: false,
  },
})
