import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_PROFILE_NAME_LENGTH,
  parseProfileFromArgs,
  resolveActiveCatalogPath,
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

  it('resolves active catalog path with named profile fallback and explicit user data protection', () => {
    const userData = '/tmp/profile-app-data/spawnea/profiles/chatgpt';
    const appData = '/tmp/profile-app-data';

    // 1. Named profile with profile-specific config -> uses profile config
    expect(resolveActiveCatalogPath(userData, appData, true, false, (p) => p === join(userData, 'config.yaml')))
      .toBe(join(userData, 'config.yaml'));

    // 2. Named profile without profile config, but base exists -> falls back to base config
    expect(resolveActiveCatalogPath(userData, appData, true, false, (p) => p === join(appData, 'spawnea', 'config.yaml')))
      .toBe(join(appData, 'spawnea', 'config.yaml'));

    // 3. Named profile with neither existing -> defaults to profile config
    expect(resolveActiveCatalogPath(userData, appData, true, false, () => false))
      .toBe(join(userData, 'config.yaml'));

    // 4. Explicit user data override (e.g. smoke test) -> NEVER falls back to base config even if base exists
    expect(resolveActiveCatalogPath(userData, appData, true, true, (p) => p === join(appData, 'spawnea', 'config.yaml')))
      .toBe(join(userData, 'config.yaml'));

    // 5. Default profile (not named) -> uses default user data config
    expect(resolveActiveCatalogPath('/tmp/profile-app-data/spawnea', appData, false, false, () => true))
      .toBe('/tmp/profile-app-data/spawnea/config.yaml');
  });
});
