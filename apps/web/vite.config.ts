import { defineConfig } from 'vite';

const API = process.env.CRUMPLE_API ?? 'http://localhost:8787';

export default defineConfig({
  appType: 'spa',
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/x402': { target: API, changeOrigin: true },
      '/ws': { target: API.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'] },
      },
    },
  },
});
