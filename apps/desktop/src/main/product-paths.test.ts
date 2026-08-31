import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSpawneaUserDataPath } from './product-paths.js';

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

});
