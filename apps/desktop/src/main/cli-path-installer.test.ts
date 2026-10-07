import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getAppImageLauncherPath,
  getCliPathStatus,
  getUserLocalBinDir,
  installCliInPath,
  resolveSpawneaCliExecutable,
} from './cli-path-installer.js';

describe('CLI PATH installer', () => {
  let tempHome: string | undefined;
  const originalAppImage = process.env.APPIMAGE;
  const originalPath = process.env.ORIGINAL_PATH;

  beforeEach(() => {
    delete process.env.APPIMAGE;
    delete process.env.ORIGINAL_PATH;
  });

  afterEach(async () => {
    if (originalAppImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = originalAppImage;
    if (originalPath === undefined) delete process.env.ORIGINAL_PATH;
    else process.env.ORIGINAL_PATH = originalPath;
    if (tempHome) {
      await rm(tempHome, { recursive: true, force: true });
      tempHome = undefined;
    }
  });

  it('determines user local bin directory correctly', () => {
    expect(getUserLocalBinDir('/var/mock-user')).toBe('/var/mock-user/.local/bin');
  });

  it('reports not installed when symlink does not exist', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'spawnea-home-'));
    const status = await getCliPathStatus({ homeDirectory: tempHome });
    expect(status.installed).toBe(false);
    expect(status.isValid).toBe(false);
    expect(status.symlinkPath).toBe(join(tempHome, '.local/bin/spawnea'));
  });

  it('installs symlink and reports valid status', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'spawnea-home-'));
    const dummyExe = join(tempHome, 'test-bin-spawnea');
    await writeFile(dummyExe, '#!/bin/sh\necho test\n', { mode: 0o755 });

    const result = await installCliInPath({
      homeDirectory: tempHome,
      customExecutablePath: dummyExe,
    });

    expect(result.installed).toBe(true);
    expect(result.isValid).toBe(true);
    expect(result.targetPath).toBe(dummyExe);

    const recheck = await getCliPathStatus({
      homeDirectory: tempHome,
      customExecutablePath: dummyExe,
    });
    expect(recheck.installed).toBe(true);
    expect(recheck.isValid).toBe(true);
  });

  it('overwrites previous symlink when target updates', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'spawnea-home-'));
    const dummyExe1 = join(tempHome, 'old', 'bin', 'spawnea.mjs');
    const dummyExe2 = join(tempHome, 'new', 'bin', 'spawnea.mjs');
    await mkdir(join(tempHome, 'old', 'bin'), { recursive: true });
    await mkdir(join(tempHome, 'new', 'bin'), { recursive: true });
    await writeFile(dummyExe1, '#!/bin/sh\n', { mode: 0o755 });
    await writeFile(dummyExe2, '#!/bin/sh\n', { mode: 0o755 });

    await installCliInPath({ homeDirectory: tempHome, customExecutablePath: dummyExe1 });
    const check1 = await getCliPathStatus({ homeDirectory: tempHome, customExecutablePath: dummyExe1 });
    expect(check1.isValid).toBe(true);

    // If customExecutablePath changes to dummyExe2, old link is marked invalid
    const checkBeforeReinstall = await getCliPathStatus({ homeDirectory: tempHome, customExecutablePath: dummyExe2 });
    expect(checkBeforeReinstall.installed).toBe(true);
    expect(checkBeforeReinstall.isValid).toBe(false);

    // Re-install points to new target
    await installCliInPath({ homeDirectory: tempHome, customExecutablePath: dummyExe2 });
    const check2 = await getCliPathStatus({ homeDirectory: tempHome, customExecutablePath: dummyExe2 });
    expect(check2.isValid).toBe(true);
  });

  it('refuses to overwrite a non-symlink file', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'spawnea-home-'));
    const binDir = join(tempHome, '.local/bin');
    await mkdir(binDir, { recursive: true });
    const regularFile = join(binDir, 'spawnea');
    await writeFile(regularFile, 'not a symlink');

    const dummyExe = join(tempHome, 'test-bin');
    await writeFile(dummyExe, '#!/bin/sh\n', { mode: 0o755 });

    await expect(
      installCliInPath({ homeDirectory: tempHome, customExecutablePath: dummyExe })
    ).rejects.toThrow(/Cannot overwrite existing non-symlink file/);
  });

  it('preserves a symlink to another executable', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'spawnea-home-'));
    const binDir = join(tempHome, '.local/bin');
    await mkdir(binDir, { recursive: true });
    const otherExecutable = join(tempHome, 'other-tool');
    const spawneaExecutable = join(tempHome, 'spawnea-executable');
    await writeFile(otherExecutable, '#!/bin/sh\n', { mode: 0o755 });
    await writeFile(spawneaExecutable, '#!/bin/sh\n', { mode: 0o755 });
    await symlink(otherExecutable, join(binDir, 'spawnea'));

    await expect(installCliInPath({ homeDirectory: tempHome, customExecutablePath: spawneaExecutable }))
      .rejects.toThrow(/Cannot overwrite existing symlink to another target/);
    const status = await getCliPathStatus({ homeDirectory: tempHome, customExecutablePath: otherExecutable });
    expect(status.isValid).toBe(true);
  });

  it('cleanly returns unsupported on Windows platform', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'spawnea-home-'));
    const dummyExe = join(tempHome, 'test-bin-spawnea');
    await writeFile(dummyExe, '#!/bin/sh\n', { mode: 0o755 });

    const status = await getCliPathStatus({
      homeDirectory: tempHome,
      customExecutablePath: dummyExe,
      platform: 'win32',
    });
    expect(status.installed).toBe(false);
    expect(status.isValid).toBe(false);
    expect(status.error).toContain('Windows');
    expect(status.pathInstruction).toBeUndefined();

    await expect(
      installCliInPath({
        homeDirectory: tempHome,
        customExecutablePath: dummyExe,
        platform: 'win32',
      })
    ).rejects.toThrow(/not supported on Windows/);
  });

  it('marks isValid as false if target executable is removed from disk', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'spawnea-home-'));
    const dummyExe = join(tempHome, 'test-bin-deleted');
    await writeFile(dummyExe, '#!/bin/sh\n', { mode: 0o755 });

    await installCliInPath({
      homeDirectory: tempHome,
      customExecutablePath: dummyExe,
    });

    const statusBefore = await getCliPathStatus({
      homeDirectory: tempHome,
      customExecutablePath: dummyExe,
    });
    expect(statusBefore.isValid).toBe(true);

    // Remove the target executable
    await rm(dummyExe);

    const statusAfter = await getCliPathStatus({
      homeDirectory: tempHome,
      customExecutablePath: dummyExe,
    });
    expect(statusAfter.installed).toBe(true);
    expect(statusAfter.isValid).toBe(false);
    expect(statusAfter.error).toContain('not accessible');
  });

  it('makes non-executable target executable during installation', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'spawnea-home-'));
    const dummyExe = join(tempHome, 'test-bin-noexec');
    // Write without executable permissions (0o644)
    await writeFile(dummyExe, '#!/bin/sh\n', { mode: 0o644 });

    const status = await installCliInPath({
      homeDirectory: tempHome,
      customExecutablePath: dummyExe,
    });

    expect(status.installed).toBe(true);
    expect(status.isValid).toBe(true);
  });

  it('detects whether binDir is present in PATH', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'spawnea-home-'));
    const dummyExe = join(tempHome, 'test-bin-spawnea');
    await writeFile(dummyExe, '#!/bin/sh\n', { mode: 0o755 });

    const binDir = getUserLocalBinDir(tempHome);

    // Case 1: binDir is not in PATH
    const statusNotInPath = await getCliPathStatus({
      homeDirectory: tempHome,
      customExecutablePath: dummyExe,
      pathEnv: '/usr/bin:/bin:/usr/local/bin',
    });
    expect(statusNotInPath.isInPath).toBe(false);
    expect(statusNotInPath.pathInstruction).toContain(binDir);

    // Case 2: binDir is in PATH
    const statusInPath = await getCliPathStatus({
      homeDirectory: tempHome,
      customExecutablePath: dummyExe,
      pathEnv: `/usr/bin:${binDir}:/bin`,
    });
    expect(statusInPath.isInPath).toBe(true);
    expect(statusInPath.pathInstruction).toBeUndefined();
  });

  it('installs a persistent launcher for AppImage builds that survives closing and reopening', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'spawnea-home-'));
    const dummyAppImage = join(tempHome, 'Spawnea-1.0.0.AppImage');
    await writeFile(dummyAppImage, '#!/bin/sh\n', { mode: 0o755 });

    // Install CLI from AppImage
    const installStatus = await installCliInPath({
      homeDirectory: tempHome,
      appImagePath: dummyAppImage,
      resourcesPath: '/tmp/.mount_Spawnea123/resources',
    });

    expect(installStatus.installed).toBe(true);
    expect(installStatus.isValid).toBe(true);
    const expectedLauncherPath = getAppImageLauncherPath(tempHome);
    expect(installStatus.targetPath).toBe(expectedLauncherPath);

    // Verify launcher file exists and contains persistent reference to AppImage
    const checkStatus = await getCliPathStatus({
      homeDirectory: tempHome,
      appImagePath: dummyAppImage,
      resourcesPath: '/tmp/.mount_Spawnea123/resources',
    });
    expect(checkStatus.installed).toBe(true);
    expect(checkStatus.isValid).toBe(true);
    expect(checkStatus.targetPath).toBe(expectedLauncherPath);

    // Simulate closing Spawnea and reopening with a DIFFERENT temporary mount path
    const reopenStatus = await getCliPathStatus({
      homeDirectory: tempHome,
      appImagePath: dummyAppImage,
      resourcesPath: '/tmp/.mount_Spawnea456/resources',
    });
    expect(reopenStatus.installed).toBe(true);
    expect(reopenStatus.isValid).toBe(true);
    expect(reopenStatus.targetPath).toBe(expectedLauncherPath);
  });

  it('validates the exact AppImage launcher assignment, including quoted paths', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'spawnea-home-'));
    const appImage = join(tempHome, "Spawnea's.AppImage");
    await writeFile(appImage, '#!/bin/sh\n', { mode: 0o755 });

    const installed = await installCliInPath({ homeDirectory: tempHome, appImagePath: appImage });
    expect(installed.isValid).toBe(true);

    await writeFile(getAppImageLauncherPath(tempHome), `#!/bin/sh\nAPPIMAGE_BIN='${appImage}.old'\n`, { mode: 0o755 });
    const stale = await getCliPathStatus({ homeDirectory: tempHome, appImagePath: appImage });
    expect(stale.isValid).toBe(false);
    expect(stale.error).toContain('outdated binary');
  });

  it('does not resolve a development CLI from parent directories in packaged builds', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'spawnea-repo-'));
    const appPath = join(tempHome, 'apps', 'desktop', 'out', 'main');
    const resourcesPath = join(tempHome, 'resources');
    await mkdir(appPath, { recursive: true });
    await mkdir(resourcesPath);
    await mkdir(join(tempHome, 'bin'));
    await writeFile(join(tempHome, 'bin', 'spawnea.mjs'), '#!/bin/sh\n', { mode: 0o755 });

    expect(resolveSpawneaCliExecutable({ appPath, resourcesPath, isPackaged: true }))
      .toBe(join(resourcesPath, 'spawnea'));
    await expect(installCliInPath({ homeDirectory: tempHome, appPath, resourcesPath, isPackaged: true }))
      .rejects.toThrow('CLI executable not found');
  });

  it('resolves the CLI from direct compiled-entry launches (apps/desktop/out/main)', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'spawnea-repo-'));
    const compiledEntryPath = join(tempHome, 'apps', 'desktop', 'out', 'main');
    await mkdir(compiledEntryPath, { recursive: true });

    const rootBinDir = join(tempHome, 'bin');
    await mkdir(rootBinDir, { recursive: true });
    const rootCliScript = join(rootBinDir, 'spawnea.mjs');
    await writeFile(rootCliScript, '#!/usr/bin/env node\n', { mode: 0o755 });

    const resolved = resolveSpawneaCliExecutable({ appPath: compiledEntryPath });
    expect(resolved).toBe(rootCliScript);
  });

  it('honors ORIGINAL_PATH to detect user PATH prior to process-path augmentation', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'spawnea-home-'));
    const dummyExe = join(tempHome, 'test-bin-orig');
    await writeFile(dummyExe, '#!/bin/sh\n', { mode: 0o755 });

    const origEnv = process.env.ORIGINAL_PATH;
    try {
      process.env.ORIGINAL_PATH = '/usr/bin:/bin';
      const status = await getCliPathStatus({
        homeDirectory: tempHome,
        customExecutablePath: dummyExe,
      });
      // User's ORIGINAL_PATH did not contain ~/.local/bin
      expect(status.isInPath).toBe(false);
      expect(status.pathInstruction).toBeDefined();
    } finally {
      if (origEnv !== undefined) {
        process.env.ORIGINAL_PATH = origEnv;
      } else {
        delete process.env.ORIGINAL_PATH;
      }
    }
  });
});
