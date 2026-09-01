import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
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

test('uses a literal POSIX backslash path for filesystem access', {
  skip: process.platform === 'win32',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spawnea-privacy-backslash-'));
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: directory });
    const literalPath = join(directory, 'literal\\name.txt');
    await writeFile(literalPath, 'literal backslash\n');
    await execFileAsync('git', ['add', 'literal\\name.txt'], { cwd: directory });

    const files = await collectRepositoryFiles(directory);

    assert.deepEqual(files, [{
      absolutePath: literalPath,
      filePath: 'literal/name.txt',
      isSymbolicLink: false,
    }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('marks a symlink targeting outside the repository so callers cannot read through it', {
  skip: process.platform === 'win32',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spawnea-privacy-symlink-'));
  try {
    const repository = join(directory, 'repository');
    await mkdir(repository);
    await execFileAsync('git', ['init', '--quiet'], { cwd: repository });
    const outsidePath = join(directory, 'outside.txt');
    await writeFile(outsidePath, 'outside repository\n');
    await symlink(outsidePath, join(repository, 'external-link.txt'));
    await execFileAsync('git', ['add', 'external-link.txt'], { cwd: repository });

    const files = await collectRepositoryFiles(repository);

    assert.deepEqual(files, [{
      absolutePath: join(repository, 'external-link.txt'),
      filePath: 'external-link.txt',
      isSymbolicLink: true,
    }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
