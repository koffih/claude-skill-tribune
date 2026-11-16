import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// The base is a placeholder the server swaps for its real sub-path at start.
export default defineConfig({
  root: 'web',
  base: '/__TRIBUNE_BASE__/',
  plugins: [preact()],
  css: { postcss: {} },                 // no config lookup up the tree
  build: { outDir: '../dist/web', emptyOutDir: true, assetsDir: 'assets', sourcemap: false },
});
