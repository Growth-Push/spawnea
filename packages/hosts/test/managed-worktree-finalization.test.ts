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

  it('refuses to remove a present dirty worktree when normal removal fails', async () => {
    const identity = await createIdentity('refuse-force');
    writeFileSync(join(identity.worktreePath, 'dirty.txt'), 'do not lose\n');

    expect(await service.removeManagedWorktree(host, repositoryPath, identity.worktreePath)).toBe(false);
    expect(existsSync(join(identity.worktreePath, 'dirty.txt'))).toBe(true);
    expect(existsSync(identity.worktreePath)).toBe(true);
  });

  it('drops stale registration when worktree directory is already absent', async () => {
    const identity = await createIdentity('stale-absent');
    rmSync(identity.worktreePath, { recursive: true, force: true });
    expect(existsSync(identity.worktreePath)).toBe(false);

    expect(await service.removeManagedWorktree(host, repositoryPath, identity.worktreePath)).toBe(true);
    expect(git(repositoryPath, 'worktree', 'list')).not.toContain(identity.worktreePath);
  });

  it('preserves locked worktree registration when directory is absent and reports false', async () => {
    const identity = await createIdentity('stale-locked-absent');
    git(repositoryPath, 'worktree', 'lock', identity.worktreePath);
    rmSync(identity.worktreePath, { recursive: true, force: true });
    expect(existsSync(identity.worktreePath)).toBe(false);

    expect(await service.removeManagedWorktree(host, repositoryPath, identity.worktreePath)).toBe(false);
    expect(git(repositoryPath, 'worktree', 'list')).toContain(identity.worktreePath);
  });

  it('returns true when worktree directory is absent and was already unregistered in Git', async () => {
    const identity = await createIdentity('already-unregistered');
    rmSync(identity.worktreePath, { recursive: true, force: true });
    expect(await service.removeManagedWorktree(host, repositoryPath, identity.worktreePath)).toBe(true);
    expect(await service.removeManagedWorktree(host, repositoryPath, identity.worktreePath)).toBe(true);
  });

  it('refuses removal and protects uncommitted work if worktree directory reappears with dirty files', async () => {
    const identity = await createIdentity('race-reappear');
    git(repositoryPath, 'worktree', 'lock', identity.worktreePath);

    // Directory exists with uncommitted file
    writeFileSync(join(identity.worktreePath, 'reappeared.txt'), 'valuable unsaved work\n');

    expect(await service.removeManagedWorktree(host, repositoryPath, identity.worktreePath)).toBe(false);
    expect(existsSync(join(identity.worktreePath, 'reappeared.txt'))).toBe(true);
    expect(git(repositoryPath, 'worktree', 'list')).toContain(identity.worktreePath);
  });

  it('correctly verifies worktree absence and ancestor accessibility', async () => {
    const identity = await createIdentity('absence-check');
    expect(await service.isWorktreeAbsent(host, identity.worktreePath)).toBe(false);

    rmSync(identity.worktreePath, { recursive: true, force: true });
    expect(await service.isWorktreeAbsent(host, identity.worktreePath)).toBe(true);

    // Also absent when parent container was removed
    const deepAbsentPath = join(tempRoot, 'deleted-parent', 'sub', 'wt');
    expect(await service.isWorktreeAbsent(host, deepAbsentPath)).toBe(true);

    // Returns false if nearest existing ancestor is not a directory
    const fileAncestor = join(tempRoot, 'file-ancestor');
    writeFileSync(fileAncestor, 'not a directory');
    expect(await service.isWorktreeAbsent(host, join(fileAncestor, 'child'))).toBe(false);
  });

  it.each(['unrelated', 'detached'] as const)('reports mismatch for an advanced merged task with an %s checkout', async (checkout) => {
    const identity = await createIdentity(`merged-${checkout}`);
    writeFileSync(join(identity.worktreePath, 'feature.txt'), 'integrated task work\n');
    git(identity.worktreePath, 'add', 'feature.txt');
    git(identity.worktreePath, 'commit', '-m', 'implement task');
    git(repositoryPath, 'merge', '--ff-only', identity.branch);
    if (checkout === 'unrelated') {
      git(identity.worktreePath, 'switch', '-c', 'unrelated-feature');
    } else {
      git(identity.worktreePath, 'switch', '--detach');
    }

    const inspection = await service.inspectManagedWorktree(host, identity);

    expect(inspection.state).toBe('mismatch');
    expect(inspection.currentBranch).toBe(checkout === 'unrelated' ? 'unrelated-feature' : undefined);
    expect(inspection.message).toContain(checkout === 'unrelated' ? 'unrelated-feature' : 'detached HEAD');
    expect(inspection.message).toContain(identity.branch);
    await expect(service.verifyManagedWorktreeForFinalization(host, identity, false, false, true))
      .rejects.toThrow(/not checked out on recorded branch/);
    expect(existsSync(join(identity.worktreePath, 'feature.txt'))).toBe(true);
    expect(git(repositoryPath, 'show-ref', '--verify', `refs/heads/${identity.branch}`)).toContain(identity.branch);
  });

  it('detects real Git branch mismatch and protects all tracked, untracked, and ignored files', async () => {
    const identity = await createIdentity('mismatch-real');
    // Check out a genuinely different branch in the worktree
    git(identity.worktreePath, 'checkout', '-b', 'feature-divergent');
    writeFileSync(join(identity.worktreePath, 'tracked.txt'), 'committed on divergent branch\n');
    git(identity.worktreePath, 'add', 'tracked.txt');
    git(identity.worktreePath, 'commit', '-m', 'divergent commit');

    // Add untracked and ignored files
    writeFileSync(join(identity.worktreePath, 'untracked.txt'), 'untracked work\n');
    writeFileSync(join(identity.worktreePath, '.gitignore'), 'ignored.txt\n');
    writeFileSync(join(identity.worktreePath, 'ignored.txt'), 'ignored work\n');

    // 1. inspectManagedWorktree reports mismatch state with actual branch
    const inspection = await service.inspectManagedWorktree(host, identity);
    expect(inspection.state).toBe('mismatch');
    expect(inspection.currentBranch).toBe('feature-divergent');
    expect(inspection.message).toContain('feature-divergent');
    expect(inspection.message).toContain(identity.branch);

    // 2. Destructive verification throws with actionable message
    await expect(service.verifyManagedWorktreeForFinalization(host, identity, false)).rejects.toThrow(
      /not checked out on recorded branch.*feature-divergent/
    );

    // 3. Worktree, branches, and all files remain intact
    expect(existsSync(join(identity.worktreePath, 'tracked.txt'))).toBe(true);
    expect(existsSync(join(identity.worktreePath, 'untracked.txt'))).toBe(true);
    expect(existsSync(join(identity.worktreePath, 'ignored.txt'))).toBe(true);
    expect(git(identity.worktreePath, 'branch', '--show-current')).toBe('feature-divergent');
    expect(git(repositoryPath, 'branch', '--list', identity.branch)).toContain(identity.branch);
  });
});
