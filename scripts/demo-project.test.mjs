import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const initScript = resolve(root, 'scripts/demo-project-init.sh');
const resetScript = resolve(root, 'scripts/demo-project-reset.sh');

test('demo-project-init.sh initializes a clean Git repository with README.md on main', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'spawnea-demo-test-'));
  const projectDir = join(tempDir, 'demo-proj');
  try {
    const { stdout } = await execFileAsync(initScript, [projectDir]);
    assert.match(stdout, /Initialized demo project/);

    const readmeContent = await readFile(join(projectDir, 'README.md'), 'utf8');
    assert.match(readmeContent, /# Demo Project/);

    const { stdout: branch } = await execFileAsync('git', ['branch', '--show-current'], { cwd: projectDir });
    assert.equal(branch.trim(), 'main');

    const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: projectDir });
    assert.equal(status.trim(), '');

    const { stdout: log } = await execFileAsync('git', ['log', '-1', '--pretty=%B'], { cwd: projectDir });
    assert.equal(log.trim(), 'initial commit');

    // Running init on an existing repository reports existing status and does not error
    const { stdout: secondRun } = await execFileAsync(initScript, [projectDir]);
    assert.match(secondRun, /already initialized/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('demo-project-reset.sh wipes uncommitted/extra changes and restores clean repository', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'spawnea-demo-reset-test-'));
  const projectDir = join(tempDir, 'demo-proj');
  try {
    await execFileAsync(initScript, [projectDir]);

    // Make local changes
    await writeFile(join(projectDir, 'README.md'), 'Modified content\n');
    await writeFile(join(projectDir, 'extra.txt'), 'Extra file\n');

    // Run reset script
    const { stdout: resetOutput } = await execFileAsync(resetScript, [projectDir]);
    assert.match(resetOutput, /Initialized demo project/);

    const readmeContent = await readFile(join(projectDir, 'README.md'), 'utf8');
    assert.match(readmeContent, /# Demo Project/);
    assert.doesNotMatch(readmeContent, /Modified content/);

    const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: projectDir });
    assert.equal(status.trim(), '');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

for (const script of [initScript, resetScript]) {
  test(`${script} refuses unrelated content and symlink targets`, async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'spawnea-demo-safety-'));
    try {
      const projectDir = join(tempDir, 'unrelated');
      await mkdir(projectDir);
      await writeFile(join(projectDir, 'keep.txt'), 'Keep this file');
      await assert.rejects(execFileAsync(script, [projectDir]));
      assert.equal(await readFile(join(projectDir, 'keep.txt'), 'utf8'), 'Keep this file');
      const link = join(tempDir, 'linked');
      await symlink(projectDir, link);
      await assert.rejects(execFileAsync(script, [link]));
      assert.equal(await readFile(join(projectDir, 'keep.txt'), 'utf8'), 'Keep this file');
      await assert.rejects(execFileAsync(script, ['/']));
      await assert.rejects(execFileAsync(script, [tmpdir()]));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
}
