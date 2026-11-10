import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, symlink, realpath, cp, rm, chmod, open, lstat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { WorktreeLockRecovery, inspectActivity, type RecoveryReceipt } from './worktree-lock-recovery.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lock-recovery-'))); roots.push(root);
  const repo = join(root, 'repo'); await mkdir(repo);
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.test');
  await writeFile(join(repo, 'tracked'), 'base\n'); await writeFile(join(repo, '.gitignore'), 'ignored\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'Fixture');
  const worktreePath = join(root, 'task'); git(repo, 'worktree', 'add', '-qb', 'task', worktreePath);
  await writeFile(join(worktreePath, 'tracked'), 'staged\n'); git(worktreePath, 'add', 'tracked');
  await writeFile(join(worktreePath, 'tracked'), 'working\n'); await writeFile(join(worktreePath, 'untracked'), 'untracked\n'); await writeFile(join(worktreePath, 'ignored'), 'ignored\n'); await symlink('tracked', join(worktreePath, 'link'));
  const admin = git(worktreePath, 'rev-parse', '--absolute-git-dir');
  const lock = join(admin, 'index.lock'); await writeFile(lock, 'unknown-owner');
  return { root, repo, worktreePath, admin, lock, target: { sessionId: 'fixture-session', repositoryPath: repo, worktreePath, branch: 'task' } };
}

describe.runIf(process.platform === 'linux')('Linux backup durability and restoration', () => {
it('backs up and restores staged, working, untracked, ignored and symlink data with Git objects', async () => {
  const f = await fixture(); const recovery = new WorktreeLockRecovery();
  expect(git(f.repo, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  const lockIdentity = await lstat(f.lock);
  const plan = await recovery.prepare(f.target);
  const backupRoot = join(f.root, 'new', 'nested', 'backups');
  const backup = await recovery.recover(plan, backupRoot);
  const receipt = await new WorktreeLockRecovery().findReceipt(backupRoot, f.target.sessionId);
  expect(receipt?.state).toBe('quarantined');
  expect(receipt?.startedAt).toEqual(expect.any(Number));
  expect(await readFile(receipt!.quarantinePath, 'utf8')).toBe('unknown-owner');
  expect(git(f.repo, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  expect(relative(f.repo, receipt!.quarantinePath).startsWith('../')).toBe(true);
  expect(relative(f.worktreePath, receipt!.quarantinePath).startsWith('../')).toBe(true);
  expect(relative(plan.common, receipt!.quarantinePath).startsWith('../')).toBe(true);
  const quarantinedIdentity = await lstat(receipt!.quarantinePath);
  expect(quarantinedIdentity.dev).toBe(lockIdentity.dev);
  expect(quarantinedIdentity.ino).toBe(lockIdentity.ino);
  const restored = join(f.root, 'restored'); await cp(join(backup, 'worktree'), restored, { recursive: true, verbatimSymlinks: true });
  const metadata = join(f.root, 'restored-git'); await cp(join(backup, 'git-common'), metadata, { recursive: true });
  const restoredAdmin = join(metadata, relative(join(f.repo, '.git'), f.admin));
  await writeFile(join(restored, '.git'), `gitdir: ${restoredAdmin}\n`); await writeFile(join(restoredAdmin, 'gitdir'), join(restored, '.git'));
  await rm(join(restoredAdmin, 'index.lock'));
  expect(git(restored, 'show', ':tracked')).toBe('staged');
  expect(await readFile(join(restored, 'tracked'), 'utf8')).toBe('working\n');
  expect(await readFile(join(restored, 'untracked'), 'utf8')).toBe('untracked\n');
  expect(await readFile(join(restored, 'ignored'), 'utf8')).toBe('ignored\n');
  expect(await readFile(join(restored, 'link'), 'utf8')).toBe('working\n');
  expect(git(restored, 'show', 'HEAD:tracked')).toBe('base');
  expect(git(f.repo, 'rev-parse', '--verify', 'task')).not.toBe('');
}, 20000);

it('fails before quarantine when a newly created backup ancestor cannot be synced', async () => {
  const f = await fixture(); const recovery = new WorktreeLockRecovery(); const plan = await recovery.prepare(f.target);
  const parent = join(f.root, 'backup-parent'); await mkdir(parent); await chmod(parent, 0o300);
  const root = join(parent, 'new', 'nested');
  try { await expect(recovery.recover(plan, root)).rejects.toMatchObject({ code: 'EACCES' }); }
  finally { await chmod(parent, 0o700); }
  // mkdir and traversal were permitted; opening the ancestor for fsync was not.
  expect(await realpath(root)).toBe(root);
  expect(await recovery.findReceipt(root, f.target.sessionId)).toBeUndefined();
  expect(await readFile(f.lock, 'utf8')).toBe('unknown-owner');
  expect(await readFile(join(f.worktreePath, 'tracked'), 'utf8')).toBe('working\n');
});
});

it('selects receipt chronology and verified state instead of adverse UUID order', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'recovery-receipts-'))); roots.push(root);
  const target = { sessionId: 'fixture-session', repositoryPath: join(root, 'repo'), worktreePath: join(root, 'task'), branch: 'task' };
  const save = async (id: string, startedAt: number, state: RecoveryReceipt['state']) => {
    const backupPath = join(root, id); await mkdir(backupPath, { recursive: true });
    const receipt: RecoveryReceipt = { target, backupPath, quarantinePath: join(root, 'quarantine', id), startedAt, state };
    await writeFile(join(backupPath, 'recovery.json'), JSON.stringify(receipt));
    return receipt;
  };
  await save('ffffffff-ffff-4fff-afff-ffffffffffff', 100, 'quarantined');
  const latest = await save('00000000-0000-4000-a000-000000000000', 200, 'verified');
  const recovery = new WorktreeLockRecovery();
  expect(await recovery.findReceipt(root, target.sessionId)).toEqual(latest);
  await save('eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee', 300, 'backing-up');
  expect(await recovery.findReceipt(root, target.sessionId)).toEqual(latest);
  const newest = await save('11111111-1111-4111-a111-111111111111', 400, 'quarantined');
  expect(await new WorktreeLockRecovery().findReceipt(root, target.sessionId)).toEqual(newest);
});

it.each(['darwin', 'win32'])('rejects integrated recovery on unsupported %s before filesystem inspection', async (platform) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    const target = { sessionId: 'unsupported-session', repositoryPath: '/nonexistent/repo', worktreePath: '/nonexistent/task', branch: 'task' };
    await expect(new WorktreeLockRecovery().prepare(target)).rejects.toThrow('Integrated recovery is currently supported only on local Linux.');
    await expect(inspectActivity('/nonexistent/index.lock')).rejects.toThrow('Recovery requires local Linux process inspection.');
  } finally { Object.defineProperty(process, 'platform', descriptor); }
});

describe.runIf(process.platform === 'linux')('Linux process inspection and recovery guards', () => {
it('retains the exact lock and data after late worktree writes', async () => {
  const f = await fixture(); const recovery = new WorktreeLockRecovery(); const plan = await recovery.prepare(f.target);
  await writeFile(join(f.worktreePath, 'untracked'), 'late');
  await expect(recovery.recover(plan, join(f.root, 'backups'))).rejects.toThrow('changed');
  expect(await readFile(f.lock, 'utf8')).toBe('unknown-owner');
  expect(await readFile(join(f.worktreePath, 'untracked'), 'utf8')).toBe('late');
}, 20000);

it('distinguishes unknown descriptors, Git activity, observed holders and unreadable identities', async () => {
  const f = await fixture(); const proc = join(f.root, 'proc'); const processPath = join(proc, '987654');
  await mkdir(join(processPath, 'fd'), { recursive: true });
  await writeFile(join(processPath, 'comm'), 'fixture-worker');
  await chmod(join(processPath, 'fd'), 0);
  try { expect(await inspectActivity(f.lock, proc)).toBe(true); }
  finally { await chmod(join(processPath, 'fd'), 0o700); }
  await writeFile(join(processPath, 'comm'), 'git');
  await expect(inspectActivity(f.lock, proc)).rejects.toThrow('Git activity');
  await writeFile(join(processPath, 'comm'), 'fixture-worker');
  await symlink(f.lock, join(processPath, 'fd', '4'));
  await expect(inspectActivity(f.lock, proc)).rejects.toThrow('holder');
  await chmod(join(processPath, 'comm'), 0);
  try { await expect(inspectActivity(f.lock, proc)).rejects.toMatchObject({ code: 'EACCES' }); }
  finally { await chmod(join(processPath, 'comm'), 0o600); }
});

it('blocks an actual open holder without changing the lock', async () => {
  const f = await fixture(); const file = await open(f.lock, 'r');
  try { await expect(new WorktreeLockRecovery().prepare(f.target)).rejects.toThrow('holder'); }
  finally { await file.close(); }
  expect(await readFile(f.lock, 'utf8')).toBe('unknown-owner');
});

it('rejects replaced lock identity and backup failure without removing data', async () => {
  const f = await fixture(); const recovery = new WorktreeLockRecovery(); const plan = await recovery.prepare(f.target);
  const held = await open(f.lock, 'r');
  await rm(f.lock); await writeFile(f.lock, 'unknown-owner'); await held.close();
  await expect(recovery.recover(plan, join(f.root, 'backups'))).rejects.toThrow('changed');
  const fresh = await recovery.prepare(f.target); const invalid = join(f.root, 'not-a-directory'); await writeFile(invalid, 'blocked');
  await expect(recovery.recover(fresh, invalid)).rejects.toThrow();
  expect(await readFile(f.lock, 'utf8')).toBe('unknown-owner');
});

it('allows only one concurrent recovery and rediscovers a durable receipt after restart', async () => {
  const f = await fixture(); const recovery = new WorktreeLockRecovery(); const plan = await recovery.prepare(f.target);
  const root = join(f.root, 'backups');
  const results = await Promise.allSettled([recovery.recover(plan, root), recovery.recover(plan, root)]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const receipt = await new WorktreeLockRecovery().findReceipt(root, f.target.sessionId);
  expect(receipt?.state).toBe('quarantined');
  expect(await readFile(receipt!.quarantinePath, 'utf8')).toBe('unknown-owner');
  expect(git(f.repo, 'rev-parse', '--verify', 'task')).not.toBe('');
}, 20000);

it('rediscovers the pre-move receipt when the post-quarantine journal write fails', async () => {
  const f = await fixture(); const root = join(f.root, 'backups'); let calls = 0; let backup = '';
  class InterruptedRecovery extends WorktreeLockRecovery {
    override async prepare(target: Parameters<WorktreeLockRecovery['prepare']>[0]) {
      const plan = await super.prepare(target);
      if (++calls === 3) await chmod(backup, 0o500);
      return plan;
    }
  }
  const recovery = new InterruptedRecovery(); const plan = await recovery.prepare(f.target); backup = join(root, plan.id);
  try { await expect(recovery.recover(plan, root)).rejects.toMatchObject({ code: 'EACCES' }); }
  finally { await chmod(backup, 0o700); }
  const receipt = await new WorktreeLockRecovery().findReceipt(root, f.target.sessionId);
  expect(receipt?.state).toBe('verified');
  expect(await readFile(receipt!.quarantinePath, 'utf8')).toBe('unknown-owner');
  await expect(readFile(f.lock)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(backup, 'worktree', 'tracked'), 'utf8')).toBe('working\n');
  expect(git(f.repo, 'rev-parse', '--verify', 'task')).not.toBe('');
}, 20000);
});
