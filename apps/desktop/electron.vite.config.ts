import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { Plugin } from 'vite';
// Only the parser, bundled with this config: the package entry imports the
// YAML with a Vite-only suffix.
import { parseStateRules } from '../../packages/state/src/rules/rule-config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const FACTORY_STATE_RULES = resolve(__dirname, '../../packages/state/src/rules/state-rules.yaml');

/** Fails the build when the bundled factory state rules are invalid. */
function validateFactoryStateRules(): Plugin {
  return {
    name: 'spawnea-validate-factory-state-rules',
    buildStart() {
      this.addWatchFile(FACTORY_STATE_RULES);
      parseStateRules(readFileSync(FACTORY_STATE_RULES, 'utf8'), 'state-rules.yaml (factory)', 'factory');
    },
  };
}

export default defineConfig({
  main: {
    plugins: [
      validateFactoryStateRules(),
      externalizeDepsPlugin({ exclude: ['@spawnea/domain', '@spawnea/db', '@spawnea/hosts', '@spawnea/state'] }),
    ],
    build: {
      rollupOptions: {
        external: ['electron', 'better-sqlite3', 'ssh2', 'cpu-features', 'node-pty'],
        input: {
          index: resolve(__dirname, 'src/main/entry.ts'),
          'spawnea-control-watchdog': resolve(__dirname, 'src/main/control-watchdog-entry.ts'),
          'spawnea-cli': resolve(__dirname, 'src/cli/index.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@spawnea/domain'] })],
    build: {
      rollupOptions: {
        external: ['electron'],
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
        },
        output: {
          format: 'cjs',
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
