import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
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
          if (id.includes('/src/heatmap/')) return 'heatmap';
          if (id.includes('/src/studyViews/')) return 'study-views';
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
  // PROTOTYPE (#762) — 워크트리 도그푸딩용. 백엔드 CORS 가 :5173 만 허용해서
  // 다른 포트로 띄우면 API 가 전부 막힌다. 동일 출처로 프록시해 우회한다.
  // 폐기 전제 — 프로토타입 브랜치와 함께 버린다.
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true, changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
})
