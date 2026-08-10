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
  plugins: [react(), e2eConfigJson()],
  build: {
    // 기본 500KB. `live-workspace` 는 eager 라우트(`/live`) 자신의 청크이고,
    // heatmap·studyViews 수동 그룹을 뺀 뒤 `/live` 가 실제로 쓰는 모듈이 여기로
    // 흡수돼 637KB 가 됐다. 추적하는 지표는 개별 청크 크기가 아니라 **초기 로드
    // 합계**이고 그건 1303KB → 1071KB 로 줄었다(실측 2026-07-30, dist/index.html
    // 의 modulepreload 집합). 이 경고를 끄는 게 아니라 임계를 실제 최대 청크보다
    // 약간 위로 올려, 여기서 더 커지면 다시 알려 주도록 남긴다.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react')
            || id.includes('node_modules/react-dom')
            || id.includes('node_modules/react-router')) return 'react';
          if (id.includes('node_modules/@tanstack/react-query')) return 'query';
          if (id.includes('node_modules/lightweight-charts')) return 'charts';
          if (id.includes('node_modules/@dnd-kit')) return 'dnd';
          if (id.includes('/src/live/')
            || id.includes('/src/chart/')
            || id.includes('/src/sidebar/')) return 'live-workspace';
          // heatmap·studyViews 는 **의도적으로 수동 그룹에서 뺐다**(2026-07-30).
          //
          // 경로로 묶으면 그 디렉터리의 한 파일이라도 정적 도달 시 청크 전체가
          // modulepreload 로 끌려온다. `/live` 는 실제로 몇 모듈을 쓴다 —
          // LivePage→heatmap/CollectDialog, TitleBarSymbolRow→heatmap/{useHeatmap,heat},
          // ChartWindow→studyViews/LiveStudyViewSaveButton, state/studyTabs→
          // studyViews/studyViewSelection. 그래서 라우트·드로어를 lazy 로 내려도
          // heatmap 214KB + study-views 72KB 가 초기 로드에 그대로 남았다.
          //
          // Rollup 의 자동 분할은 **실제 도달성**으로 나눈다: lazy 라우트에서만 닿는
          // 모듈은 그 라우트 청크로, eager 그래프와 공유되는 모듈은 공용 청크로 간다.
          // 여기서는 수동 규칙이 문제의 원인이었으므로 규칙을 빼는 것이 수정이다.
          return undefined;
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
