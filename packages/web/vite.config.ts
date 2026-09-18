import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Dev-only: the API runs as a separate process on 7070. In production the
    // same Express server serves this bundle, so no proxy is involved.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7070',
        changeOrigin: true,
        // SSE must not be buffered by the dev proxy.
        ws: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
