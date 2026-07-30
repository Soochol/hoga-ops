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
    // **5173 이 아니라 5174.** 5173 은 사람이 쓰는 개발 서버 자리다 —
    // CI 에서는 `reuseExistingServer: !CI` 라 playwright 가 직접 띄우는데,
    // 로컬에서 그대로 돌리면 사용자의 vite 와 충돌하거나(포트 점유) 더 나쁘게는
    // 사용자 서버에 붙어 e2e 가 **다른 데이터**를 보고 통과해 버린다.
    // 5174 는 app.py 의 ALLOWED_ORIGINS 에 이미 있어 CORS 를 그대로 통과한다.
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5174',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // 픽스처 Stock-Date 시딩. README 의 "Remaining gating #1" 이 이것이었다 —
  // 없으면 스펙이 종목을 못 골라, 실패가 회귀인지 데이터 부재인지 구분되지 않는다.
  globalSetup: './tests/e2e/global-setup.ts',
  webServer: [
    {
      command: 'cd .. && HOGA_ENABLE_TEST_ENDPOINTS=1 HOGA_DATA_DIR=/tmp/hoga-e2e-data uv run hoga serve --port 8765',
      url: 'http://127.0.0.1:8765/health',
      timeout: 120_000,  // CI 첫 실행은 uv 가 파이썬·의존성을 받는다(실측 ~6s, 여유)
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // E2E_API_URL 이 vite 의 /config.json 미들웨어를 켠다(vite.config.ts).
      // public/config.json 은 8000 을 가리키므로 이게 없으면 프론트가 사용자의
      // 개발 서버로 붙어 버린다 — 로컬에서는 "그럭저럭 통과" 하고 CI 에서만
      // 깨지는, 가장 진단하기 나쁜 형태가 된다.
      // `--host 127.0.0.1` 이 필수다. vite 기본 host 는 `localhost` 인데, CI 처럼
      // localhost 가 ::1 로 먼저 풀리는 환경에서는 IPv6 에만 바인딩될 수 있다.
      // 그러면 아래 url(IPv4) 폴링이 영원히 실패하고 "Timed out waiting 60000ms"
      // 만 남는다 — 2026-07-30 첫 CI 실행이 정확히 그렇게 죽었다. 백엔드는
      // `hoga serve` 가 host="127.0.0.1" 을 하드코딩해서 같은 문제를 안 겪었고,
      // 그 비대칭이 원인을 가리켰다.
      command: 'E2E_API_URL=http://127.0.0.1:8765 npm run dev -- --host 127.0.0.1 --port 5174 --strictPort',
      url: 'http://127.0.0.1:5174',
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      // 기본값은 'ignore' 라 vite 출력이 통째로 사라진다. 첫 실행에서 실패 원인을
      // 못 본 이유가 이것이다 — uvicorn 은 stderr 로 써서 보였고 vite 는 stdout 이라
      // 안 보였다. 진단 신호를 버리지 않는다.
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
