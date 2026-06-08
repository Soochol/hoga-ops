// throwaway verify config — delete after verification
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: { port: 5178, strictPort: true, proxy: { '/api': 'http://localhost:8000', '/ws': { target: 'http://localhost:8000', ws: true } } },
});
