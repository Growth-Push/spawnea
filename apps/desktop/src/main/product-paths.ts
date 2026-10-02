import { existsSync } from 'node:fs';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

export const MAX_PROFILE_NAME_LENGTH = 32;

export function sanitizeProfileName(profile: string, platform: NodeJS.Platform = process.platform): string {
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
  const canonical = trimmed.toLowerCase();
  if (platform === 'win32' && /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(canonical)) {
    throw new Error(`Invalid profile name '${profile}'. Windows device names are reserved.`);
  }
  return canonical;
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

export async function initializeActiveCatalogPath(
  userDataDir: string,
  appDataDir: string,
  isNamedProfile: boolean,
  hasExplicitUserDataDir: boolean,
  publishCatalog: typeof link = link,
): Promise<string> {
  const profileCatalogPath = join(userDataDir, 'config.yaml');
  if (!isNamedProfile || hasExplicitUserDataDir || existsSync(profileCatalogPath)) {
    return profileCatalogPath;
  }

  let baseCatalog: Buffer;
  try {
    baseCatalog = await readFile(join(appDataDir, 'spawnea', 'config.yaml'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return profileCatalogPath;
    throw error;
  }

  await mkdir(userDataDir, { recursive: true, mode: 0o700 });
  const tempPath = join(userDataDir, `.config-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, baseCatalog, { flag: 'wx', mode: 0o600 });
    // Publish the complete copy atomically without replacing an existing catalog.
    await publishCatalog(tempPath, profileCatalogPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    await unlink(tempPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
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
