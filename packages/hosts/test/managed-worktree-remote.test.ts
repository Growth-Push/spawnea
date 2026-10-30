import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitService, LocalHostAdapter } from '../src/index.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('managed Git worktrees with remote base', () => {
  let tempRoot: string;
  let remotePath: string;
  let repositoryPath: string;
  let host: LocalHostAdapter;
  let service: GitService;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'spawnea-remote-wt-'));
    remotePath = join(tempRoot, 'remote.git');
    repositoryPath = join(tempRoot, 'project');

    // Create bare remote repository
    git(tempRoot, 'init', '--bare', '--initial-branch=main', remotePath);

    // Initialize local project and push initial commit to origin
    git(tempRoot, 'init', '--initial-branch=main', repositoryPath);
    git(repositoryPath, 'config', 'user.email', 'test@example.invalid');
    git(repositoryPath, 'config', 'user.name', 'Spawnea Test');
    writeFileSync(join(repositoryPath, 'README.md'), 'initial\n');
    git(repositoryPath, 'add', 'README.md');
    git(repositoryPath, 'commit', '-m', 'initial commit');
    git(repositoryPath, 'remote', 'add', 'origin', remotePath);
    git(repositoryPath, 'push', '-u', 'origin', 'main');

    host = new LocalHostAdapter({ serverId: 'test-local' });
    service = new GitService();
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(`${repositoryPath}__worktrees`, { recursive: true, force: true });
  });

  it('fetches remote branch from origin and resolves the refreshed commit SHA', async () => {
    // Push a new commit to origin from a separate temp clone
    const pusherPath = join(tempRoot, 'pusher');
    git(tempRoot, 'clone', remotePath, pusherPath);
    git(pusherPath, 'config', 'user.email', 'test@example.invalid');
    git(pusherPath, 'config', 'user.name', 'Spawnea Test');
    writeFileSync(join(pusherPath, 'README.md'), 'updated on remote\n');
    git(pusherPath, 'commit', '-am', 'second commit');
    git(pusherPath, 'push', 'origin', 'main');
    const remoteHeadSha = git(pusherPath, 'rev-parse', 'HEAD');

    // Local repository still points to initial commit and origin/main is stale
    const localMainBefore = git(repositoryPath, 'rev-parse', 'main');
    const localOriginMainBefore = git(repositoryPath, 'rev-parse', 'origin/main');
    expect(localMainBefore).not.toBe(remoteHeadSha);
    expect(localOriginMainBefore).not.toBe(remoteHeadSha);

    // Fetch and resolve remote base commit
    const result = await service.fetchRemoteBranchCommit(host, repositoryPath, 'main');
    expect(result.branch).toBe('main');
    expect(result.commit).toBe(remoteHeadSha);

    // Also supports origin/main prefix
    const prefixedResult = await service.fetchRemoteBranchCommit(host, repositoryPath, 'origin/main');
    expect(prefixedResult.branch).toBe('main');
    expect(prefixedResult.commit).toBe(remoteHeadSha);
  });

  it('bounds fetch execution and propagates timeout failures', async () => {
    const execute = host.execute.bind(host);
    const spy = vi.spyOn(host, 'execute').mockImplementation(async (command, options) => {
      if (command.startsWith('git fetch ')) {
        expect(options?.timeoutMs).toBe(60_000);
        throw new Error('Command timed out after 60000ms');
      }
      return execute(command, options);
    });
    await expect(service.fetchRemoteBranchCommit(host, repositoryPath, 'main')).rejects.toThrow('timed out');
    expect(spy.mock.calls.some(([command]) => command.startsWith('git fetch '))).toBe(true);
    expect(await service.listWorktrees(host, repositoryPath)).toEqual([]);
  });

  it('fails if origin remote is not configured', async () => {
    const noRemotePath = join(tempRoot, 'no-remote');
    git(tempRoot, 'init', '--initial-branch=main', noRemotePath);
    git(noRemotePath, 'config', 'user.email', 'test@example.invalid');
    git(noRemotePath, 'config', 'user.name', 'Spawnea Test');
    writeFileSync(join(noRemotePath, 'README.md'), 'no remote\n');
    git(noRemotePath, 'add', 'README.md');
    git(noRemotePath, 'commit', '-m', 'commit');

    await expect(
      service.fetchRemoteBranchCommit(host, noRemotePath, 'main')
    ).rejects.toThrow("Remote 'origin' is not configured");
  });

  it('fails if the specified remote branch does not exist on origin', async () => {
    await expect(
      service.fetchRemoteBranchCommit(host, repositoryPath, 'nonexistent-branch')
    ).rejects.toThrow("Failed to fetch remote branch 'origin/nonexistent-branch'");
  });

  it('creates worktree pinned to resolved baseCommit while coordinator is on another branch', async () => {
    // Push new commit to origin
    const pusherPath = join(tempRoot, 'pusher');
    git(tempRoot, 'clone', remotePath, pusherPath);
    git(pusherPath, 'config', 'user.email', 'test@example.invalid');
    git(pusherPath, 'config', 'user.name', 'Spawnea Test');
    writeFileSync(join(pusherPath, 'README.md'), 'remote update\n');
    git(pusherPath, 'commit', '-am', 'second commit');
    git(pusherPath, 'push', 'origin', 'main');
    const expectedSha = git(pusherPath, 'rev-parse', 'HEAD');

    // Switch coordinator/primary repo to another branch
    git(repositoryPath, 'checkout', '-b', 'spawnea/task-coordinator');
    writeFileSync(join(repositoryPath, 'coord.txt'), 'coordinator work\n');
    git(repositoryPath, 'add', 'coord.txt');
    git(repositoryPath, 'commit', '-m', 'coordinator commit');
    const coordHeadSha = git(repositoryPath, 'rev-parse', 'HEAD');

    // Fetch refreshed commit
    const fetched = await service.fetchRemoteBranchCommit(host, repositoryPath, 'main');
    expect(fetched.commit).toBe(expectedSha);

    // Create managed worktree from pinned baseCommit
    const worktree = await service.createManagedWorktree({
      host,
      repositoryPath,
      taskSlug: 'child-task',
      sessionSuffix: 'c001',
      baseBranch: 'main',
      baseCommit: fetched.commit,
    });

    // Validations:
    // 1. Returned baseCommit matches refreshed commit
    expect(worktree.baseCommit).toBe(expectedSha);
    expect(worktree.baseBranch).toBe('main');

    // 2. Initial child HEAD matches refreshed SHA
    const childHeadSha = git(worktree.worktreePath, 'rev-parse', 'HEAD');
    expect(childHeadSha).toBe(expectedSha);

    // 3. Coordinator checkout is completely unchanged
    expect(git(repositoryPath, 'branch', '--show-current')).toBe('spawnea/task-coordinator');
    expect(git(repositoryPath, 'rev-parse', 'HEAD')).toBe(coordHeadSha);
  });

  it('creates worktree from an explicit remote branch differing from configuration', async () => {
    // Create 'develop' branch on origin
    const pusherPath = join(tempRoot, 'pusher');
    git(tempRoot, 'clone', remotePath, pusherPath);
    git(pusherPath, 'config', 'user.email', 'test@example.invalid');
    git(pusherPath, 'config', 'user.name', 'Spawnea Test');
    git(pusherPath, 'checkout', '-b', 'develop');
    writeFileSync(join(pusherPath, 'dev.txt'), 'develop branch\n');
    git(pusherPath, 'add', 'dev.txt');
    git(pusherPath, 'commit', '-m', 'develop commit');
    git(pusherPath, 'push', '-u', 'origin', 'develop');
    const devSha = git(pusherPath, 'rev-parse', 'HEAD');

    // Local repository has not checked out develop
    expect(git(repositoryPath, 'branch', '--list', 'develop')).toBe('');

    // Fetch and create worktree from develop
    const fetched = await service.fetchRemoteBranchCommit(host, repositoryPath, 'develop');
    expect(fetched.commit).toBe(devSha);

    const worktree = await service.createManagedWorktree({
      host,
      repositoryPath,
      taskSlug: 'feature-task',
      sessionSuffix: 'c002',
      baseBranch: 'develop',
      baseCommit: fetched.commit,
    });

    expect(worktree.baseCommit).toBe(devSha);
    expect(worktree.baseBranch).toBe('develop');
    expect(git(worktree.worktreePath, 'rev-parse', 'HEAD')).toBe(devSha);
    expect(git(repositoryPath, 'branch', '--show-current')).toBe('main');
    expect((await service.inspectManagedWorktree(host, worktree)).state).toBe('active');
    await service.verifyManagedWorktreeForFinalization(host, worktree, false);
    await expect(service.verifyManagedWorktreeForFinalization(host, worktree, true)).rejects.toThrow('does not exist locally');
    await expect(service.verifyManagedWorktreeForFinalization(host, { ...worktree, branch: 'wrong-task' }, false)).rejects.toThrow('recorded branch');
    await expect(service.verifyManagedWorktreeForFinalization(host, { ...worktree, repositoryPath: worktree.worktreePath }, false)).rejects.toThrow('primary worktree');
    writeFileSync(join(worktree.worktreePath, 'dirty.txt'), 'unsaved');
    await expect(service.verifyManagedWorktreeForFinalization(host, worktree, false)).rejects.toThrow('changes');
    await service.verifyManagedWorktreeForFinalization(host, worktree, false, false);
    expect(git(repositoryPath, 'branch', '--list', 'develop')).toBe('');
  });

  it.each(['origin/topic', 'release'])('inspects the exact remote base %s despite a conflicting ref', async (baseBranch) => {
    const selectedBase = git(repositoryPath, 'rev-parse', 'HEAD');
    git(repositoryPath, 'push', 'origin', `HEAD:refs/heads/${baseBranch}`);
    const fetched = await service.fetchRemoteBranchCommit(host, repositoryPath, `origin/${baseBranch}`);
    const worktree = await service.createManagedWorktree({
      host, repositoryPath, taskSlug: 'inspection', sessionSuffix: 'conflicting-ref',
      baseBranch: fetched.branch, baseCommit: fetched.commit,
    });
    git(worktree.worktreePath, 'config', 'user.email', 'test@example.invalid');
    git(worktree.worktreePath, 'config', 'user.name', 'Spawnea Test');
    writeFileSync(join(worktree.worktreePath, 'task.txt'), 'unintegrated task commit');
    git(worktree.worktreePath, 'add', 'task.txt');
    git(worktree.worktreePath, 'commit', '-m', 'advance task beyond selected base');
    const taskCommit = git(worktree.worktreePath, 'rev-parse', 'HEAD');
    expect(taskCommit).not.toBe(selectedBase);

    if (baseBranch === 'origin/topic') {
      // The shorter remote topic contains the task, but the selected origin/topic does not.
      git(worktree.worktreePath, 'push', 'origin', 'HEAD:refs/heads/topic');
      expect(git(repositoryPath, 'rev-parse', 'refs/remotes/origin/topic')).toBe(taskCommit);
    } else {
      // A tag must not masquerade as an absent local base branch.
      git(repositoryPath, 'tag', 'release', taskCommit);
    }
    expect(git(repositoryPath, 'branch', '--list', baseBranch)).toBe('');
    expect(git(repositoryPath, 'rev-parse', `refs/remotes/origin/${baseBranch}`)).toBe(selectedBase);
    expect((await service.inspectManagedWorktree(host, worktree)).state).toBe('active');
    expect(git(repositoryPath, 'branch', '--list', baseBranch)).toBe('');

    // A real local base remains preferred when present, even if origin has not advanced.
    git(repositoryPath, 'branch', baseBranch, taskCommit);
    expect((await service.inspectManagedWorktree(host, worktree)).state).toBe('integrated');
    expect(git(repositoryPath, 'rev-parse', `refs/remotes/origin/${baseBranch}`)).toBe(selectedBase);
  });

  it('rejects invalid or non-existent baseCommit', async () => {
    await expect(
      service.createManagedWorktree({
        host,
        repositoryPath,
        taskSlug: 'invalid-task',
        sessionSuffix: 'c003',
        baseBranch: 'main',
        baseCommit: 'not-a-valid-sha',
      })
    ).rejects.toThrow("Invalid base commit ID 'not-a-valid-sha'");

    await expect(
      service.createManagedWorktree({
        host,
        repositoryPath,
        taskSlug: 'missing-commit-task',
        sessionSuffix: 'c004',
        baseBranch: 'main',
        baseCommit: '0123456789abcdef0123456789abcdef01234567',
      })
    ).rejects.toThrow("Could not resolve creation commit '0123456789abcdef0123456789abcdef01234567' in repository");
  });
});
