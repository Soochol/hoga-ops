import { defineConfig } from '../../../frontend/node_modules/@playwright/test/index.mjs';
import { FRONTEND_PORT, BASE_URL, API_URL } from '../../../frontend/tests/e2e/worktreeEnv';
import { fileURLToPath } from 'node:url';
const frontend = fileURLToPath(new URL('../../../frontend', import.meta.url));
export default defineConfig({
  testDir: `${frontend}/tests/e2e`, testMatch: /(chart-scrollbar-jitter|live-crosshair-persistence)\.spec\.ts$/,
  workers: 1, reporter: 'list', outputDir: `/tmp/hoga-scrollbar-${FRONTEND_PORT}`,
  use: { channel: 'chrome', baseURL: BASE_URL, screenshot: 'only-on-failure' },
  webServer: { command: `npm exec vite -- --host 127.0.0.1 --port ${FRONTEND_PORT} --strictPort`,
    cwd: frontend, url: BASE_URL, reuseExistingServer: false, env: { E2E_API_URL: API_URL } },
});
