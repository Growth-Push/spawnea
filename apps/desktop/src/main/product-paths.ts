import { join, resolve } from 'node:path';

export function resolveSpawneaUserDataPath(
  appDataDirectory: string,
  _derivedUserDataPath: string,
  explicitPath?: string,
): string {
  if (explicitPath?.trim()) return resolve(explicitPath);
  const appData = resolve(appDataDirectory);
  return join(appData, 'spawnea');
}
