import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// Standalone diagnosis, without a backend or the user's application state.
export default defineConfig({
  testDir: '../../e2e',
  testMatch: 'wheel-viewport-preservation.spec.ts',
  workers: 1,
  reporter: 'list',
  outputDir: '../../../test-results/wheel-teleport-diagnostic',
  use: { baseURL: 'http://127.0.0.1:5297', channel: 'chrome' },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5297 --strictPort',
    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    env: { E2E_API_URL: 'http://127.0.0.1:59999' },
    url: 'http://127.0.0.1:5297',
    reuseExistingServer: false,
  },
});
