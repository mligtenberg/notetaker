/// <reference types='vitest' />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/notetaker',
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
    include: [
      '@huggingface/transformers',
    ],
    entries: [
      'src/main.tsx',
      'src/app/engine.worker.ts',
    ],
    worker: {
      include: [
        '@huggingface/transformers',
        '@notetaker/engine',
        '@notetaker/model-manager',
        '@notetaker/filesystem',
      ],
    },
  },
  worker: {
    format: 'module',
    plugins: () => [react()],
  },
  build: {
    outDir: './dist',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
}));
