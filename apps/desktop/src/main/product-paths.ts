import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const MAX_PROFILE_NAME_LENGTH = 32;

export function sanitizeProfileName(profile: string): string {
  const trimmed = profile.trim();
  if (!trimmed) {
    throw new Error('Profile name cannot be empty');
  }
  if (trimmed.length > MAX_PROFILE_NAME_LENGTH) {
    throw new Error(`Profile name '${profile}' exceeds maximum length of ${MAX_PROFILE_NAME_LENGTH} characters`);
  }
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9_-]*[a-zA-Z0-9])?$/.test(trimmed)) {
    throw new Error(`Invalid profile name '${profile}'. Must start and end with an alphanumeric character and contain only letters, numbers, hyphens, and underscores.`);
  }
  return trimmed;
}

export function parseProfileFromArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--profile') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error('--profile requires a profile name');
      }
      return sanitizeProfileName(next);
    }
    if (arg.startsWith('--profile=')) {
      const val = arg.slice('--profile='.length);
      return sanitizeProfileName(val);
    }
  }
  if (env.SPAWNEA_PROFILE?.trim()) {
    return sanitizeProfileName(env.SPAWNEA_PROFILE);
  }
  return undefined;
}

export function resolveActiveCatalogPath(
  userDataDir: string,
  appDataDir: string,
  isNamedProfile: boolean,
  hasExplicitUserDataDir: boolean,
  exists: (path: string) => boolean = existsSync,
): string {
  const profileCatalogPath = join(userDataDir, 'config.yaml');
  const baseCatalogPath = join(appDataDir, 'spawnea', 'config.yaml');
  if (isNamedProfile && !hasExplicitUserDataDir) {
    if (!exists(profileCatalogPath) && exists(baseCatalogPath)) {
      return baseCatalogPath;
    }
  }
  return profileCatalogPath;
}

export function resolveSpawneaUserDataPath(
  appDataDirectory: string,
  _derivedUserDataPath: string,
  explicitPath?: string,
  profile?: string,
): string {
  if (explicitPath?.trim()) return resolve(explicitPath);
  const appData = resolve(appDataDirectory);
  if (profile?.trim()) {
    const sanitized = sanitizeProfileName(profile);
    return join(appData, 'spawnea', 'profiles', sanitized);
  }
  return join(appData, 'spawnea');
}
