/// <reference types='vitest' />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/testapp',
  server: {
    port: 4200,
    host: 'localhost',
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    port: 4200,
    host: 'localhost',
    headers: crossOriginIsolationHeaders,
  },
  plugins: [react()],
  optimizeDeps: {
    force: true,
  },
  // Uncomment this if you are using workers.
  // worker: {
  //  plugins: [],
  // },
  build: {
    outDir: './dist',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
}));
