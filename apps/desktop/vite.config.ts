import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

export default defineConfig({
  base: './',
  plugins: [react()],
  root: path.join(desktopRoot, 'src', 'renderer'),
  build: {
    outDir: path.join(desktopRoot, 'dist', 'renderer'),
    emptyOutDir: true,
  },
});
