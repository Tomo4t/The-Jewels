import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const API_TARGET = process.env.VITE_API_TARGET || 'http://localhost:3000';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(process.cwd(), 'index.html'),
        admin: resolve(process.cwd(), 'admin.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // The Express server owns the API and the writable content directory.
      '/api': { target: API_TARGET, changeOrigin: true },
      '/content': { target: API_TARGET, changeOrigin: true },
    },
  },
});
