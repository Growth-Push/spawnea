import { describe, it, expect, afterEach } from 'vitest';
import { createDatabase, type DatabaseConnection } from '../src/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
});
