import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  base: './',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    modulePreload: false,
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      input: {
        sidepanel: resolve(rootDir, 'src/ui/sidepanel.html'),
        'service-worker': resolve(rootDir, 'src/extension/service-worker.ts'),
      },
      output: {
        format: 'es',
        entryFileNames: (chunkInfo) =>
          chunkInfo.name === 'service-worker' ? 'service-worker.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
