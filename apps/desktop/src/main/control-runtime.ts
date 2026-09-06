import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export function resolveControlRuntimeDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SPAWNEA_CONTROL_RUNTIME_DIR) return resolve(env.SPAWNEA_CONTROL_RUNTIME_DIR);
  if (env.XDG_RUNTIME_DIR) return join(resolve(env.XDG_RUNTIME_DIR), 'spawnea');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return join(tmpdir(), `spawnea-${uid}`);
}

export function resolveControlRuntimeFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SPAWNEA_CONTROL_RUNTIME_FILE) return resolve(env.SPAWNEA_CONTROL_RUNTIME_FILE);
  return join(resolveControlRuntimeDirectory(env), 'control-runtime.json');
}

export function resolveControlSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SPAWNEA_CONTROL_SOCKET) return resolve(env.SPAWNEA_CONTROL_SOCKET);
  return join(resolveControlRuntimeDirectory(env), 'control.sock');
}

export function resolveControlRuntimeFileCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.SPAWNEA_CONTROL_RUNTIME_FILE || env.SPAWNEA_CONTROL_RUNTIME_DIR) {
    return [resolveControlRuntimeFile(env)];
  }

  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  const candidates = [
    env.XDG_RUNTIME_DIR
      ? join(resolve(env.XDG_RUNTIME_DIR), 'spawnea', 'control-runtime.json')
      : undefined,
    typeof process.getuid === 'function'
      ? join('/run/user', String(uid), 'spawnea', 'control-runtime.json')
      : undefined,
    join(tmpdir(), `spawnea-${uid}`, 'control-runtime.json'),
  ];

  return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate)))];
}
