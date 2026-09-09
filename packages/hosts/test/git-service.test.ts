import { describe, it, expect, beforeEach } from 'vitest';

import { GitService } from '../src/git-service.js';
import { MockHostAdapter } from '../src/mock-host.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

describe('GitService', () => {
  it('predicts real conflicts without changing HEAD, the index, or either checkout', async () => {
    const { LocalHostAdapter } = await import('../src/local-host.js');
    const path = await mkdtemp(join(tmpdir(), 'spawnea-preflight-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf8' }).trim();
    try {
      git('init', '-b', 'main');
      git('config', 'user.name', 'Fixture');
      git('config', 'user.email', 'fixture@example.test');
      await writeFile(join(path, 'shared.txt'), 'base\n');
      git('add', '.'); git('commit', '-m', 'base');
      const baseCommit = git('rev-parse', 'HEAD');
      git('checkout', '-b', 'child');
      await writeFile(join(path, 'shared.txt'), 'child\n');
      git('commit', '-am', 'child');
      git('checkout', 'main');
      await writeFile(join(path, 'shared.txt'), 'parent\n');
      git('commit', '-am', 'parent');
      const head = git('rev-parse', 'HEAD');
      const result = await new GitService().preflightManagedMerge(new LocalHostAdapter(), {
        repositoryPath: path, worktreePath: path, branch: 'child', baseBranch: 'main', baseCommit,
      });
      expect(result).toEqual({ hasConflicts: true, conflictingFiles: ['shared.txt'], parentCommits: [head], truncated: false });
      expect(git('rev-parse', 'HEAD')).toBe(head);
      expect(git('status', '--porcelain')).toBe('');
      expect(() => git('rev-parse', '--verify', 'MERGE_HEAD')).toThrow();
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });
  let gitService: GitService;
  let mockHost: MockHostAdapter;

  beforeEach(() => {
    gitService = new GitService();
    mockHost = new MockHostAdapter('mock-git-server');
  });

  it('preserves a conflict result even when Git reports no individual conflict paths', async () => {
    mockHost.customRules.push({ pattern: 'git merge-tree', response: {
      stdout: `${'a'.repeat(40)}\0\0`, stderr: '', exitCode: 1,
    } });
    await expect(gitService.preflightManagedMerge(mockHost, { repositoryPath: '/repo', worktreePath: '/repo/child', baseBranch: 'main', branch: 'child' }))
      .resolves.toMatchObject({ hasConflicts: true, conflictingFiles: [] });
  });

  it('discovers local branches and prioritizes the current branch in suggestions', async () => {
    mockHost.customRules.push(
      { pattern: 'git rev-parse --is-inside-work-tree', response: { stdout: 'true\n', stderr: '', exitCode: 0 } },
      { pattern: 'git branch --show-current', response: { stdout: 'develop\n', stderr: '', exitCode: 0 } },
      {
        pattern: "git for-each-ref --format='%(refname:short)' refs/heads",
        response: { stdout: 'main\ndevelop\nfeature/test\n', stderr: '', exitCode: 0 },
      }
    );

    const result = await gitService.discoverBranches(mockHost, '/repo');

    expect(result.isGitRepo).toBe(true);
    expect(result.currentBranch).toBe('develop');
    expect(result.branches).toEqual(['develop', 'feature/test', 'main']);
    expect(result.suggestedBranches).toEqual(['develop', 'main']);
  });

  it('reports non-Git paths without mutating the host', async () => {
    mockHost.customRules.push({
      pattern: 'git rev-parse --is-inside-work-tree',
      response: { stdout: '', stderr: 'not a repository', exitCode: 128 },
    });

    const result = await gitService.discoverBranches(mockHost, '/not-a-repo');

    expect(result).toEqual({
      isGitRepo: false,
      branches: [],
      suggestedBranches: [],
      error: 'Path is not a Git repository.',
    });
  });

  it('reports non-Git directories without marking them unavailable', async () => {
    mockHost.customRules.push({
      pattern: 'git rev-parse --is-inside-work-tree',
      response: { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 },
    });

    const status = await gitService.getGitStatus(mockHost, '/non-git-folder');

    expect(status.isGitRepo).toBe(false);
    expect(status.branch).toBe('');
    expect(status.isClean).toBe(true);
    expect(status.totalChanges).toBe(0);
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toEqual([]);
    expect(status.untracked).toEqual([]);
  });

  it('reports Git command failures as unavailable instead of clean', async () => {
    mockHost.customRules.push({
      pattern: 'git rev-parse --is-inside-work-tree',
      response: { stdout: '', stderr: 'permission denied', exitCode: 1 },
    });

    const status = await gitService.getGitStatus(mockHost, '/unavailable');

    expect(status.unavailable).toBe(true);
    expect(status.error).toBe('permission denied');
    expect(status.isClean).toBe(false);
  });

  it('parses clean Git repository status with branch and tracking info', async () => {
    mockHost.customRules.push(
      {
        pattern: 'git rev-parse --is-inside-work-tree',
        response: { stdout: 'true\n', stderr: '', exitCode: 0 },
      },
      {
        pattern: 'git branch --show-current',
        response: { stdout: 'main\n', stderr: '', exitCode: 0 },
      },
      {
        pattern: 'git rev-parse --abbrev-ref --symbolic-full-name @{upstream}',
        response: { stdout: 'origin/main\n', stderr: '', exitCode: 0 },
      },
      {
        pattern: 'git rev-list --left-right --count HEAD...@{upstream}',
        response: { stdout: '2\t1\n', stderr: '', exitCode: 0 },
      },
      {
        pattern: 'git status --porcelain=v1 -uall',
        response: { stdout: '', stderr: '', exitCode: 0 },
      }
    );

    const status = await gitService.getGitStatus(mockHost, '/repo');

    expect(status.isGitRepo).toBe(true);
    expect(status.branch).toBe('main');
    expect(status.trackingBranch).toBe('origin/main');
    expect(status.ahead).toBe(2);
    expect(status.behind).toBe(1);
    expect(status.isClean).toBe(true);
    expect(status.totalChanges).toBe(0);
  });

  it('reports a later Git status failure as unavailable instead of clean', async () => {
    mockHost.customRules.push(
      { pattern: 'git rev-parse --is-inside-work-tree', response: { stdout: 'true\n', stderr: '', exitCode: 0 } },
      { pattern: 'git branch --show-current', response: { stdout: 'main\n', stderr: '', exitCode: 0 } },
      { pattern: 'git rev-parse --abbrev-ref --symbolic-full-name @{upstream}', response: { stdout: '', stderr: '', exitCode: 1 } },
      { pattern: 'git status --porcelain=v1 -uall', response: { stdout: '', stderr: 'status timed out', exitCode: 124 } },
    );

    const status = await gitService.getGitStatus(mockHost, '/repo');

    expect(status.unavailable).toBe(true);
    expect(status.isClean).toBe(false);
    expect(status.error).toBe('status timed out');
  });

  it('correctly categorizes staged, unstaged, and untracked files', async () => {
    const mockPorcelain = [
      'M  src/staged-mod.ts',
      'A  src/staged-new.ts',
      'D  src/staged-del.ts',
      'R  src/old-name.ts -> src/new-name.ts',
      ' M src/unstaged-mod.ts',
      ' D src/unstaged-del.ts',
      'MM src/both-mod.ts',
      '?? src/untracked.ts',
      '?? docs/notes.md',
    ].join('\n');

    mockHost.customRules.push(
      {
        pattern: 'git rev-parse --is-inside-work-tree',
        response: { stdout: 'true\n', stderr: '', exitCode: 0 },
      },
      {
        pattern: 'git branch --show-current',
        response: { stdout: 'feat/pilot3\n', stderr: '', exitCode: 0 },
      },
      {
        pattern: 'git rev-parse --abbrev-ref --symbolic-full-name @{upstream}',
        response: { stdout: '', stderr: 'fatal: no upstream', exitCode: 1 },
      },
      {
        pattern: 'git status --porcelain=v1 -uall',
        response: { stdout: mockPorcelain, stderr: '', exitCode: 0 },
      }
    );

    const status = await gitService.getGitStatus(mockHost, '/repo');

    expect(status.isGitRepo).toBe(true);
    expect(status.branch).toBe('feat/pilot3');
    expect(status.isClean).toBe(false);
    expect(status.totalChanges).toBe(10); // 5 staged, 3 unstaged, 2 untracked

    // Staged items
    expect(status.staged.length).toBe(5);
    expect(status.staged.some((f) => f.path === 'src/staged-mod.ts' && f.status === 'modified')).toBe(true);
    expect(status.staged.some((f) => f.path === 'src/staged-new.ts' && f.status === 'added')).toBe(true);
    expect(status.staged.some((f) => f.path === 'src/staged-del.ts' && f.status === 'deleted')).toBe(true);
    expect(status.staged.some((f) => f.path === 'src/new-name.ts' && f.oldPath === 'src/old-name.ts' && f.status === 'renamed')).toBe(true);
    expect(status.staged.some((f) => f.path === 'src/both-mod.ts' && f.staged === true)).toBe(true);

    // Unstaged items
    expect(status.unstaged.length).toBe(3);
    expect(status.unstaged.some((f) => f.path === 'src/unstaged-mod.ts' && f.status === 'modified')).toBe(true);
    expect(status.unstaged.some((f) => f.path === 'src/unstaged-del.ts' && f.status === 'deleted')).toBe(true);
    expect(status.unstaged.some((f) => f.path === 'src/both-mod.ts' && f.staged === false)).toBe(true);

    // Untracked items
    expect(status.untracked.length).toBe(2);
    expect(status.untracked.some((f) => f.path === 'src/untracked.ts' && f.status === 'untracked')).toBe(true);
    expect(status.untracked.some((f) => f.path === 'docs/notes.md' && f.status === 'untracked')).toBe(true);
  });

  it('fetches and parses Git diff with hunks and line counts', async () => {
    const sampleRawDiff = `diff --git a/src/App.tsx b/src/App.tsx
index 1111111..2222222 100644
--- a/src/App.tsx
+++ b/src/App.tsx
@@ -1,5 +1,6 @@
 import React from 'react';
-import { OldHeader } from './OldHeader';
+import { NewHeader } from './NewHeader';
+import { ExtraBanner } from './ExtraBanner';
 
 export function App() {
@@ -10,3 +11,2 @@
-  return <OldHeader />;
+  return <NewHeader />;
 }
diff --git a/src/deleted-file.ts b/src/deleted-file.ts
deleted file mode 100644
index 3333333..0000000
--- a/src/deleted-file.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const deadCode = true;
-export default deadCode;
`;

    mockHost.customRules.push({
      pattern: 'git diff HEAD',
      response: { stdout: sampleRawDiff, stderr: '', exitCode: 0 },
    });

    const diffResult = await gitService.getGitDiff(mockHost, '/repo');

    expect(diffResult.totalFilesChanged).toBe(2);
    expect(diffResult.totalAdditions).toBe(3);
    expect(diffResult.totalDeletions).toBe(4);

    const firstFile = diffResult.files[0];
    expect(firstFile.path).toBe('src/App.tsx');
    expect(firstFile.additions).toBe(3);
    expect(firstFile.deletions).toBe(2);
    expect(firstFile.hunks.length).toBe(2);
    expect(firstFile.hunks[0].lines.some((l) => l.type === 'add' && l.content === "import { NewHeader } from './NewHeader';")).toBe(true);
    expect(firstFile.hunks[0].lines.some((l) => l.type === 'delete' && l.content === "import { OldHeader } from './OldHeader';")).toBe(true);

    const secondFile = diffResult.files[1];
    expect(secondFile.path).toBe('src/deleted-file.ts');
    expect(secondFile.isDeleted).toBe(true);
    expect(secondFile.deletions).toBe(2);
  });

  it('generates synthetic diff for untracked files when diffing specific path', async () => {
    mockHost.customRules.push({
      pattern: 'git diff HEAD -- src/new-file.ts',
      response: { stdout: '', stderr: '', exitCode: 0 },
    });

    mockHost.mockFiles.set('/repo/src/new-file.ts', {
      content: 'line 1\nline 2\nline 3',
      mimeType: 'text/plain',
      size: 20,
    });

    const diffResult = await gitService.getGitDiff(mockHost, '/repo', { filePath: 'src/new-file.ts' });

    expect(diffResult.totalFilesChanged).toBe(1);
    expect(diffResult.files[0].path).toBe('src/new-file.ts');
    expect(diffResult.files[0].isNew).toBe(true);
    expect(diffResult.files[0].additions).toBe(3);
  });
});
