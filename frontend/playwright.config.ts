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
  // **한 워커.** 스펙 전체가 `webServer` 백엔드 **하나**를 공유하고, 그 안에는 전역
  // 상태가 세 종류나 있다: 캡처 큐(행 개수·"N of N done" 요약이 전부 전역),
  // `FakeHogaplayClient` 의 실패 주입 카운터(프로세스 싱글턴), 그리고 디스크 픽스처
  // (`HOGA_DATA_DIR`). 병렬로 돌리면 서로의 행을 세고(실측: 3 을 기대한 자리에서 20),
  // 남의 픽스처를 덮어쓰고(complete 자리에 partial), 남의 캡처가 카운터를 소모한다.
  //
  // `fullyParallel` 은 그대로 둔다 — 워커가 1이면 실질 효과는 없지만, 나중에 백엔드를
  // 스펙별로 격리하면 이 줄만 되돌리면 된다. 직렬 실행 비용은 실측 ~30초다.
  workers: 1,
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
      use: {
        ...devices['Desktop Chrome'],
        // **로컬은 시스템 Chrome, CI 는 번들 chromium.**
        //
        // Playwright 는 Ubuntu 26.04 를 지원 목록에 두지 않아
        // `npx playwright install chromium` 이 거부한다
        // (`ERROR: Playwright does not support chromium on ubuntu26.04-x64`).
        // 그래서 "CI 가 유일한 판정 경로" 라고 적혀 있었지만, 스펙 11개 중 7개는
        // 이미 `test.use({ channel: 'chrome' })` 로 시스템 Chrome 을 쓰고 있었다 —
        // 즉 막혀 있던 건 나머지 4개뿐이었고, 그 결정을 설정으로 올리면 전부 로컬에서
        // 돈다. 실패를 CI 왕복(회당 ~4분) 없이 재현할 수 있는 게 훨씬 중요하다.
        //
        // CI 에서는 번들 chromium 을 유지한다. 러너에 미리 깔린 Chrome 은 이미지마다
        // 버전이 달라지지만 번들 chromium 은 playwright 패키지에 고정돼 있어서,
        // **판정 기준**은 재현 가능한 쪽이어야 한다.
        ...(process.env.CI ? {} : { channel: 'chrome' as const }),
      },
    },
  ],
  // 픽스처 Stock-Date 시딩. README 의 "Remaining gating #1" 이 이것이었다 —
  // 없으면 스펙이 종목을 못 골라, 실패가 회귀인지 데이터 부재인지 구분되지 않는다.
  globalSetup: './tests/e2e/global-setup.ts',
  webServer: [
    {
      // `HOGA_RATE_LIMIT_S=0` 필수 — 캡처 한 건이 페이지 ~1,300회를 도는데
      // (수집기 커서가 페이지마다 60000 씩만 전진한다) 기본 0.15초를 곱하면 190초다.
      // 페이크는 실제 업스트림이 아니므로 유량을 지킬 이유가 없다.
      command: 'cd .. && HOGA_ENABLE_TEST_ENDPOINTS=1 HOGA_RATE_LIMIT_S=0 HOGA_DATA_DIR=/tmp/hoga-e2e-data uv run hoga serve --port 8765',
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
