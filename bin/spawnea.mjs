#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(currentDir, '..');
const bundledCli = join(repoRoot, 'apps/desktop/out/main/spawnea-cli.js');
const sourceCli = join(repoRoot, 'apps/desktop/src/cli/index.ts');

if (!existsSync(bundledCli)) {
  console.error('Spawnea CLI is not built. Please run `pnpm build` first.');
  process.exit(1);
}

const { runCli } = await import(bundledCli);
runCli(process.argv.slice(2)).catch((err) => {
  console.error(`spawnea error: ${err.message || String(err)}`);
  process.exit(1);
});
