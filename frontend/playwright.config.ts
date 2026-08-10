/// <reference types="node" />
import { defineConfig, devices } from '@playwright/test';
import {
  API_URL, BACKEND_PORT, BASE_URL, DATA_DIR, DIST_DIR, FRONTEND_PORT, describeWorktreeEnv,
} from './tests/e2e/worktreeEnv';

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
// 실행마다 한 줄. **포트가 상수가 아니게 됐으므로 어디로 도는지 눈에 보여야 한다** —
// 서버가 뜨기도 전에 죽는 경우까지 덮으려면 globalSetup 이 아니라 여기가 맞다.
console.log(`[e2e] ${describeWorktreeEnv()}`);

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.ts$/,
  // **한 워커.** 스펙 전체가 `webServer` 백엔드 **하나**를 공유하고, 그 안에는 전역
  // 상태가 세 종류나 있다: 캡처 큐(행 개수·"N of N done" 요약이 전부 전역),
  // `FakeHogaplayClient` 의 실패 주입 카운터(프로세스 싱글턴), 그리고 디스크 픽스처
  // (`HOGA_DATA_DIR`). 병렬로 돌리면 서로의 행을 세고(실측: 3 을 기대한 자리에서 20),
  // 남의 픽스처를 덮어쓰고(complete 자리에 partial), 남의 캡처가 카운터를 소모한다.
  //
  // **이건 한 실행 *안*의 병렬만 막는다.** 실행 *간* — 병행 세션이 각자 워크트리에서
  // 동시에 돌리는 것 — 은 자원 자체를 갈라야 막힌다. 그래서 포트·데이터·dist 를
  // 워크트리 경로에서 파생시킨다(`tests/e2e/worktreeEnv.ts`).
  //
  // `fullyParallel` 은 그대로 둔다 — 워커가 1이면 실질 효과는 없지만, 나중에 백엔드를
  // 스펙별로 격리하면 이 줄만 되돌리면 된다. 직렬 실행 비용은 실측 ~30초다.
  workers: 1,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'list' : 'html',
  use: {
    // **사람이 쓰는 5173 은 절대 쓰지 않는다** — 거기 붙으면 e2e 가 사용자 서버의
    // **다른 데이터**를 보고 통과해 버린다. 예전에는 그 자리를 5174 로 피했는데,
    // 그건 상수라 워크트리끼리 다시 겹쳤다. 지금은 워크트리마다 파생된다
    // (`worktreeEnv.ts`). 상수 5174 가 주던 이점(app.py 의 ALLOWED_ORIGINS 에 이미
    // 있음)은 아래 `HOGA_ALLOWED_ORIGINS` 로 대체한다.
    baseURL: BASE_URL,
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
      //
      // dist-smoke(ADR-0134) 전제 두 가지가 serve 앞에 붙는다:
      //  - `vite build && prepare-dist.mjs` — HOGA_FRONTEND_DIST 는 기동 시점에
      //    디렉터리를 검사하므로(오설정이 조용히 404 가 되지 않게) globalSetup
      //    에서는 늦다. 사본(DIST_DIR)에 same-origin config.json 을 쓴다. **이 사본도
      //    워크트리마다 갈라야 한다** — 포트만 나누면 남의 실행 중에 `vite build` 가
      //    같은 디렉터리를 덮는다.
      //  - `HOGA_ALLOWED_ORIGINS` — same-origin 이어도 브라우저는 WS/POST 에 Origin
      //    을 붙이고, 가드는 명시 목록만 믿는다(Sec-Fetch-Site 추론은 DNS rebinding
      //    사유로 기각 — origin_guard.py). 예전엔 백엔드 origin 하나면 됐다. 프론트
      //    포트가 상수 5174 여서 `app.py` 의 정적 목록에 이미 있었기 때문인데, 이제
      //    파생되므로 **프론트 origin 도 여기서 넘긴다**(localhost·127.0.0.1 둘 다 —
      //    baseURL 은 127.0.0.1 이지만 앱이 어느 쪽으로 호스트를 적든 통과하게).
      command: `npx vite build && node tests/e2e/prepare-dist.mjs && cd .. && uv run hoga serve --port ${BACKEND_PORT}`,
      // **자격증명을 비워 띄운다(ADR-0134 무자격 관례).**
      //
      // `HOGA_DATA_DIR` 은 데이터만 격리하고 `.env` 는 격리하지 않는다 — 워크트리엔
      // `.env` 가 없어 메인 체크아웃 것을 상속하므로, 이 서버는 **사용자 dev 서버와
      // 같은 실앱키**로 토큰을 발급해 왔다. 토큰 캐시는 data_dir 아래라 분리돼 있고,
      // 반복 실행 절차가 데이터 디렉터리 삭제를 요구하므로 **매 기동이 캐시
      // 미스**다. 그 발급이 새 토큰을 찍으면 벤더가 이전 토큰을 죽인다 — 2026-08-04
      // 에 사용자 dev 서버(:8000)의 과거 캔들이 통째로 멎은 원인이 이것이다
      // (앱키 4개 중 2개가 `8005:Token이 유효하지 않습니다` 로 전환).
      //
      // 스펙 14개가 타는 백엔드 경로는 `/api/test/*` · `/api/watchlist*` · `/api/ws`
      // 뿐이라 **실벤더 경로가 하나도 없다.** 빈 값이면 `_resolve_env_creds` 가 None
      // 을 돌려 키움/KIS 경로가 통째로 휴면한다(`if not app_key or not app_secret`).
      // `load_dotenv(override=False)` 는 **존재 여부**로 판단하므로 빈 문자열이 .env
      // 를 확실히 막는다(truthiness 가 아니다).
      //
      // account 0 만 비워도 `configured_account_ids` 가 첫 공백에서 멈추지만, 넷을
      // 다 비운다 — 계정을 직접 지정해 부르는 경로가 생겨도 새지 않게.
      env: {
        KIWOOM_APP_KEY: '', KIWOOM_APP_SECRET: '',
        KIWOOM_APP_KEY_2: '', KIWOOM_APP_SECRET_2: '',
        KIWOOM_APP_KEY_3: '', KIWOOM_APP_SECRET_3: '',
        KIWOOM_APP_KEY_4: '', KIWOOM_APP_SECRET_4: '',
        KIS_APP_KEY: '', KIS_APP_SECRET: '',
        // 커맨드 인라인이 아니라 여기 두는 이유: `E2E_DIST_DIR` 은 `prepare-dist.mjs`
        // 가, 나머지는 `hoga serve` 가 읽는데 둘이 같은 커맨드 체인에 있어서
        // 한 자리에 모으는 편이 파생값을 빠뜨릴 여지가 적다.
        HOGA_ENABLE_TEST_ENDPOINTS: '1',
        HOGA_RATE_LIMIT_S: '0',
        HOGA_DATA_DIR: DATA_DIR,
        HOGA_FRONTEND_DIST: DIST_DIR,
        E2E_DIST_DIR: DIST_DIR,
        HOGA_ALLOWED_ORIGINS: [
          API_URL,
          BASE_URL,
          `http://localhost:${FRONTEND_PORT}`,
        ].join(','),
      },
      url: `${API_URL}/health`,
      timeout: 120_000,  // CI 첫 실행은 uv 의존성 + vite build 까지 포함(여유)
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
      command: `npm run dev -- --host 127.0.0.1 --port ${FRONTEND_PORT} --strictPort`,
      env: { E2E_API_URL: API_URL },
      url: BASE_URL,
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
