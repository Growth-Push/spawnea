import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_PROFILE_NAME_LENGTH,
  parseProfileFromArgs,
  initializeActiveCatalogPath,
  resolveSpawneaUserDataPath,
  sanitizeProfileName,
} from './product-paths.js';

describe('Spawnea user data compatibility', () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('uses the canonical directory for a fresh install', async () => {
    directory = await mkdtemp(join(tmpdir(), 'spawnea-user-data-'));
    expect(resolveSpawneaUserDataPath(directory, join(directory, 'Electron')))
      .toBe(join(directory, 'spawnea'));
  });

  it('uses an explicit data directory for isolated runs', async () => {
    directory = await mkdtemp(join(tmpdir(), 'spawnea-user-data-'));
    const explicit = join(directory, 'isolated');
    expect(resolveSpawneaUserDataPath(directory, join(directory, 'Electron'), explicit)).toBe(explicit);
  });

  it('resolves profile-specific directory when profile is provided', async () => {
    directory = await mkdtemp(join(tmpdir(), 'spawnea-user-data-'));
    expect(resolveSpawneaUserDataPath(directory, join(directory, 'Electron'), undefined, 'project-a'))
      .toBe(join(directory, 'spawnea', 'profiles', 'project-a'));
  });

  it('sanitizes valid and invalid profile names', () => {
    expect(sanitizeProfileName('valid_profile-123')).toBe('valid_profile-123');
    expect(sanitizeProfileName('a')).toBe('a');
    expect(() => sanitizeProfileName('')).toThrow('Profile name cannot be empty');
    expect(() => sanitizeProfileName('   ')).toThrow('Profile name cannot be empty');
    expect(() => sanitizeProfileName('invalid/profile')).toThrow('Invalid profile name');
    expect(() => sanitizeProfileName('invalid..profile')).toThrow('Invalid profile name');
    expect(() => sanitizeProfileName('invalid profile')).toThrow('Invalid profile name');
    expect(() => sanitizeProfileName('-invalid-start')).toThrow('Invalid profile name');
    expect(() => sanitizeProfileName('invalid-end-')).toThrow('Invalid profile name');
    expect(() => sanitizeProfileName('a'.repeat(MAX_PROFILE_NAME_LENGTH + 1)))
      .toThrow(`exceeds maximum length of ${MAX_PROFILE_NAME_LENGTH} characters`);
  });

  it('uses one lowercase identity for case variants and preserves explicit data paths', () => {
    expect(sanitizeProfileName(' Work_Profile ')).toBe('work_profile');
    expect(resolveSpawneaUserDataPath('/tmp/app', '/tmp/derived', undefined, ' Work '))
      .toBe(resolveSpawneaUserDataPath('/tmp/app', '/tmp/derived', undefined, 'work'));
    expect(resolveSpawneaUserDataPath('/tmp/app', '/tmp/derived', '/tmp/Explicit', 'invalid/name'))
      .toBe('/tmp/Explicit');
    expect(parseProfileFromArgs(['--profile', ' Work '], { SPAWNEA_PROFILE: 'Other' })).toBe('work');
    expect(parseProfileFromArgs(['--profile=Work'], {})).toBe('work');
    expect(parseProfileFromArgs([], { SPAWNEA_PROFILE: ' Work ' })).toBe('work');
  });

  it.each(['CON', 'PrN', 'AUX', 'nul', ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
    ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)])('rejects reserved Windows profile %s only on Windows', (name) => {
    expect(() => sanitizeProfileName(name, 'win32')).toThrow('Windows device names are reserved');
    expect(sanitizeProfileName(name, 'linux')).toBe(name.toLowerCase());
    expect(sanitizeProfileName(name, 'darwin')).toBe(name.toLowerCase());
  });

  it.each(['com0', 'com10', 'lpt0', 'lpt10', 'con-profile'])('accepts non-reserved Windows profile %s', (name) => {
    expect(sanitizeProfileName(name, 'win32')).toBe(name);
  });

  it('parses profile name from CLI args or environment', () => {
    expect(parseProfileFromArgs(['--foo', '--profile', 'project-x'])).toBe('project-x');
    expect(parseProfileFromArgs(['--profile=project-y'])).toBe('project-y');
    expect(parseProfileFromArgs([], { SPAWNEA_PROFILE: 'env-project' })).toBe('env-project');
    expect(parseProfileFromArgs(['--profile', 'cli-project'], { SPAWNEA_PROFILE: 'env-project' }))
      .toBe('cli-project');
    expect(parseProfileFromArgs(['--smoke-test'])).toBeUndefined();
    expect(() => parseProfileFromArgs(['--profile'])).toThrow('--profile requires a profile name');
    expect(() => parseProfileFromArgs(['--profile', '--smoke-test'])).toThrow('--profile requires a profile name');
    expect(() => parseProfileFromArgs(['--profile', '-f'])).toThrow('--profile requires a profile name');
    expect(() => parseProfileFromArgs(['--profile='])).toThrow('Profile name cannot be empty');
    expect(() => parseProfileFromArgs(['--profile', 'invalid/name'])).toThrow('Invalid profile name');
    expect(() => parseProfileFromArgs([], { SPAWNEA_PROFILE: 'invalid/env' })).toThrow('Invalid profile name');
  });

  async function catalogFixture() {
    directory = await mkdtemp(join(tmpdir(), 'spawnea-profile-catalog-'));
    const base = join(directory, 'spawnea', 'config.yaml');
    const profileDir = join(directory, 'spawnea', 'profiles', 'work');
    const profile = join(profileDir, 'config.yaml');
    await mkdir(join(directory, 'spawnea'), { recursive: true });
    await writeFile(base, 'hosts: original\n');
    return { appData: directory, base, profileDir, profile };
  }

  it('initializes a private catalog once and keeps profile edits separate from the default', async () => {
    const { appData, base, profileDir, profile } = await catalogFixture();
    expect(await initializeActiveCatalogPath(profileDir, appData, true, false)).toBe(profile);
    expect(await readFile(profile, 'utf8')).toBe('hosts: original\n');
    if (process.platform !== 'win32') expect((await stat(profile)).mode & 0o777).toBe(0o600);
    await writeFile(profile, 'hosts: profile-edited\n');
    expect(await readFile(base, 'utf8')).toBe('hosts: original\n');
    await writeFile(base, 'hosts: default-edited\n');
    await initializeActiveCatalogPath(profileDir, appData, true, false);
    expect(await readFile(profile, 'utf8')).toBe('hosts: profile-edited\n');
  });

  it('preserves an existing profile catalog', async () => {
    const { appData, profileDir, profile } = await catalogFixture();
    await mkdir(profileDir, { recursive: true });
    await writeFile(profile, 'hosts: existing\n');
    await initializeActiveCatalogPath(profileDir, appData, true, false);
    expect(await readFile(profile, 'utf8')).toBe('hosts: existing\n');
  });

  it('does not inspect or copy the base for explicit data overrides or default runs', async () => {
    const { appData, base, profileDir, profile } = await catalogFixture();
    // A directory at the base catalog path would fail readFile if inspected.
    await rm(base);
    await mkdir(base);
    expect(await initializeActiveCatalogPath(profileDir, appData, true, true)).toBe(profile);
    expect(await initializeActiveCatalogPath(profileDir, appData, false, false)).toBe(profile);
    await expect(stat(profile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(profileDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the profile path when no default catalog exists', async () => {
    const { appData, base, profileDir, profile } = await catalogFixture();
    await rm(base);
    expect(await initializeActiveCatalogPath(profileDir, appData, true, false)).toBe(profile);
    await expect(stat(profile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a catalog created while the default copy is being staged', async () => {
    const { appData, profileDir, profile } = await catalogFixture();
    const publishCatalog: typeof link = async (source, target) => {
      await writeFile(profile, 'hosts: concurrent-owner\n', { flag: 'wx' });
      await link(source, target);
    };
    expect(await initializeActiveCatalogPath(profileDir, appData, true, false, publishCatalog)).toBe(profile);
    expect(await readFile(profile, 'utf8')).toBe('hosts: concurrent-owner\n');
    expect(await readdir(profileDir)).toEqual(['config.yaml']);
  });

  it('publishes concurrent initializations without replacing a catalog or leaving temporary copies', async () => {
    const { appData, profileDir, profile } = await catalogFixture();
    expect(await Promise.all(Array.from({ length: 8 }, () =>
      initializeActiveCatalogPath(profileDir, appData, true, false))))
      .toEqual(Array(8).fill(profile));
    expect(await readFile(profile, 'utf8')).toBe('hosts: original\n');
    expect(await readdir(profileDir)).toEqual(['config.yaml']);
  });
});
