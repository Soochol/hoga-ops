import type { Plugin } from 'vite'
import base from './vite.config'

// 워크트리 도그푸딩 전용(비커밋) — 5175 에서 서빙하고 /api·/health 를 8000 으로
// 프록시(same-origin 화)해 백엔드 CORS(:5173 전용)를 우회한다.
function sameOriginConfigJson(): Plugin {
  return {
    name: 'dogfood-config-json',
    configureServer(server) {
      server.middlewares.use('/config.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ api_url: '' }))
      })
    },
  }
}

export default {
  ...base,
  plugins: [...(base as { plugins: Plugin[] }).plugins, sameOriginConfigJson()],
  server: {
    port: 5175,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true, ws: true },
      '/health': { target: 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
}
