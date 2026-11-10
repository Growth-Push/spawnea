import { describe, it, expect, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { GitService } from '../src/git-service.js';
import { LocalHostAdapter } from '../src/local-host.js';
import { MockHostAdapter } from '../src/mock-host.js';

function supportsRelativeWorktreeRepair() {
  const help = spawnSync('git', ['worktree', 'repair', '-h'], { encoding: 'utf8' });
  if (help.error) throw help.error;
  const output = `${help.stdout}${help.stderr}`;
  if (help.signal || (help.status !== 0 && help.status !== 129) || !output.includes('usage: git worktree repair ')) {
    throw new Error(`Unable to inspect Git worktree repair capabilities: ${output}`);
  }
  return /--(?:\[no-\])?relative-paths\b/.test(output);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'worktree-lock-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  await writeFile(join(root, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(root, 'tracked.txt'), 'original\n');
  git('add', '.');
  git('commit', '-m', 'Fixture base');
  const worktreePath = join(root, 'child');
  git('worktree', 'add', '-b', 'task', worktreePath);
  const lock = join(root, '.git', 'worktrees', 'child', 'index.lock');
  const identity = { repositoryPath: root, worktreePath, branch: 'task', baseBranch: 'main' };
  return { root, git, lock, identity, host: new LocalHostAdapter(), service: new GitService() };
}

describe('managed worktree lock safety with real Git', () => {
  it.each(['orphan', 'live'] as const)('preserves a %s lock, files and branch; allows separately recovered retry', async (kind) => {
    const f = await fixture();
    let holder: ReturnType<typeof spawn> | undefined;
    try {
      if (kind === 'live') {
        holder = spawn(process.execPath, ['-e', "const fs=require('node:fs'); const fd=fs.openSync(process.argv[1],'wx'); fs.writeSync(fd,'held'); console.log('ready'); process.stdin.resume();", f.lock], { stdio: ['pipe', 'pipe', 'pipe'] });
        await once(holder.stdout!, 'data');
      } else {
        await writeFile(f.lock, 'held');
      }
      const before = await stat(f.lock);
      expect(f.git('-C', f.identity.worktreePath, 'status', '--porcelain')).toBe('');
      expect(() => f.git('-C', f.identity.worktreePath, 'reset', '--hard', 'HEAD')).toThrow();
      for (const operation of [
        () => f.service.discardManagedWorktreeChanges(f.host, f.identity),
        () => f.service.stashManagedWorktreeChanges(f.host, f.identity),
        () => f.service.removeManagedWorktree(f.host, f.root, f.identity.worktreePath),
      ]) {
        await expect(operation()).rejects.toThrow('finalization is not complete');
        expect(await readFile(f.lock, 'utf8')).toBe('held');
        expect((await stat(f.lock)).ino).toBe(before.ino);
        expect(await readFile(join(f.identity.worktreePath, 'tracked.txt'), 'utf8')).toBe('original\n');
        expect(f.git('rev-parse', 'task')).toBe(f.git('rev-parse', 'main'));
      }
      if (holder) { holder.stdin!.end(); await once(holder, 'exit'); holder = undefined; }
      // Explicit recovery of this owned fixture only, never a product recovery path.
      await rm(f.lock);
      await f.service.discardManagedWorktreeChanges(f.host, f.identity);
      expect(await f.service.removeManagedWorktree(f.host, f.root, f.identity.worktreePath)).toBe(true);
      expect(f.git('rev-parse', 'task')).toBe(f.git('rev-parse', 'main'));
    } finally {
      if (holder) { holder.kill(); await once(holder, 'exit'); }
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it.for([
    { relativePaths: false, legacyRevParse: false },
    { relativePaths: true, legacyRevParse: false },
    { relativePaths: false, legacyRevParse: true },
    { relativePaths: true, legacyRevParse: true },
  ])('preserves missing-worktree registration and lock until recovery: %j', async ({ relativePaths, legacyRevParse }, context) => {
    if (relativePaths && !supportsRelativeWorktreeRepair()) {
      context.skip('Git worktree repair does not support --relative-paths');
    }
    const f = await fixture();
    try {
      if (legacyRevParse) {
        const execute = f.host.execute.bind(f.host);
        // Controlled compatibility boundary, not an installed historical Git binary.
        // Emulate pre-2.31 rev-parse echoing an unknown option with exit zero;
        // all supported commands still execute real Git on the fixture filesystem.
        vi.spyOn(f.host, 'execute').mockImplementation((command, options) => execute(
          `git() { if [ "$1" = rev-parse ] && [ "$2" = --path-format=absolute ]; then ` +
          `printf '%s\\n' "$2"; shift; shift; command git rev-parse "$@"; else command git "$@"; fi; }; ${command}`,
          options));
        const probe = await f.host.execute('git rev-parse --path-format=absolute --git-common-dir', { cwd: f.root });
        expect(probe.exitCode).toBe(0);
        expect(probe.stdout).toBe('--path-format=absolute\n.git\n');
      }
      if (relativePaths) {
        f.git('config', 'worktree.useRelativePaths', 'true');
        f.git('worktree', 'repair', '--relative-paths', f.identity.worktreePath);
      }
      const registrationPath = join(f.root, '.git', 'worktrees', 'child', 'gitdir');
      const registration = await readFile(registrationPath, 'utf8');
      expect(registration.startsWith('/')).toBe(!relativePaths);
      await writeFile(f.lock, 'retained');
      const inode = (await stat(f.lock)).ino;
      await rm(f.identity.worktreePath, { recursive: true });
      const listed = f.git('worktree', 'list', '--porcelain');
      await expect(f.service.removeManagedWorktree(f.host, f.root, f.identity.worktreePath)).rejects.toThrow('Git lock');
      expect(await readFile(f.lock, 'utf8')).toBe('retained');
      expect((await stat(f.lock)).ino).toBe(inode);
      expect(await readFile(registrationPath, 'utf8')).toBe(registration);
      expect(f.git('worktree', 'list', '--porcelain')).toBe(listed);
      // Recovery is authorized only for this owned fictional fixture.
      await rm(f.lock);
      expect(await f.service.removeManagedWorktree(f.host, f.root, f.identity.worktreePath)).toBe(true);
      await expect(stat(registrationPath)).rejects.toThrow();
      expect(f.git('rev-parse', 'task')).toBe(f.git('rev-parse', 'main'));
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('uses portable shell path resolution without realpath, including a symlinked ancestor and missing leaves', async () => {
    const f = await fixture();
    const alias = `${f.root}-alias`;
    const execute = f.host.execute.bind(f.host);
    // Controlled Linux coverage: any realpath invocation fails, without changing the host PATH.
    vi.spyOn(f.host, 'execute').mockImplementation((command, options) =>
      execute(`realpath() { printf 'realpath is unavailable\\n' >&2; return 97; }; ${command}`, options));
    try {
      await symlink(f.root, alias, 'dir');
      const identity = { ...f.identity, repositoryPath: alias, worktreePath: join(alias, 'child') };
      await f.service.discardManagedWorktreeChanges(f.host, identity);
      await writeFile(join(identity.worktreePath, 'tracked.txt'), 'portable stash');
      await f.service.stashManagedWorktreeChanges(f.host, identity);
      await writeFile(f.lock, 'portable retained lock');
      await expect(f.service.removeManagedWorktree(f.host, alias, identity.worktreePath)).rejects.toThrow('Git lock');
      await rm(identity.worktreePath, { recursive: true });
      await expect(f.service.removeManagedWorktree(f.host, alias, identity.worktreePath)).rejects.toThrow('Git lock');
      expect(await readFile(f.lock, 'utf8')).toBe('portable retained lock');
      await rm(f.lock);
      expect(await f.service.removeManagedWorktree(f.host, alias, identity.worktreePath)).toBe(true);
    } finally {
      await rm(alias, { force: true });
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('skips reset only when clean including ignored files, and preserves dirty discard/stash policies', async () => {
    const f = await fixture();
    const execute = vi.spyOn(f.host, 'execute');
    try {
      await f.service.discardManagedWorktreeChanges(f.host, f.identity);
      expect(execute.mock.calls.some(([cmd]) => cmd === 'git reset --hard HEAD')).toBe(false);
      await writeFile(join(f.identity.worktreePath, 'ignored.txt'), 'ignored');
      await writeFile(join(f.identity.worktreePath, 'tracked.txt'), 'changed');
      await f.service.stashManagedWorktreeChanges(f.host, f.identity);
      expect(f.git('stash', 'list')).toContain('Spawnea worktree: task');
      await writeFile(join(f.identity.worktreePath, 'ignored.txt'), 'discarded');
      await f.service.discardManagedWorktreeChanges(f.host, f.identity);
      expect(execute.mock.calls.some(([cmd]) => cmd === 'git reset --hard HEAD')).toBe(true);
      await expect(readFile(join(f.identity.worktreePath, 'ignored.txt'))).rejects.toThrow();
      // Normal removal must reject a tracked change arriving after the clean inspection.
      await writeFile(join(f.identity.worktreePath, 'tracked.txt'), 'late write');
      expect(await f.service.removeManagedWorktree(f.host, f.root, f.identity.worktreePath)).toBe(false);
      expect(await readFile(join(f.identity.worktreePath, 'tracked.txt'), 'utf8')).toBe('late write');
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it.each(['failed', 'unexpected', 'throw'] as const)('fails closed on %s lock inspection', async (kind) => {
    const host = new MockHostAdapter();
    host.customRules.push({ pattern: 'common=$(git', response: () => {
      if (kind === 'throw') throw new Error('transport unavailable');
      return { stdout: kind === 'unexpected' ? 'unexpected' : '', stderr: '', exitCode: kind === 'failed' ? 1 : 0 };
    } });
    await expect(new GitService().removeManagedWorktree(host, '/fictional/repo', '/fictional/child')).rejects.toThrow('inconclusive');
    expect(host.executedCommands).toHaveLength(1);
  });
});

describe('operator-confirmed lock release with real Git', () => {
  it('backs up and removes worktree locks, then lets a dirty close discard and remove the worktree', async () => {
    const f = await fixture();
    try {
      await writeFile(f.lock, 'held');
      await writeFile(join(f.identity.worktreePath, 'tracked.txt'), 'changed\n');
      await expect(f.service.discardManagedWorktreeChanges(f.host, f.identity)).rejects.toThrow('[git-lock-blocked]');

      const released = await f.service.backupAndReleaseWorktreeLocks(f.host, f.identity.worktreePath, new Date('2026-11-10T12:00:00.000Z'));
      expect(released?.locks).toEqual(['index.lock']);
      const backupPath = released!.backupPath;
      expect(backupPath.startsWith(join(f.root, '.git', 'spawnea-lock-backups', 'child-2026-11-10T12-00-00-000Z-'))).toBe(true);
      expect(await readFile(join(backupPath, 'index.lock'), 'utf8')).toBe('held');
      await expect(stat(f.lock)).rejects.toThrow();

      await f.service.discardManagedWorktreeChanges(f.host, f.identity);
      await expect(f.service.removeManagedWorktree(f.host, f.root, f.identity.worktreePath)).resolves.toBe(true);
      expect(f.git('branch', '--list', 'task')).toContain('task');
      expect(await readFile(join(backupPath, 'index.lock'), 'utf8')).toBe('held');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('returns null without creating a backup when no lock exists', async () => {
    const f = await fixture();
    try {
      await expect(f.service.backupAndReleaseWorktreeLocks(f.host, f.identity.worktreePath)).resolves.toBeNull();
      await expect(stat(join(f.root, '.git', 'spawnea-lock-backups'))).rejects.toThrow();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('leaves every lock in place when a non-regular *.lock entry exists', async () => {
    const f = await fixture();
    try {
      await writeFile(f.lock, 'held');
      await mkdir(join(f.root, '.git', 'worktrees', 'child', 'odd.lock'));
      await expect(f.service.backupAndReleaseWorktreeLocks(f.host, f.identity.worktreePath)).rejects.toThrow('need manual handling');
      expect(await readFile(f.lock, 'utf8')).toBe('held');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('refuses to release locks of the primary checkout', async () => {
    const f = await fixture();
    const primaryLock = join(f.root, '.git', 'index.lock');
    try {
      await writeFile(primaryLock, 'held');
      await expect(f.service.backupAndReleaseWorktreeLocks(f.host, f.root)).rejects.toThrow('Could not back up and release Git locks');
      expect(await readFile(primaryLock, 'utf8')).toBe('held');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
