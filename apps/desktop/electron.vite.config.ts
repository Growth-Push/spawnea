import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@spawnea/domain', '@spawnea/db', '@spawnea/hosts', '@spawnea/state'] })],
    build: {
      rollupOptions: {
        external: ['better-sqlite3', 'ssh2', 'cpu-features', 'node-pty'],
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'spawnea-mcp': resolve(__dirname, 'src/mcp/index.ts'),
          'spawnea-mcp-watchdog': resolve(__dirname, 'src/mcp/watchdog.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@spawnea/domain'] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
  },
});
