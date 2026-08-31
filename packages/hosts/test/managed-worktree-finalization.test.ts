import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService, type ManagedWorktreeIdentity } from '../src/git-service.js';
import { LocalHostAdapter } from '../src/local-host.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('managed worktree finalization with real Git', () => {
  let tempRoot: string;
  let repositoryPath: string;
  let host: LocalHostAdapter;
  let service: GitService;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'spawnea-finalize-'));
    repositoryPath = join(tempRoot, 'repository');
    git(tempRoot, 'init', '-b', 'main', repositoryPath);
    git(repositoryPath, 'config', 'user.email', 'spawnea@example.test');
    git(repositoryPath, 'config', 'user.name', 'Spawnea Test');
    writeFileSync(join(repositoryPath, 'README.md'), 'base\n');
    git(repositoryPath, 'add', 'README.md');
    git(repositoryPath, 'commit', '-m', 'initial');
    host = new LocalHostAdapter();
    service = new GitService();
  });

  afterEach(async () => {
    await host.disconnect();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  async function createIdentity(suffix: string): Promise<ManagedWorktreeIdentity> {
    const created = await service.createManagedWorktree({
      host,
      repositoryPath,
      taskSlug: 'feature',
      sessionSuffix: suffix,
      baseBranch: 'main',
    });
    return created;
  }

  it('merges into the recorded base then removes the worktree and integrated branch', async () => {
    const identity = await createIdentity('merge-success');
    writeFileSync(join(identity.worktreePath, 'feature.txt'), 'implemented\n');
    git(identity.worktreePath, 'add', 'feature.txt');
    git(identity.worktreePath, 'commit', '-m', 'implement feature');

    await service.verifyManagedWorktreeForFinalization(host, identity, true);
    await service.mergeManagedBranch(host, identity);
    expect(await service.removeManagedWorktree(host, repositoryPath, identity.worktreePath)).toBe(true);
    await service.deleteIntegratedBranch(host, identity);

    expect(existsSync(join(repositoryPath, 'feature.txt'))).toBe(true);
    expect(existsSync(identity.worktreePath)).toBe(false);
    expect(git(repositoryPath, 'branch', '--list', identity.branch)).toBe('');
  });

  it('aborts a conflicting merge and preserves a clean task worktree and branch', async () => {
    const identity = await createIdentity('merge-conflict');
    writeFileSync(join(identity.worktreePath, 'README.md'), 'task change\n');
    git(identity.worktreePath, 'add', 'README.md');
    git(identity.worktreePath, 'commit', '-m', 'task change');
    writeFileSync(join(repositoryPath, 'README.md'), 'base change\n');
    git(repositoryPath, 'add', 'README.md');
    git(repositoryPath, 'commit', '-m', 'base change');

    await service.verifyManagedWorktreeForFinalization(host, identity, true);
    await expect(service.mergeManagedBranch(host, identity)).rejects.toThrow(/merge was aborted/i);

    expect(() => git(repositoryPath, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow();
    expect(git(repositoryPath, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
    expect(existsSync(identity.worktreePath)).toBe(true);
    expect(git(identity.worktreePath, 'branch', '--show-current')).toBe(identity.branch);
  });

  it('removes a clean worktree while preserving its unintegrated branch for Close', async () => {
    const identity = await createIdentity('close');
    writeFileSync(join(identity.worktreePath, 'committed.txt'), 'keep branch\n');
    git(identity.worktreePath, 'add', 'committed.txt');
    git(identity.worktreePath, 'commit', '-m', 'committed task work');

    await service.verifyManagedWorktreeForFinalization(host, identity, false);
    expect(await service.removeManagedWorktree(host, repositoryPath, identity.worktreePath)).toBe(true);

    expect(existsSync(identity.worktreePath)).toBe(false);
    expect(git(repositoryPath, 'show-ref', '--verify', `refs/heads/${identity.branch}`)).toContain(identity.branch);
  });

  it('blocks dirty worktrees without removing them', async () => {
    const identity = await createIdentity('dirty');
    writeFileSync(join(identity.worktreePath, 'uncommitted.txt'), 'do not lose\n');

    await expect(service.verifyManagedWorktreeForFinalization(host, identity, false)).rejects.toThrow(/tracked, untracked, or conflicted/);

    expect(existsSync(join(identity.worktreePath, 'uncommitted.txt'))).toBe(true);
    expect(existsSync(identity.worktreePath)).toBe(true);
  });

  it('blocks recorded path and branch identity mismatches', async () => {
    const identity = await createIdentity('identity');

    await expect(service.verifyManagedWorktreeForFinalization(host, {
      ...identity,
      branch: 'spawnea/not-the-recorded-branch',
    }, false)).rejects.toThrow(/not checked out on recorded branch/);

    expect(existsSync(identity.worktreePath)).toBe(true);
  });
});
