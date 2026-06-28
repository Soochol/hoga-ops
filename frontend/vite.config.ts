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
  server: { port: 5173 },
})
