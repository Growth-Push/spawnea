import { constants, existsSync } from 'node:fs';
import { access, chmod, lstat, mkdir, readFile, readlink, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface CliPathStatus {
  installed: boolean;
  targetPath: string;
  symlinkPath: string;
  isValid: boolean;
  isInPath?: boolean;
  pathInstruction?: string;
  error?: string;
}

export interface CliPathInstallerOptions {
  homeDirectory?: string;
  customExecutablePath?: string;
  appPath?: string;
  resourcesPath?: string;
  appImagePath?: string;
  isPackaged?: boolean;
  platform?: NodeJS.Platform;
  pathEnv?: string;
}

export function getAppImageLauncherPath(homeDirectory?: string): string {
  const home = homeDirectory ?? (typeof homedir === 'function' ? homedir() : '/tmp');
  return join(home, '.local', 'share', 'spawnea', 'spawnea-launcher');
}

/**
 * Resolves the location of the spawnea CLI executable.
 * In packaged Electron apps, it lives in `resourcesPath/spawnea`.
 * In AppImage Linux builds, it targets a persistent launcher script.
 * In development, it resolves to `bin/spawnea.mjs` relative to the workspace root or app directory.
 */
export function resolveSpawneaCliExecutable(options: CliPathInstallerOptions = {}): string {
  if (options.customExecutablePath) {
    return resolve(options.customExecutablePath);
  }

  // 1. AppImage build: persistent launcher targeting the AppImage binary
  const appImage = options.appImagePath ?? (typeof process !== 'undefined' ? process.env.APPIMAGE : undefined);
  if (appImage) {
    return getAppImageLauncherPath(options.homeDirectory);
  }

  // 2. Packaged Electron app extraResource (exclude temporary mount paths like /.mount_)
  const resourcesPath = options.resourcesPath ?? (typeof process !== 'undefined' ? (process as any).resourcesPath : undefined);
  if (resourcesPath && !resourcesPath.includes('/.mount_')) {
    const candidate = join(resourcesPath, 'spawnea');
    if (existsSync(candidate)) return candidate;
  }

  if (options.isPackaged) {
    return join(resourcesPath ?? options.appPath ?? '.', 'spawnea');
  }

  // 3. Development: root bin/spawnea.mjs or compiled entry layout (e.g. apps/desktop/out/main)
  const appPath = options.appPath ?? (typeof process !== 'undefined' ? process.cwd() : '.');
  const candidates = [
    resolve(appPath, 'bin/spawnea.mjs'),
    resolve(appPath, '../bin/spawnea.mjs'),
    resolve(appPath, '../../bin/spawnea.mjs'),
    resolve(appPath, '../../../bin/spawnea.mjs'),
    resolve(appPath, '../../../../bin/spawnea.mjs'),
    resolve(appPath, 'build/spawnea'),
    resolve(appPath, '../build/spawnea'),
    resolve(appPath, '../../build/spawnea'),
    resolve(appPath, '../../../build/spawnea'),
    resolve(appPath, 'apps/desktop/build/spawnea'),
    resolve(appPath, '../../apps/desktop/build/spawnea'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Fallback default
  return candidates[0];
}

export function getUserLocalBinDir(homeDirectory?: string): string {
  const home = homeDirectory ?? (typeof homedir === 'function' ? homedir() : '/tmp');
  return join(home, '.local', 'bin');
}

export function isDirectoryInPath(dir: string, pathEnv?: string, platform?: NodeJS.Platform): boolean {
  const env =
    pathEnv ??
    (typeof process !== 'undefined'
      ? (process.env.ORIGINAL_PATH ?? process.env.PATH)
      : undefined) ??
    '';
  const delimiter = platform === 'win32' ? ';' : ':';
  const resolvedDir = resolve(dir);
  const parts = env.split(delimiter).filter(Boolean);
  return parts.some((part) => {
    try {
      return resolve(part) === resolvedDir;
    } catch {
      return false;
    }
  });
}

async function assertOwnedCliSymlink(symlinkPath: string, targetPath: string, homeDirectory?: string): Promise<void> {
  try {
    const existingStat = await lstat(symlinkPath);
    if (!existingStat.isSymbolicLink()) {
      throw new Error(`Cannot overwrite existing non-symlink file at: ${symlinkPath}`);
    }
    const existingTarget = resolve(dirname(symlinkPath), await readlink(symlinkPath));
    if (existingTarget === targetPath || existingTarget === getAppImageLauncherPath(homeDirectory)) return;

    const knownPath = existingTarget.endsWith('/bin/spawnea.mjs') ||
      existingTarget.endsWith('/resources/spawnea') ||
      existingTarget.endsWith('/build/spawnea');
    const candidateStat = knownPath ? await stat(existingTarget).catch(() => null) : null;
    const contents = candidateStat?.isFile() && candidateStat.size <= 100_000
      ? await readFile(existingTarget, 'utf8').catch(() => '')
      : '';
    if (!contents.includes('spawnea-cli.js') && !contents.includes('--spawnea-cli')) {
      throw new Error(`Cannot overwrite existing symlink to another target at: ${symlinkPath}`);
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function getCliPathStatus(options: CliPathInstallerOptions = {}): Promise<CliPathStatus> {
  const currentPlatform = options.platform ?? (typeof process !== 'undefined' ? process.platform : 'linux');
  const binDir = getUserLocalBinDir(options.homeDirectory);
  const symlinkPath = join(binDir, 'spawnea');
  const targetPath = resolveSpawneaCliExecutable(options);
  const isInPath = isDirectoryInPath(binDir, options.pathEnv, currentPlatform);
  const appImage = options.appImagePath ?? (typeof process !== 'undefined' ? process.env.APPIMAGE : undefined);
  const pathInstruction = !isInPath
    ? `Add ${binDir} to your PATH (e.g. export PATH="${binDir}:$PATH" in ~/.zshrc or ~/.bashrc)`
    : undefined;

  if (currentPlatform === 'win32') {
    return {
      installed: false,
      targetPath,
      symlinkPath,
      isValid: false,
      error: 'PATH symlink installation is not supported on Windows',
    };
  }

  try {
    const linkStat = await lstat(symlinkPath);
    if (!linkStat.isSymbolicLink()) {
      return {
        installed: true,
        targetPath,
        symlinkPath,
        isValid: false,
        isInPath,
        pathInstruction,
        error: `${symlinkPath} exists but is not a symbolic link`,
      };
    }

    const currentTarget = await readlink(symlinkPath);
    const resolvedCurrent = resolve(dirname(symlinkPath), currentTarget);
    const resolvedTarget = resolve(targetPath);

    if (resolvedCurrent !== resolvedTarget) {
      return {
        installed: true,
        targetPath,
        symlinkPath,
        isValid: false,
        isInPath,
        pathInstruction,
        error: `Symlink points to ${resolvedCurrent} instead of ${resolvedTarget}`,
      };
    }

    // Verify the target executable actually exists on disk and is executable/file
    try {
      const targetStat = await stat(resolvedTarget);
      if (!targetStat.isFile()) {
        return {
          installed: true,
          targetPath,
          symlinkPath,
          isValid: false,
          isInPath,
          pathInstruction,
          error: `Target at ${resolvedTarget} is not a regular file`,
        };
      }
      await access(resolvedTarget, constants.X_OK);

      if (appImage) {
        const content = await readFile(resolvedTarget, 'utf8');
        const assignment = `APPIMAGE_BIN='${appImage.replace(/'/g, "'\\''")}'`;
        if (!content.split(/\r?\n/u).includes(assignment)) {
          return {
            installed: true,
            targetPath,
            symlinkPath,
            isValid: false,
            isInPath,
            pathInstruction,
            error: `AppImage launcher points to outdated binary at ${resolvedTarget}`,
          };
        }
      }
    } catch (err: any) {
      return {
        installed: true,
        targetPath,
        symlinkPath,
        isValid: false,
        isInPath,
        pathInstruction,
        error: `Target executable at ${resolvedTarget} is not accessible: ${err?.message || String(err)}`,
      };
    }

    return {
      installed: true,
      targetPath,
      symlinkPath,
      isValid: true,
      isInPath,
      pathInstruction,
    };
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return {
        installed: false,
        targetPath,
        symlinkPath,
        isValid: false,
        isInPath,
        pathInstruction,
      };
    }
    return {
      installed: false,
      targetPath,
      symlinkPath,
      isValid: false,
      isInPath,
      pathInstruction,
      error: error?.message || String(error),
    };
  }
}

export async function installCliInPath(options: CliPathInstallerOptions = {}): Promise<CliPathStatus> {
  const currentPlatform = options.platform ?? (typeof process !== 'undefined' ? process.platform : 'linux');
  const binDir = getUserLocalBinDir(options.homeDirectory);
  const symlinkPath = join(binDir, 'spawnea');
  const appImage = options.appImagePath ?? (typeof process !== 'undefined' ? process.env.APPIMAGE : undefined);

  if (currentPlatform === 'win32') {
    throw new Error('PATH symlink installation is not supported on Windows');
  }

  // If in AppImage build, create persistent launcher script targeting the AppImage binary
  if (appImage) {
    if (!existsSync(appImage)) {
      throw new Error(`Spawnea AppImage executable not found at: ${appImage}`);
    }
    await assertOwnedCliSymlink(symlinkPath, getAppImageLauncherPath(options.homeDirectory), options.homeDirectory);
    const launcherPath = getAppImageLauncherPath(options.homeDirectory);
    await mkdir(dirname(launcherPath), { recursive: true, mode: 0o755 });
    const safeAppImage = appImage.replace(/'/g, "'\\''");
    const launcherScript = [
      '#!/bin/sh',
      'set -eu',
      `APPIMAGE_BIN='${safeAppImage}'`,
      'if [ ! -f "$APPIMAGE_BIN" ]; then',
      '  printf \'%s\\n\' "Spawnea AppImage executable not found at: $APPIMAGE_BIN" >&2',
      '  exit 1',
      'fi',
      'exec "$APPIMAGE_BIN" --no-sandbox --spawnea-cli "$@"',
      '',
    ].join('\n');
    await writeFile(launcherPath, launcherScript, { mode: 0o755 });
    await chmod(launcherPath, 0o755);
  }

  const targetPath = resolveSpawneaCliExecutable(options);

  if (!existsSync(targetPath)) {
    throw new Error(`Spawnea CLI executable not found at: ${targetPath}`);
  }

  // Ensure target is executable
  const targetStat = await stat(targetPath);
  if (!targetStat.isFile()) {
    throw new Error(`Spawnea CLI target is not a regular file at: ${targetPath}`);
  }
  try {
    await access(targetPath, constants.X_OK);
  } catch {
    // If not executable, attempt to make it readable/executable for user
    try {
      await chmod(targetPath, 0o755);
      await access(targetPath, constants.X_OK);
    } catch (chmodErr: any) {
      throw new Error(`Spawnea CLI target at ${targetPath} is not executable and could not be made executable: ${chmodErr?.message || String(chmodErr)}`);
    }
  }

  await mkdir(binDir, { recursive: true, mode: 0o755 });

  await assertOwnedCliSymlink(symlinkPath, targetPath, options.homeDirectory);

  // Atomic symlink creation via temporary symlink + rename
  const tempSymlinkPath = join(binDir, `.spawnea-symlink-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    await symlink(targetPath, tempSymlinkPath);
    await rename(tempSymlinkPath, symlinkPath);
  } catch (err) {
    await unlink(tempSymlinkPath).catch(() => {});
    throw err;
  }

  return getCliPathStatus(options);
}
