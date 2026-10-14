// Focused wheel QA uses real charts and mocked HTTP responses. No backend or
// vendor credentials are needed. Uses the repository's worktree-specific port.
import { defineConfig, devices } from '../../../frontend/node_modules/@playwright/test/index.mjs';
import { FRONTEND_PORT, BASE_URL, API_URL } from '../../../frontend/tests/e2e/worktreeEnv';
import { fileURLToPath } from 'node:url';

const frontend = fileURLToPath(new URL('../../../frontend', import.meta.url));
export default defineConfig({
  testDir: `${frontend}/tests/e2e`,
  testMatch: /wheel-(pixel-anchor|viewport-preservation|backfill-integration)\.spec\.ts$/,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: `/tmp/hoga-wheel-qa-${FRONTEND_PORT}-results.json` }]],
  outputDir: `/tmp/hoga-wheel-qa-${FRONTEND_PORT}`,
  use: { ...devices['Desktop Chrome'], ...(process.env.CI ? {} : { channel: 'chrome' }),
    baseURL: BASE_URL, screenshot: 'only-on-failure' },
  webServer: {
    command: `npm exec vite -- --host 127.0.0.1 --port ${FRONTEND_PORT} --strictPort`,
    cwd: frontend, url: BASE_URL, reuseExistingServer: false,
    env: { E2E_API_URL: API_URL },
  },
});
