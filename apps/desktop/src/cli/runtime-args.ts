import { resolve } from 'node:path';
import { resolveControlRuntimeFileCandidates } from '../main/control-runtime.js';
import { parseProfileFromArgs } from '../main/product-paths.js';

export function runtimeFilesFromArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const index = argv.indexOf('--runtime-file');
  if (index !== -1) {
    const value = argv[index + 1];
    if (!value) throw new Error('--runtime-file requires a path');
    return [resolve(value)];
  }
  const profile = parseProfileFromArgs(argv, env);
  return resolveControlRuntimeFileCandidates(env, profile);
}
