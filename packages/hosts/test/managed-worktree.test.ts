import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService, LocalHostAdapter, validateCopyFilePath } from '../src/index.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('managed Git worktrees', () => {
  let tempRoot: string;
  let repositoryPath: string;
  let host: LocalHostAdapter;
  let service: GitService;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'spawnea-worktree-'));
    repositoryPath = join(tempRoot, 'project');
    git(tempRoot, 'init', '--initial-branch=main', repositoryPath);
    git(repositoryPath, 'config', 'user.email', 'spawnea@example.invalid');
    git(repositoryPath, 'config', 'user.name', 'Spawnea Test');
    writeFileSync(join(repositoryPath, 'README.md'), 'base\n');
    writeFileSync(join(repositoryPath, '.env.local'), 'LOCAL_ONLY=value\n');
    git(repositoryPath, 'add', 'README.md');
    git(repositoryPath, 'commit', '-m', 'initial');
    host = new LocalHostAdapter({ serverId: 'test-local' });
    service = new GitService();
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(`${repositoryPath}__worktrees`, { recursive: true, force: true });
  });

  it('creates five distinct branches and worktrees from the same base', async () => {
    const worktrees = await Promise.all(
      Array.from({ length: 5 }, (_, index) => service.createManagedWorktree({
        host,
        repositoryPath,
        taskSlug: 'parallel-task',
        sessionSuffix: `s00${index}`,
        baseBranch: 'main',
      }))
    );

    expect(new Set(worktrees.map((item) => item.worktreePath))).toHaveLength(5);
    expect(new Set(worktrees.map((item) => item.branch))).toHaveLength(5);
    const creationCommit = git(repositoryPath, 'rev-parse', 'main');

    for (const [index, worktree] of worktrees.entries()) {
      expect(git(worktree.worktreePath, 'branch', '--show-current')).toBe(worktree.branch);
      expect(worktree.baseBranch).toBe('main');
      expect(worktree.baseCommit).toBe(creationCommit);
      writeFileSync(join(worktree.worktreePath, `isolated-${index}.txt`), String(index));
    }

    for (const [index, worktree] of worktrees.entries()) {
      expect(() => readFileSync(join(worktree.worktreePath, `isolated-${index}.txt`), 'utf8')).not.toThrow();
      expect(() => readFileSync(join(repositoryPath, `isolated-${index}.txt`), 'utf8')).toThrow();
    }
  });

  it('copies exact regular files, skips missing files, and never overwrites', async () => {
    const worktree = await service.createManagedWorktree({
      host,
      repositoryPath,
      taskSlug: 'copy-files',
      sessionSuffix: 'copy',
      baseBranch: 'main',
    });

    const copied = await service.copyFilesToWorktree(
      host,
      repositoryPath,
      worktree.worktreePath,
      ['.env.local', '.missing-local']
    );

    expect(copied).toEqual({ copied: ['.env.local'], skipped: ['.missing-local'] });
    expect(readFileSync(join(worktree.worktreePath, '.env.local'), 'utf8')).toBe('LOCAL_ONLY=value\n');
    writeFileSync(join(worktree.worktreePath, '.env.local'), 'WORKTREE_ONLY=value\n');
    expect(readFileSync(join(repositoryPath, '.env.local'), 'utf8')).toBe('LOCAL_ONLY=value\n');
    await expect(service.copyFilesToWorktree(
      host,
      repositoryPath,
      worktree.worktreePath,
      ['.env.local']
    )).rejects.toThrow(/destination already exists/);
  });

  it('rejects traversal, absolute paths, directories, and symlinks', async () => {
    expect(() => validateCopyFilePath('../secret')).toThrow(/repository-relative/);
    expect(() => validateCopyFilePath('/tmp/secret')).toThrow(/repository-relative/);
    expect(() => validateCopyFilePath('nested/../secret')).toThrow(/repository-relative/);

    const worktree = await service.createManagedWorktree({
      host,
      repositoryPath,
      taskSlug: 'unsafe-copy',
      sessionSuffix: 'safe',
      baseBranch: 'main',
    });
    symlinkSync('.env.local', join(repositoryPath, '.env-link'));

    await expect(service.copyFilesToWorktree(
      host,
      repositoryPath,
      worktree.worktreePath,
      ['.env-link']
    )).rejects.toThrow(/symlinks are not allowed/);
    await expect(service.copyFilesToWorktree(
      host,
      repositoryPath,
      worktree.worktreePath,
      ['.git']
    )).rejects.toThrow(/non-regular files/);
  });

  it('uses normal removal and preserves the generated branch', async () => {
    const worktree = await service.createManagedWorktree({
      host,
      repositoryPath,
      taskSlug: 'cleanup',
      sessionSuffix: 'clean',
      baseBranch: 'main',
    });

    expect(await service.removeManagedWorktree(host, repositoryPath, worktree.worktreePath)).toBe(true);
    expect(git(repositoryPath, 'show-ref', '--verify', `refs/heads/${worktree.branch}`)).not.toBe('');
  });

  it('refuses normal removal when copied files leave the worktree dirty', async () => {
    const worktree = await service.createManagedWorktree({
      host,
      repositoryPath,
      taskSlug: 'dirty-cleanup',
      sessionSuffix: 'dirty',
      baseBranch: 'main',
    });
    await service.copyFilesToWorktree(host, repositoryPath, worktree.worktreePath, ['.env.local']);

    expect(await service.removeManagedWorktree(host, repositoryPath, worktree.worktreePath)).toBe(false);
    expect(readFileSync(join(worktree.worktreePath, '.env.local'), 'utf8')).toBe('LOCAL_ONLY=value\n');

    unlinkSync(join(worktree.worktreePath, '.env.local'));
    expect(await service.removeManagedWorktree(host, repositoryPath, worktree.worktreePath)).toBe(true);
  });

  it('stashes tracked, untracked, and ignored changes with an identifiable message', async () => {
    const worktree = await service.createManagedWorktree({
      host,
      repositoryPath,
      taskSlug: 'stash-close',
      sessionSuffix: 'stash',
      baseBranch: 'main',
    });
    writeFileSync(join(worktree.worktreePath, 'README.md'), 'changed\n');
    writeFileSync(join(worktree.worktreePath, 'ignored.local'), 'ignored\n');
    writeFileSync(join(repositoryPath, '.git/info/exclude'), 'ignored.local\n');

    const identity = { ...worktree };
    await service.stashManagedWorktreeChanges(host, identity);

    expect(git(worktree.worktreePath, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
    expect(git(worktree.worktreePath, 'stash', 'list')).toContain(`Spawnea worktree: ${worktree.branch}`);
  });

  it('discards dirty changes before a close without affecting the primary checkout', async () => {
    const worktree = await service.createManagedWorktree({
      host,
      repositoryPath,
      taskSlug: 'discard-close',
      sessionSuffix: 'discard',
      baseBranch: 'main',
    });
    writeFileSync(join(worktree.worktreePath, 'README.md'), 'discard me\n');
    writeFileSync(join(worktree.worktreePath, 'untracked.local'), 'discard me\n');

    await service.discardManagedWorktreeChanges(host, worktree);

    expect(git(worktree.worktreePath, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
    expect(readFileSync(join(repositoryPath, 'README.md'), 'utf8')).toBe('base\n');
    expect(await service.removeManagedWorktree(host, repositoryPath, worktree.worktreePath)).toBe(true);
  });

  it('detects a worktree whose task branch was manually integrated', async () => {
    const worktree = await service.createManagedWorktree({
      host,
      repositoryPath,
      taskSlug: 'already-integrated',
      sessionSuffix: 'integrated',
      baseBranch: 'main',
    });
    writeFileSync(join(worktree.worktreePath, 'README.md'), 'integrated\n');
    git(worktree.worktreePath, 'add', 'README.md');
    git(worktree.worktreePath, 'commit', '-m', 'task work');

    git(repositoryPath, 'switch', '-c', 'primary-temp');
    git(worktree.worktreePath, 'switch', 'main');
    git(worktree.worktreePath, 'merge', '--no-ff', worktree.branch, '-m', 'integrate task');

    const inspection = await service.inspectManagedWorktree(host, worktree);

    expect(inspection).toEqual({
      state: 'integrated',
      currentBranch: 'main',
      isClean: true,
      message: `Task branch '${worktree.branch}' is already integrated into 'main'.`,
    });
    await service.verifyManagedWorktreeForFinalization(host, worktree, false, false, true);
  });

  it('does not call a dirty task worktree integrated just because its branch starts at the base commit', async () => {
    const worktree = await service.createManagedWorktree({
      host,
      repositoryPath,
      taskSlug: 'pending-work',
      sessionSuffix: 'pending',
      baseBranch: 'main',
    });
    writeFileSync(join(worktree.worktreePath, 'README.md'), 'pending changes\n');

    const inspection = await service.inspectManagedWorktree(host, worktree);

    expect(inspection).toEqual({
      state: 'active',
      currentBranch: worktree.branch,
      isClean: false,
      message: 'Worktree is on its recorded task branch.',
    });
  });

  it('keeps an unchanged task pending when the base branch advances independently', async () => {
    const worktree = await service.createManagedWorktree({
      host,
      repositoryPath,
      taskSlug: 'pending-base-advance',
      sessionSuffix: 'pending-base',
      baseBranch: 'main',
    });
    writeFileSync(join(repositoryPath, 'base-only.txt'), 'base moved\n');
    git(repositoryPath, 'add', 'base-only.txt');
    git(repositoryPath, 'commit', '-m', 'advance base');

    const inspection = await service.inspectManagedWorktree(host, worktree);

    expect(inspection).toEqual({
      state: 'active',
      currentBranch: worktree.branch,
      isClean: true,
      message: 'Worktree is on its recorded task branch.',
    });
  });

  it('detects a fast-forward integration while the worktree stays on its task branch', async () => {
    const worktree = await service.createManagedWorktree({
      host,
      repositoryPath,
      taskSlug: 'fast-forward-integrated',
      sessionSuffix: 'fast-forward',
      baseBranch: 'main',
    });
    writeFileSync(join(worktree.worktreePath, 'feature.txt'), 'integrated\n');
    git(worktree.worktreePath, 'add', 'feature.txt');
    git(worktree.worktreePath, 'commit', '-m', 'task work');
    git(repositoryPath, 'merge', '--ff-only', worktree.branch);

    const inspection = await service.inspectManagedWorktree(host, worktree);

    expect(inspection).toEqual({
      state: 'integrated',
      currentBranch: worktree.branch,
      isClean: true,
      message: `Task branch '${worktree.branch}' is already integrated into 'main'.`,
    });
  });

  it('infers the creation commit from reflog for a legacy integrated session', async () => {
    const worktree = await service.createManagedWorktree({
      host,
      repositoryPath,
      taskSlug: 'legacy-integrated',
      sessionSuffix: 'legacy',
      baseBranch: 'main',
    });
    writeFileSync(join(worktree.worktreePath, 'legacy.txt'), 'integrated\n');
    git(worktree.worktreePath, 'add', 'legacy.txt');
    git(worktree.worktreePath, 'commit', '-m', 'legacy task work');
    git(repositoryPath, 'merge', '--ff-only', worktree.branch);
    const { baseCommit: _baseCommit, ...legacyIdentity } = worktree;

    const inspection = await service.inspectManagedWorktree(host, legacyIdentity);

    expect(inspection.state).toBe('integrated');
    expect(inspection.currentBranch).toBe(worktree.branch);
  });

  it('keeps a legacy task pending when no creation baseline can be recovered', async () => {
    git(repositoryPath, 'config', 'core.logAllRefUpdates', 'false');
    const worktree = await service.createManagedWorktree({
      host,
      repositoryPath,
      taskSlug: 'legacy-no-reflog',
      sessionSuffix: 'no-reflog',
      baseBranch: 'main',
    });
    writeFileSync(join(worktree.worktreePath, 'legacy.txt'), 'integrated\n');
    git(worktree.worktreePath, 'add', 'legacy.txt');
    git(worktree.worktreePath, 'commit', '-m', 'legacy task work');
    git(repositoryPath, 'merge', '--ff-only', worktree.branch);
    const { baseCommit: _baseCommit, ...legacyIdentity } = worktree;

    const inspection = await service.inspectManagedWorktree(host, legacyIdentity);

    expect(inspection).toEqual({
      state: 'active',
      currentBranch: worktree.branch,
      isClean: true,
      message: 'Worktree is on its recorded task branch.',
    });
  });
});
