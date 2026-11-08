import { defineConfig } from 'vite';

// Relative base keeps the static build portable (GitHub Pages, S3, a USB stick).
export default defineConfig({
  base: './',
  server: {
    host: true,
    port: 5173,
  },
  preview: {
    host: true,
    port: 4173,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
