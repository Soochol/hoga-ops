/// <reference types="node" />
import { defineConfig, devices } from '@playwright/test';

/**
 * E2E specs in this folder are GATED on Phase 6+ wiring (ChartStage +
 * CursorSidebarConnected mounted in Workarea), backend fixture extension
 * (>=2 captured Stock-Dates), and `data-*` attributes on chart panes /
 * sidebar cards. See `tests/e2e/README.md` for the wiring checklist.
 *
 * Excluded from default vitest runs by file naming (`*.spec.ts` vs
 * vitest's `*.test.{ts,tsx}` pattern); only Playwright loads this
 * directory.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'list' : 'html',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'cd .. && HOGA_ENABLE_TEST_ENDPOINTS=1 HOGA_DATA_DIR=/tmp/hoga-e2e-data uv run hoga serve --port 8765',
      url: 'http://127.0.0.1:8765/health',
      timeout: 30_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npm run dev -- --port 5173',
      url: 'http://127.0.0.1:5173',
      timeout: 30_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
