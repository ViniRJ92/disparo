import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const webDir = import.meta.dirname;

export default defineConfig({
  root: webDir,
  plugins: [react()],
  build: {
    outDir: resolve(webDir, '..', 'dist', 'web'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:3333' },
  },
});
