import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { sanitizeProfileName } from './product-paths.js';

export function resolveControlRuntimeDirectory(
  env: NodeJS.ProcessEnv = process.env,
  profile?: string,
): string {
  const rawProfile = profile?.trim() || env.SPAWNEA_PROFILE?.trim() || undefined;
  const activeProfile = rawProfile ? sanitizeProfileName(rawProfile) : undefined;
  if (env.SPAWNEA_CONTROL_RUNTIME_DIR) {
    const base = resolve(env.SPAWNEA_CONTROL_RUNTIME_DIR);
    return activeProfile ? join(base, 'profiles', activeProfile) : base;
  }
  if (env.XDG_RUNTIME_DIR) {
    const base = join(resolve(env.XDG_RUNTIME_DIR), 'spawnea');
    return activeProfile ? join(base, 'profiles', activeProfile) : base;
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return join(tmpdir(), activeProfile ? `spawnea-${uid}-${activeProfile}` : `spawnea-${uid}`);
}


export function resolveControlRuntimeFile(
  env: NodeJS.ProcessEnv = process.env,
  profile?: string,
): string {
  if (env.SPAWNEA_CONTROL_RUNTIME_FILE) return resolve(env.SPAWNEA_CONTROL_RUNTIME_FILE);
  return join(resolveControlRuntimeDirectory(env, profile), 'control-runtime.json');
}

export function resolveControlSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  profile?: string,
): string {
  if (env.SPAWNEA_CONTROL_SOCKET) return resolve(env.SPAWNEA_CONTROL_SOCKET);
  return join(resolveControlRuntimeDirectory(env, profile), 'control.sock');
}

export function resolveControlRuntimeFileCandidates(
  env: NodeJS.ProcessEnv = process.env,
  profile?: string,
): string[] {
  if (env.SPAWNEA_CONTROL_RUNTIME_FILE || env.SPAWNEA_CONTROL_RUNTIME_DIR) {
    return [resolveControlRuntimeFile(env, profile)];
  }

  const rawProfile = profile?.trim() || env.SPAWNEA_PROFILE?.trim() || undefined;
  const activeProfile = rawProfile ? sanitizeProfileName(rawProfile) : undefined;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  const candidates = [
    env.XDG_RUNTIME_DIR
      ? (activeProfile
          ? join(resolve(env.XDG_RUNTIME_DIR), 'spawnea', 'profiles', activeProfile, 'control-runtime.json')
          : join(resolve(env.XDG_RUNTIME_DIR), 'spawnea', 'control-runtime.json'))
      : undefined,
    typeof process.getuid === 'function'
      ? (activeProfile
          ? join('/run/user', String(uid), 'spawnea', 'profiles', activeProfile, 'control-runtime.json')
          : join('/run/user', String(uid), 'spawnea', 'control-runtime.json'))
      : undefined,
    join(tmpdir(), activeProfile ? `spawnea-${uid}-${activeProfile}` : `spawnea-${uid}`, 'control-runtime.json'),
  ];

  return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate)))];
}
