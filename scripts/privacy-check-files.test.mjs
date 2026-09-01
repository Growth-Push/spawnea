import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { collectRepositoryFiles, normalizeRepositoryPath } from './privacy-check-files.mjs';

const execFileAsync = promisify(execFile);

test('normalizes repository paths for platform-independent policy lookups', () => {
  assert.equal(
    normalizeRepositoryPath('docs\\assets\\spawnea-logo.png'),
    'docs/assets/spawnea-logo.png',
  );
});

test('collects present tracked and untracked files while skipping deleted indexed paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spawnea-privacy-files-'));
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: directory });
    const trackedPath = join(directory, 'tracked.txt');
    const deletedPath = join(directory, 'deleted.txt');
    await writeFile(trackedPath, 'tracked\n');
    await writeFile(deletedPath, 'deleted\n');
    await execFileAsync('git', ['add', 'tracked.txt', 'deleted.txt'], { cwd: directory });
    await unlink(deletedPath);
    await writeFile(join(directory, 'untracked.txt'), 'untracked\n');

    const files = await collectRepositoryFiles(directory);

    assert.deepEqual(
      files.map((file) => file.filePath).sort(),
      ['tracked.txt', 'untracked.txt'],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
