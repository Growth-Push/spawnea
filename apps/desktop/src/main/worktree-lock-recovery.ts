import { constants } from 'node:fs';
import { access, cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export interface RecoveryIdentity { repositoryPath: string; worktreePath: string; branch: string; sessionId: string }
export interface RecoveryReceipt { target: RecoveryIdentity; backupPath: string; quarantinePath: string; startedAt?: number; state: 'backing-up' | 'verified' | 'quarantined' }
interface Snapshot { content: string; identity: string }
export interface RecoveryPlan {
  id: string;
  target: RecoveryIdentity;
  common: string;
  admin: string;
  lock: string;
  worktree: Snapshot;
  metadata: Snapshot;
  partialVisibility: boolean;
}

function contained(root: string, path: string): boolean {
  const r = relative(root, path);
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !r.startsWith(sep));
}

/** Read links as links, reject special files, and detect writes during hashing. */
async function snapshot(root: string, allowLinks: boolean): Promise<Snapshot> {
  const content: unknown[] = [];
  const identity: unknown[] = [];
  async function visit(path: string): Promise<void> {
    const before = await lstat(path, { bigint: true });
    const name = relative(root, path);
    const mode = Number(before.mode & 0o777n);
    let value: string;
    if (before.isSymbolicLink()) {
      if (!allowLinks) throw new Error('Git metadata symlinks are not supported for recovery.');
      value = `link:${await readlink(path)}`;
    } else if (before.isDirectory()) {
      value = 'directory';
      for (const child of (await readdir(path)).sort()) await visit(join(path, child));
    } else if (before.isFile()) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat({ bigint: true });
        if (stat.ino !== before.ino || stat.dev !== before.dev) throw new Error('File identity changed during inspection.');
        const hash = createHash('sha256');
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
        value = `file:${hash.digest('hex')}`;
      } finally { await handle.close(); }
    } else throw new Error('Special files are not supported for recovery.');
    const after = await lstat(path, { bigint: true });
    const key = (s: typeof before) => [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].map(String);
    if (JSON.stringify(key(before)) !== JSON.stringify(key(after))) throw new Error('Files changed during inspection.');
    content.push([name, mode, value]);
    identity.push([name, ...key(after)]);
  }
  await visit(root);
  return { content: JSON.stringify(content), identity: JSON.stringify(identity) };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec('git', args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 8 * 1024 * 1024 });
  return result.stdout.trim();
}

/** This is activity detection, never proof that a lock is orphaned. */
export async function inspectActivity(lock: string, procRoot = '/proc'): Promise<boolean> {
  if (process.platform !== 'linux') throw new Error('Recovery requires local Linux process inspection.');
  const target = await lstat(lock, { bigint: true });
  let partialVisibility = false;
  for (const pid of await readdir(procRoot)) {
    if (!/^\d+$/.test(pid)) continue;
    const proc = join(procRoot, pid);
    try {
      const owner = await lstat(proc);
      const comm = (await readFile(`${proc}/comm`, 'utf8')).trim();
      if (/^git(?:-|$)/.test(comm)) throw new Error('Git activity detected; recovery is blocked.');
      if (owner.uid !== process.getuid?.()) { partialVisibility = true; continue; }
      let descriptors: string[];
      try { descriptors = await readdir(`${proc}/fd`); }
      catch (error) {
        // Readable non-Git identity with hidden descriptors means unknown ownership.
        if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code || '')) { partialVisibility = true; continue; }
        throw error;
      }
      for (const fd of descriptors) {
        // Following a proc descriptor is intentional: compare the held inode, not its path.
        const { stat } = await import('node:fs/promises');
        const held = await stat(`${proc}/fd/${fd}`, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          if (error.code === 'EACCES' || error.code === 'EPERM') { partialVisibility = true; return null; }
          throw error;
        });
        if (held?.dev === target.dev && held.ino === target.ino) throw new Error('An open lock holder was detected; recovery is blocked.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') continue;
      throw error;
    }
  }
  return partialVisibility;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function syncDirectoryAncestry(path: string): Promise<void> {
  // Recursive mkdir may create several naming entries. Persist each ancestor
  // before cleanup can make this the only recoverable backup.
  for (let current = path; ; current = dirname(current)) {
    await syncDirectory(current);
    if (dirname(current) === current) break;
  }
}

async function saveReceipt(receipt: RecoveryReceipt): Promise<void> {
  const temporary = join(receipt.backupPath, `receipt-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(receipt)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, join(receipt.backupPath, 'recovery.json'));
  await syncDirectory(receipt.backupPath);
}

export class WorktreeLockRecovery {
  async findReceipt(backupRoot: string, sessionId: string): Promise<RecoveryReceipt | undefined> {
    let entries;
    try { entries = await readdir(backupRoot, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    let found: RecoveryReceipt | undefined;
    let foundTime = -Infinity;
    const rank = (receipt: RecoveryReceipt) => receipt.state === 'backing-up' ? 0 : 1;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let text: string;
      try { text = await readFile(join(backupRoot, entry.name, 'recovery.json'), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const receipt = JSON.parse(text) as RecoveryReceipt;
      if (receipt.target?.sessionId !== sessionId || receipt.backupPath !== join(backupRoot, entry.name)) continue;
      // Legacy receipts use persisted file time, never the random directory ID.
      // An incomplete attempt must not hide a previously verified backup.
      const time = receipt.startedAt ?? (await lstat(join(receipt.backupPath, 'recovery.json'))).mtimeMs;
      if (!found || rank(receipt) > rank(found) || (rank(receipt) === rank(found) && (time > foundTime || (time === foundTime && receipt.state === 'quarantined' && found.state !== 'quarantined')))) {
        found = receipt;
        foundTime = time;
      }
    }
    return found;
  }
  async prepare(target: RecoveryIdentity): Promise<RecoveryPlan> {
    if (process.platform !== 'linux') throw new Error('Integrated recovery is currently supported only on local Linux.');
    const worktreePath = await realpath(target.worktreePath);
    const repositoryPath = await realpath(target.repositoryPath);
    if (worktreePath !== target.worktreePath || repositoryPath !== target.repositoryPath) throw new Error('Recovery requires canonical paths.');
    if (await git(worktreePath, ['branch', '--show-current']) !== target.branch) throw new Error('Worktree branch changed.');
    const common = await realpath(resolve(worktreePath, await git(worktreePath, ['rev-parse', '--git-common-dir'])));
    const admin = await realpath(await git(worktreePath, ['rev-parse', '--absolute-git-dir']));
    if (admin === common || !contained(join(common, 'worktrees'), admin)) throw new Error('Recovery requires a linked managed worktree.');
    if (await realpath(resolve(admin, (await readFile(join(admin, 'gitdir'), 'utf8')).trim())) !== join(worktreePath, '.git')) throw new Error('Worktree registration changed.');
    if ((await git(worktreePath, ['ls-files', '--stage'])).split('\n').some((line) => line.startsWith('160000 '))) throw new Error('Submodules are not supported for recovery.');
    try {
      await lstat(join(common, 'objects', 'info', 'alternates'));
      throw new Error('External Git object alternates are not supported for recovery.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const lock = join(admin, 'index.lock');
    if (!(await lstat(lock)).isFile()) throw new Error('Recovery supports only the exact regular index.lock.');
    const findLocks = async (path: string): Promise<string[]> => {
      const locks: string[] = [];
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.name.endsWith('.lock')) locks.push(child);
        if (entry.isDirectory()) locks.push(...await findLocks(child));
      }
      return locks;
    };
    const locks = await findLocks(common);
    if (locks.length !== 1 || locks[0] !== lock) throw new Error('Additional Git locks prevent exact-lock recovery.');
    const partialVisibility = await inspectActivity(lock);
    return { id: randomUUID(), target, common, admin, lock, worktree: await snapshot(worktreePath, true), metadata: await snapshot(common, false), partialVisibility };
  }

  async recover(plan: RecoveryPlan, backupRoot: string): Promise<string> {
    const startedAt = Date.now();
    const fresh = await this.prepare(plan.target);
    if (fresh.common !== plan.common || fresh.admin !== plan.admin || fresh.worktree.identity !== plan.worktree.identity || fresh.worktree.content !== plan.worktree.content || fresh.metadata.identity !== plan.metadata.identity || fresh.metadata.content !== plan.metadata.content) throw new Error('Recovery plan changed; inspect and confirm again.');
    const root = resolve(backupRoot);
    if (contained(plan.common, root) || contained(plan.target.worktreePath, root)) throw new Error('Backup must be outside the repository metadata and worktree.');
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (await realpath(root) !== root) throw new Error('Backup path must be canonical.');
    await syncDirectoryAncestry(root);
    const backup = join(root, plan.id);
    await mkdir(backup, { mode: 0o700 });
    const primary = await realpath(await git(plan.target.repositoryPath, ['rev-parse', '--show-toplevel']));
    const lockDevice = (await lstat(plan.lock)).dev;
    let ancestor = dirname(plan.common);
    for (;;) {
      if (![primary, plan.target.worktreePath, plan.common].some((path) => contained(path, ancestor)) && await realpath(ancestor) === ancestor && (await lstat(ancestor)).dev === lockDevice) {
        try { await access(ancestor, constants.W_OK | constants.X_OK); break; }
        catch (error) {
          if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
        }
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error('No writable same-filesystem quarantine location exists outside the repository, worktree and Git metadata.');
      ancestor = parent;
    }
    const quarantineRoot = join(ancestor, '.spawnea-lock-quarantine');
    await mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
    if (await realpath(quarantineRoot) !== quarantineRoot) throw new Error('Quarantine path must be canonical.');
    const quarantineInfo = await lstat(quarantineRoot);
    if (!quarantineInfo.isDirectory() || quarantineInfo.dev !== lockDevice || quarantineInfo.uid !== process.getuid?.() || (quarantineInfo.mode & 0o077) !== 0) throw new Error('Quarantine must be a private owned directory on the lock filesystem.');
    await access(quarantineRoot, constants.W_OK | constants.X_OK);
    const quarantine = join(quarantineRoot, plan.id);
    await mkdir(quarantine, { mode: 0o700 });
    const receipt: RecoveryReceipt = { target: plan.target, backupPath: backup, quarantinePath: join(quarantine, 'index.lock'), startedAt, state: 'backing-up' };
    await saveReceipt(receipt);
    await syncDirectory(root);
    for (const [source, name, expected, links] of [
      [plan.target.worktreePath, 'worktree', plan.worktree, true],
      [plan.common, 'git-common', plan.metadata, false],
    ] as const) {
      await cp(source, join(backup, name), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true, force: false });
      if ((await snapshot(join(backup, name), links)).content !== expected.content) throw new Error(`Backup verification failed: ${name}.`);
    }
    // Flush the copied files and directories before making any destructive change.
    const flush = async (path: string): Promise<void> => {
      const info = await lstat(path);
      if (info.isSymbolicLink()) return;
      if (info.isDirectory()) for (const name of await readdir(path)) await flush(join(path, name));
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await file.sync(); } finally { await file.close(); }
    };
    await flush(backup);
    receipt.state = 'verified';
    await saveReceipt(receipt);
    await syncDirectory(quarantineRoot);
    await syncDirectory(dirname(quarantineRoot));
    const latest = await this.prepare(plan.target);
    if (latest.worktree.identity !== plan.worktree.identity || latest.worktree.content !== plan.worktree.content || latest.metadata.identity !== plan.metadata.identity || latest.metadata.content !== plan.metadata.content) throw new Error('Late writes invalidated recovery; backup retained.');
    await inspectActivity(plan.lock);
    // The user explicitly accepts the residual race with unobserved external writers.
    await rename(plan.lock, receipt.quarantinePath);
    await syncDirectory(plan.admin);
    await syncDirectory(quarantine);
    receipt.state = 'quarantined';
    await saveReceipt(receipt);
    await flush(backup);
    return backup;
  }
}
