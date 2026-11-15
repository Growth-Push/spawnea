import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  type Stats,
} from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRIVATE_SQLITE_FILE_MODE = 0o600;
export const PRIVATE_SQLITE_DIR_MODE = 0o700;

export const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

export type SqliteStorageTarget =
  | { kind: 'memory' }
  | { kind: 'readonly' }
  | { kind: 'file'; filePath: string; fileMustExist: boolean };

export interface EnsureSqliteStorageOptions {
  path: string;
  readonly?: boolean;
  fileMustExist?: boolean;
  requireMainExists?: boolean;
}

/**
 * Classifies a SQLite database target path so ':memory:' and read-only opens remain
 * non-mutating while writable file-backed paths are resolved for protection.
 */
export function resolveSqliteStorageTarget(options: EnsureSqliteStorageOptions): SqliteStorageTarget {
  const dbPath = options.path;
  const isReadonly = Boolean(options.readonly);

  if (dbPath === '' || dbPath === ':memory:' || dbPath.startsWith('file::memory:')) {
    return { kind: 'memory' };
  }

  if (dbPath.startsWith('file:')) {
    let parsed: URL;
    try {
      parsed = new URL(dbPath);
    } catch {
      if (isReadonly) {
        return { kind: 'readonly' };
      }
      throw new Error(`Refusing writable SQLite URI that cannot be resolved to a private local file: ${dbPath}`);
    }

    const modeParam = parsed.searchParams.get('mode');
    if (modeParam === 'memory') {
      return { kind: 'memory' };
    }
    if (isReadonly || modeParam === 'ro') {
      return { kind: 'readonly' };
    }
    if (parsed.hostname && parsed.hostname !== 'localhost') {
      throw new Error(`Refusing remote-host SQLite URI path: ${dbPath}`);
    }

    return {
      kind: 'file',
      filePath: fileURLToPath(parsed),
      fileMustExist: Boolean(options.fileMustExist),
    };
  }

  if (isReadonly) {
    return { kind: 'readonly' };
  }

  return {
    kind: 'file',
    filePath: dbPath,
    fileMustExist: Boolean(options.fileMustExist),
  };
}

/**
 * Returns the main database path followed by its SQLite WAL, SHM, and rollback journal sidecars.
 */
export function getSqliteStoragePaths(dbFilePath: string): string[] {
  return [dbFilePath, ...SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${dbFilePath}${suffix}`)];
}

function getEffectiveUid(): number | undefined {
  return typeof process.geteuid === 'function' ? process.geteuid() : undefined;
}

function enforceFdOwnerOnly(fd: number, targetPath: string, expectedStat?: Stats): void {
  const st = fstatSync(fd);
  if (!st.isFile()) {
    throw new Error(`Refusing non-regular SQLite storage inode: ${targetPath}`);
  }
  const euid = getEffectiveUid();
  if (euid !== undefined && st.uid !== euid) {
    throw new Error(`Refusing unowned SQLite storage inode: ${targetPath}`);
  }
  if (expectedStat && (st.dev !== expectedStat.dev || st.ino !== expectedStat.ino)) {
    throw new Error(`Detected path swap while securing SQLite storage file: ${targetPath}`);
  }

  const currentMode = st.mode & 0o777;
  if (currentMode !== PRIVATE_SQLITE_FILE_MODE) {
    fchmodSync(fd, PRIVATE_SQLITE_FILE_MODE);
    const updated = fstatSync(fd);
    const updatedMode = updated.mode & 0o777;
    if ((updatedMode & 0o077) !== 0 || updatedMode !== PRIVATE_SQLITE_FILE_MODE) {
      throw new Error(`Failed to enforce owner-only permissions on SQLite storage file: ${targetPath}`);
    }
  }
}

interface PendingPosixTighten {
  targetPath: string;
  dev: number;
  ino: number;
}

// Executed in an isolated child process so closing the reopened descriptor never
// releases POSIX fcntl byte-range locks held by active SQLite handles in this process.
const CHILD_TIGHTEN_POSIX_SCRIPT = `'use strict';
const fs = require('node:fs');
const targets = JSON.parse(process.argv[1]);
const euid = typeof process.geteuid === 'function' ? process.geteuid() : undefined;
const mode = ${PRIVATE_SQLITE_FILE_MODE};
const openFlags = fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK || 0);
try {
  for (const item of targets) {
    const fd = fs.openSync(item.targetPath, openFlags, mode);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) {
        throw new Error('Refusing non-regular SQLite storage inode: ' + item.targetPath);
      }
      if (euid !== undefined && st.uid !== euid) {
        throw new Error('Refusing unowned SQLite storage inode: ' + item.targetPath);
      }
      if (st.dev !== item.dev || st.ino !== item.ino) {
        throw new Error('Detected path swap while securing SQLite storage file: ' + item.targetPath);
      }
      if ((st.mode & 0o777) !== mode) {
        fs.fchmodSync(fd, mode);
        const updated = fs.fstatSync(fd);
        const updatedMode = updated.mode & 0o777;
        if ((updatedMode & 0o077) !== 0 || updatedMode !== mode) {
          throw new Error('Failed to enforce owner-only permissions on SQLite storage file: ' + item.targetPath);
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }
} catch (error) {
  process.stderr.write(error && error.message ? error.message : String(error));
  process.exit(1);
}
`;

function enforceTightenInChild(targets: PendingPosixTighten[]): void {
  if (targets.length === 0) {
    return;
  }
  try {
    execFileSync(
      process.execPath,
      ['--input-type=commonjs', '-e', CHILD_TIGHTEN_POSIX_SCRIPT, JSON.stringify(targets)],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          NODE_OPTIONS: '',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    const stderrText =
      typeof stderr === 'string' ? stderr.trim() : Buffer.isBuffer(stderr) ? stderr.toString('utf8').trim() : '';
    if (stderrText) {
      throw new Error(stderrText);
    }
    throw error;
  }
}

function inspectAndCollectPosixFile(
  targetPath: string,
  createIfMissing: boolean,
  requireExists: boolean,
  pendingTighten: PendingPosixTighten[],
): void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let existingStat: Stats | undefined;
    try {
      existingStat = lstatSync(targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(
          `Failed to inspect SQLite storage path '${targetPath}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (!existingStat) {
      if (!createIfMissing) {
        if (requireExists) {
          throw new Error(`Required SQLite storage file does not exist: ${targetPath}`);
        }
        return;
      }

      try {
        const fd = openSync(
          targetPath,
          constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          PRIVATE_SQLITE_FILE_MODE,
        );
        try {
          enforceFdOwnerOnly(fd, targetPath);
        } finally {
          closeSync(fd);
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST' && attempt === 0) {
          continue;
        }
        throw error;
      }
    }

    if (existingStat.isSymbolicLink()) {
      throw new Error(`Refusing symlink SQLite storage path: ${targetPath}`);
    }
    if (!existingStat.isFile()) {
      throw new Error(`Refusing non-regular SQLite storage path: ${targetPath}`);
    }
    const euid = getEffectiveUid();
    if (euid !== undefined && existingStat.uid !== euid) {
      throw new Error(`Refusing unowned SQLite storage path: ${targetPath}`);
    }

    // Never open/close an already-existing SQLite inode in this process: POSIX releases
    // all fcntl locks held by this process on that inode when any descriptor closes.
    if ((existingStat.mode & 0o777) !== PRIVATE_SQLITE_FILE_MODE) {
      pendingTighten.push({
        targetPath,
        dev: Number(existingStat.dev),
        ino: Number(existingStat.ino),
      });
    }
    return;
  }
}

/**
 * Ensures missing directories and writable file-backed SQLite files (including
 * WAL/SHM/journal sidecars) have owner-only permissions on POSIX systems before writes.
 *
 * Pre-existing parent directories, ':memory:' targets, and read-only opens are never modified.
 * On Windows, missing parent directories are created without claiming POSIX mode guarantees.
 */
export function ensurePrivateSqliteStorage(options: EnsureSqliteStorageOptions): void {
  const target = resolveSqliteStorageTarget(options);
  if (target.kind !== 'file') {
    return;
  }

  const isPosix = process.platform !== 'win32';
  const dir = dirname(target.filePath);

  // Only create missing containing directories; never chmod unrelated existing parent directories.
  if (!target.fileMustExist && !existsSync(dir)) {
    mkdirSync(dir, {
      recursive: true,
      mode: isPosix ? PRIVATE_SQLITE_DIR_MODE : undefined,
    });
  }

  if (!isPosix) {
    // Windows relies on user profile ACLs; POSIX mode bits are not equivalent here.
    return;
  }

  const pendingTighten: PendingPosixTighten[] = [];
  const createMainIfMissing = !target.fileMustExist && !options.requireMainExists;
  inspectAndCollectPosixFile(
    target.filePath,
    createMainIfMissing,
    Boolean(options.requireMainExists),
    pendingTighten,
  );

  for (const sidecarSuffix of SQLITE_SIDECAR_SUFFIXES) {
    inspectAndCollectPosixFile(`${target.filePath}${sidecarSuffix}`, false, false, pendingTighten);
  }

  enforceTightenInChild(pendingTighten);
}

/**
 * Enforces private SQLite storage permissions for an active writable better-sqlite3 client
 * before and around retained-content writes, failing closed if protection cannot be verified.
 */
export function ensurePrivateSqliteStorageForClient(sqlite: Database.Database): void {
  if (sqlite.memory || sqlite.readonly) {
    return;
  }
  const dbPath = sqlite.name;
  if (!dbPath || dbPath === ':memory:' || dbPath.startsWith('file::memory:')) {
    return;
  }
  ensurePrivateSqliteStorage({
    path: dbPath,
    readonly: false,
    fileMustExist: true,
    requireMainExists: true,
  });
}
