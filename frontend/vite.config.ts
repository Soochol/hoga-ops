import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'

/**
 * e2e 전용 `/config.json` 재정의.
 *
 * `public/config.json` 은 `http://localhost:8000`(사용자 개발 서버)을 가리키는데,
 * Playwright 는 백엔드를 **워크트리마다 파생된 포트**로 띄운다(tests/e2e/worktreeEnv.ts;
 * 예전에는 8765 상수였다). 이 불일치가 e2e 를 CI 에 못 걸던
 * 두 이유 중 하나였다(다른 하나는 globalSetup 부재).
 *
 * 정적 파일을 덮어쓰지 않고 미들웨어로 가로챈다 — `public/config.json` 을
 * 수정하면 사용자의 평소 개발 흐름이 깨지고, globalSetup 에서 임시로 썼다가
 * 되돌리면 테스트가 중단됐을 때 잘못된 값이 남는다.
 *
 * CORS 는 이미 통과한다(app.py 의 ALLOWED_ORIGINS 에 localhost:5173 이 있다).
 * 그래서 프록시가 아니라 절대 URL 로 충분하다.
 */
function e2eConfigJson(): Plugin {
  return {
    name: 'hoga-e2e-config-json',
    apply: 'serve',
    configureServer(server) {
      const apiUrl = process.env.E2E_API_URL
      if (!apiUrl) return
      server.middlewares.use('/config.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ api_url: apiUrl }))
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  /**
   * dep 사전번들 캐시를 `node_modules` **밖에** 둔다.
   *
   * 기본값은 `node_modules/.vite` 인데, 이 리포의 병행 세션 중에는 워크트리의
   * `frontend/node_modules` 를 메인 체크아웃으로 **심볼릭 링크**하는 것이 있다
   * (2026-09-07 에 `.codex/worktrees/3564` 가 그랬다 — `_metadata.json` inode 동일).
   * 그러면 두 워크트리의 vite 가 **같은 `deps` 디렉터리를 공유**한다.
   *
   * 공유 자체보다 나쁜 것은 **깨지는 방식**이다. 나중에 뜬 서버가 자기 소스 트리
   * 기준으로 재최적화해 디렉터리를 덮어써도, 먼저 뜬 서버는 **메모리에 옛 판본의
   * `?v=` 해시를 쥔 채** 계속 돈다. vite 는 `.vite/deps/*` 를 `immutable`(1년)로
   * 내려보내므로 `?v=` 가 그대로면 브라우저는 옛 바디를 영구히 쓴다 — 앱 셸은 A
   * 판본 React 로 돌고, 그때까지 캐시에 없던 dep 만 새로 받아 **B 판본 React** 를
   * 끌어온다. 실제 증상은 `/screener` 가 `Cannot read properties of null (reading
   * 'useReducer')` 로 죽는 것이었다: `@tanstack/react-virtual` 은 `ResultTable`
   * (스크리너)과 `CaptureQueue`(캡처)에서만 쓰여 `/live` 경로에서 캐시된 적이 없는
   * 유일한 dep 이고, `useVirtualizerBase` 의 첫 훅이 하필 `React.useReducer` 다.
   * 새로고침으로는 낫지 않는다(`immutable` 이라 조건부 요청조차 안 간다).
   *
   * `node_modules` 는 링크될 수 있어도 `frontend/` 자체는 워크트리마다 실재하므로,
   * 캐시를 여기로 빼면 그 분열이 원리적으로 불가능해진다.
   *
   * ⚠ **막지 못하는 축이 하나 있다** — 같은 체크아웃에서 vite 를 두 번 띄우면
   * (5173 이 잡혀 5174 로 폴백) 여전히 같은 `cacheDir` 을 공유한다. 판별식은
   * 「`deps` 의 mtime 이 dev 서버 기동 시각보다 늦다」와 「스택에서 렌더러 청크와
   * 훅을 부른 청크의 파일명이 다르다」이고, 복구는 `vite --force` 재기동이다.
   */
  cacheDir: '.vite-cache',
  plugins: [react(), e2eConfigJson()],
  build: {
    // 기본 500KB. `live-workspace` 는 eager 라우트(`/live`) 자신의 청크이고,
    // heatmap·studyViews 를 그룹에서 뺀 뒤 `/live` 가 실제로 쓰는 모듈이 여기로
    // 흡수된다. 이 경고를 끄는 게 아니라 임계를 실제 최대 청크보다 약간 위로 올려,
    // 여기서 더 커지면 다시 알려 주도록 남긴다.
    //
    // ⚠ **이건 개별 청크만 본다 — 초기 로드 합계를 보는 것은 아무것도 없다**
    // (2026-08-25 에 `scripts/initialLoadBudget.ts` 를 사용자 결정으로 제거했다).
    // 합계를 다시 재게 된다면 **측정 정의부터 코드로 고정할 것**: 종전 기준선
    // 「1071 KB」는 **JS 전용** 수치였는데 나중에 잰 JS+CSS 값과 직접 비교돼
    // 「+159 KB 회귀」라는 없는 사고를 만들었다(like-for-like 는 +111 KB, 그중 절반은
    // 의도된 폰트 self-host).
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        /**
         * ⚠ **`manualChunks` 는 Vite 8(rolldown)에서 동작하지 않았다** — 스캐폴드 때부터
         * 한 번도. `package.json` 의 `"vite": "^8.0.12"` 는 2026-05-20 부터 그대로이고,
         * 2026-06-28 의 분할도 2026-07-30 의 −18% 실측도 전부 이 상태에서 측정됐다
         * (업그레이드로 깨진 게 아니라 처음부터 무효였다).
         *
         * 증상은 조용했다: 빌드가 **아무 경고도 안 내고** 청크 파일명만 남는다. 그래서
         * `react-*.js` 가 184 B 인 채로 `dnd-*.js`(186 KB) 안에 react-dom 129 KB 가
         * 들어 있었다 — **파일명이 내용과 달랐다.** 2026-08-16 성능 감사가 이 이름을
         * 그대로 믿고 "@dnd-kit 186 KB 를 lazy 로 내리자" 는 결론을 냈다가 소스맵으로
         * 귀속을 재고서야 실제 @dnd-kit 이 46.9 KB 임을 알았다(4배 오독).
         *
         * `codeSplitting.groups` 가 정식 API 다(`advancedChunks` 는 같은 모양이지만
         * deprecated 경고를 낸다 — rolldown 1.0.3 타입 정의 확인). 경로 구분자는
         * 플랫폼 중립으로 `[\\/]` 를 쓴다(rolldown 문서 권고).
         *
         * **이 수정은 초기 로드 바이트를 줄이지 않는다 — 오히려 늘린다**(청크 경계
         * 보일러플레이트). 그럼에도 하는 이유 둘:
         *   ① **계측 정직성** — 이름이 내용과 같아야 다음 감사가 오독하지 않는다.
         *   ② **재방문 캐시** — 종전엔 `react-router`(41 KB)와 `@tanstack/query-core`
         *      (26 KB)가 앱 코드 전체가 든 `live-workspace` 안에 있어서, `src/live/*`
         *      를 한 줄만 고쳐도 그 67 KB 가 매 배포마다 다시 내려갔다. 벤더를 자기
         *      청크로 빼면 그 재다운로드가 사라진다(첫 방문 +, 이후 배포 −).
         *
         * ⚠ **이 소속을 검사하는 것은 이제 아무것도 없다**(2026-08-25, 위 예산 플러그인과
         * 함께 제거). 이 규칙이 다시 조용히 죽어도 빌드는 통과한다 — 청크 파일명을
         * 근거로 무언가를 판단하기 전에 **소스맵으로 귀속을 재확인할 것**. 위 4배
         * 오독이 정확히 그 절차를 건너뛴 결과다.
         */
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 40 },
            { name: 'router', test: /node_modules[\\/]react-router[\\/]/, priority: 39 },
            { name: 'query', test: /node_modules[\\/]@tanstack[\\/]/, priority: 38 },
            { name: 'charts', test: /node_modules[\\/](lightweight-charts|fancy-canvas)[\\/]/, priority: 37 },
            { name: 'dnd', test: /node_modules[\\/]@dnd-kit[\\/]/, priority: 36 },
            // heatmap·studyViews 는 **의도적으로 그룹에서 뺀다**(2026-07-30).
            //
            // 경로로 묶으면 그 디렉터리의 한 파일이라도 정적 도달 시 청크 전체가
            // modulepreload 로 끌려온다. `/live` 는 실제로 몇 모듈을 쓴다 —
            // LivePage→heatmap/CollectDialog, TitleBarSymbolRow→heatmap/{useHeatmap,heat},
            // ChartWindow→studyViews/LiveStudyViewSaveButton, state/studyTabs→
            // studyViews/studyViewSelection. 그래서 라우트·드로어를 lazy 로 내려도
            // heatmap 214KB + study-views 72KB 가 초기 로드에 그대로 남았다.
            //
            // 자동 분할은 **실제 도달성**으로 나눈다: lazy 라우트에서만 닿는 모듈은 그
            // 라우트 청크로, eager 그래프와 공유되는 모듈은 공용 청크로 간다. 여기서는
            // 수동 규칙이 문제의 원인이었으므로 규칙을 빼는 것이 수정이다.
            { name: 'live-workspace', test: /[\\/]src[\\/](live|chart|sidebar)[\\/]/, priority: 10 },
          ],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    exclude: ['node_modules', 'dist', 'tests/e2e/**'],
  },
  server: { port: 5173 },
})
