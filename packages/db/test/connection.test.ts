import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createDatabase, createRepositories, type DatabaseConnection } from '../src/index.js';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const isPosix = process.platform !== 'win32';
const posixIt = isPosix ? it : it.skip;

describe('Database Connection', () => {
  let conn: DatabaseConnection | undefined;
  let tempDir: string | undefined;

  afterEach(() => {
    if (conn) {
      conn.close();
      conn = undefined;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('creates an in-memory database with foreign keys enabled', () => {
    conn = createDatabase({ path: ':memory:' });
    expect(conn.db).toBeDefined();
    expect(conn.sqlite).toBeDefined();

    const fkPragma = conn.sqlite.pragma('foreign_keys', { simple: true });
    expect(fkPragma).toBe(1);
  });

  it('creates a file-backed database with WAL journal mode', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'spawnea-db-test-'));
    const dbPath = join(tempDir, 'test.db');

    conn = createDatabase({ path: dbPath });

    const journalMode = conn.sqlite.pragma('journal_mode', { simple: true });
    expect(journalMode).toBe('wal');

    const fkPragma = conn.sqlite.pragma('foreign_keys', { simple: true });
    expect(fkPragma).toBe(1);
  });

  it('allows disabling automatic migrations on connect', () => {
    conn = createDatabase({ path: ':memory:', migrate: false });

    // Table __spawnea_migrations should not exist yet
    const tables = conn.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='__spawnea_migrations'")
      .all();
    expect(tables).toHaveLength(0);
  });

  posixIt('secures fresh database and live WAL/SHM sidecars as 0600 inside an existing 0755 directory', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'spawnea-db-priv-'));
    const parentDir = join(tempDir, 'traversable-parent');
    mkdirSync(parentDir, { mode: 0o755 });
    chmodSync(parentDir, 0o755);

    const dbPath = join(parentDir, 'spawnea.sqlite');
    conn = createDatabase({ path: dbPath, migrate: true });

    expect(statSync(parentDir).mode & 0o777).toBe(0o755);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);

    // Trigger live WAL/SHM writes and inspect modes while connection remains open
    const repos = createRepositories(conn.db);
    await repos.servers.save({
      id: 'srv-1',
      name: 'Local',
      host: 'localhost',
      sshPort: 22,
      enabled: true,
    });
    await repos.projects.save({ id: 'proj-1', serverId: 'srv-1', name: 'Proj', rootPath: '/tmp/proj-priv' });
    await repos.agents.save({ id: 'agent-1', name: 'Shell', harness: 'shell', command: 'sh' });
    await repos.sessions.save({
      id: 'sess-1',
      name: 'Live session',
      serverId: 'srv-1',
      projectId: 'proj-1',
      agentId: 'agent-1',
      task: 'Verify WAL permissions',
      worktreePath: '/tmp/proj-priv',
      branch: 'main',
      status: 'working',
      tmuxSessionName: 'spawnea-sess-priv',
    });
    await repos.sessionHistory!.upsertSnapshot({
      sessionId: 'sess-1',
      output: 'retained output line',
      items: [],
    });

    expect(statSync(parentDir).mode & 0o777).toBe(0o755);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect(existsSync(`${dbPath}-shm`)).toBe(true);
    expect(statSync(`${dbPath}-wal`).mode & 0o777).toBe(0o600);
    expect(statSync(`${dbPath}-shm`).mode & 0o777).toBe(0o600);
  });

  posixIt('creates missing containing subdirectories as 0700 without altering existing 0755 ancestors', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'spawnea-db-priv-'));
    const parentDir = join(tempDir, 'existing-0755');
    mkdirSync(parentDir, { mode: 0o755 });
    chmodSync(parentDir, 0o755);

    const nestedDir = join(parentDir, 'owned-profile');
    const dbPath = join(nestedDir, 'spawnea.sqlite');
    conn = createDatabase({ path: dbPath, migrate: true });

    expect(statSync(parentDir).mode & 0o777).toBe(0o755);
    expect(statSync(nestedDir).mode & 0o777).toBe(0o700);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
  });

  posixIt('upgrades pre-existing 0644 database and WAL/SHM/journal sidecars to 0600 before migrations', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'spawnea-db-priv-'));
    const parentDir = join(tempDir, 'legacy-install');
    mkdirSync(parentDir, { mode: 0o755 });
    chmodSync(parentDir, 0o755);
    const dbPath = join(parentDir, 'spawnea.sqlite');

    // Create a legacy unmigrated 0644 database with permissive 0644 sidecar files
    const raw = new Database(dbPath);
    raw.exec('CREATE TABLE legacy_note (id TEXT PRIMARY KEY);');
    raw.close();
    writeFileSync(`${dbPath}-wal`, Buffer.alloc(0), { mode: 0o644 });
    writeFileSync(`${dbPath}-shm`, Buffer.alloc(0), { mode: 0o644 });
    writeFileSync(`${dbPath}-journal`, Buffer.alloc(0), { mode: 0o644 });
    chmodSync(dbPath, 0o644);
    chmodSync(`${dbPath}-wal`, 0o644);
    chmodSync(`${dbPath}-shm`, 0o644);
    chmodSync(`${dbPath}-journal`, 0o644);

    expect(statSync(dbPath).mode & 0o777).toBe(0o644);
    expect(statSync(`${dbPath}-wal`).mode & 0o777).toBe(0o644);
    expect(statSync(`${dbPath}-shm`).mode & 0o777).toBe(0o644);
    expect(statSync(`${dbPath}-journal`).mode & 0o777).toBe(0o644);

    conn = createDatabase({ path: dbPath, migrate: true });

    expect(statSync(parentDir).mode & 0o777).toBe(0o755);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    if (existsSync(`${dbPath}-wal`)) {
      expect(statSync(`${dbPath}-wal`).mode & 0o777).toBe(0o600);
    }
    if (existsSync(`${dbPath}-shm`)) {
      expect(statSync(`${dbPath}-shm`).mode & 0o777).toBe(0o600);
    }
    if (existsSync(`${dbPath}-journal`)) {
      expect(statSync(`${dbPath}-journal`).mode & 0o777).toBe(0o600);
    }
  });

  posixIt('preserves read-only no-mutation behavior and fileMustExist semantics without chmod or creation', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'spawnea-db-priv-'));
    const parentDir = join(tempDir, 'readonly-parent');
    mkdirSync(parentDir, { mode: 0o755 });
    chmodSync(parentDir, 0o755);
    const dbPath = join(parentDir, 'existing.sqlite');

    const seed = createDatabase({ path: dbPath, migrate: true });
    seed.close();
    chmodSync(dbPath, 0o644);

    // Top-level readonly option must not chmod back to 0600 or create sidecars
    conn = createDatabase({ path: dbPath, readonly: true });
    conn.close();
    conn = undefined;
    expect(statSync(dbPath).mode & 0o777).toBe(0o644);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);

    // sqliteOptions.readonly must also leave 0644 intact
    conn = createDatabase({ path: dbPath, sqliteOptions: { readonly: true } });
    conn.close();
    conn = undefined;
    expect(statSync(dbPath).mode & 0o777).toBe(0o644);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);

    // readonly on a missing database must fail without creating parent dir or DB file
    const missingReadonlyDb = join(parentDir, 'missing-ro-dir', 'missing-ro.sqlite');
    expect(() => createDatabase({ path: missingReadonlyDb, readonly: true })).toThrow();
    expect(existsSync(missingReadonlyDb)).toBe(false);

    // fileMustExist on non-existent target must fail without creating parent dir or DB file
    const missingDir = join(parentDir, 'must-not-exist');
    const missingDb = join(missingDir, 'absent.sqlite');
    expect(() =>
      createDatabase({ path: missingDb, sqliteOptions: { fileMustExist: true } }),
    ).toThrow();
    expect(existsSync(missingDir)).toBe(false);
    expect(existsSync(missingDb)).toBe(false);
  });

  posixIt('fails closed without running migrations when DB or sidecar is a symlink or unwritable', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'spawnea-db-priv-'));
    const parentDir = join(tempDir, 'symlink-parent');
    mkdirSync(parentDir, { mode: 0o755 });
    chmodSync(parentDir, 0o755);

    const victim = join(parentDir, 'victim.txt');
    writeFileSync(victim, 'unchanged-content', { mode: 0o644 });
    chmodSync(victim, 0o644);

    const symlinkDb = join(parentDir, 'symlink.sqlite');
    symlinkSync(victim, symlinkDb);

    expect(() => createDatabase({ path: symlinkDb, migrate: true })).toThrow(/symlink/i);
    expect(lstatSync(symlinkDb).isSymbolicLink()).toBe(true);
    expect(statSync(victim).mode & 0o777).toBe(0o644);
    expect(readFileSync(victim, 'utf8')).toBe('unchanged-content');

    // Symlink sidecar must block migration writes on existing DB without modifying victim
    const dbWithSymlinkWal = join(parentDir, 'wal-symlink.sqlite');
    const initial = new Database(dbWithSymlinkWal);
    initial.exec('CREATE TABLE existing_data (id TEXT PRIMARY KEY);');
    initial.close();
    chmodSync(dbWithSymlinkWal, 0o600);
    symlinkSync(victim, `${dbWithSymlinkWal}-wal`);

    expect(() => createDatabase({ path: dbWithSymlinkWal, migrate: true })).toThrow(/symlink/i);
    expect(statSync(victim).mode & 0o777).toBe(0o644);
    unlinkSync(`${dbWithSymlinkWal}-wal`);
    const verifyNoMigrations = new Database(dbWithSymlinkWal, { readonly: true });
    const migTables = verifyNoMigrations
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='__spawnea_migrations'")
      .all();
    verifyNoMigrations.close();
    expect(migTables).toHaveLength(0);

    // Unwritable 0444 database opened in writable mode must fail closed before migrations
    const unwritableDb = join(parentDir, 'unwritable.sqlite');
    const rawUnwritable = new Database(unwritableDb);
    rawUnwritable.exec('CREATE TABLE keep_only (id TEXT PRIMARY KEY);');
    rawUnwritable.close();
    chmodSync(unwritableDb, 0o444);

    expect(() => createDatabase({ path: unwritableDb, migrate: true })).toThrow();
    const roCheck = new Database(unwritableDb, { readonly: true });
    const migRows = roCheck
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='__spawnea_migrations'")
      .all();
    roCheck.close();
    expect(migRows).toHaveLength(0);
  });
});
