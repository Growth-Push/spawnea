import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, MIGRATIONS, type Migration } from '../src/index.js';

describe('Database Migrations', () => {
  let sqlite: Database.Database | undefined;

  afterEach(() => {
    if (sqlite) {
      sqlite.close();
      sqlite = undefined;
    }
  });

  it('runs initial migrations and creates all required tables and indexes', () => {
    sqlite = new Database(':memory:');
    const result = runMigrations(sqlite);

    expect(result.appliedCount).toBe(MIGRATIONS.length);
    expect(result.appliedNames).toContain('0001_initial_schema');

    // Verify tables exist
    const tables = (
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);

    expect(tables).toContain('__spawnea_migrations');
    expect(tables).toContain('servers');
    expect(tables).toContain('projects');
    expect(tables).toContain('agents');
    expect(tables).toContain('sessions');
    expect(tables).toContain('artifacts');

    // Verify indexes exist
    const indexes = (
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);

    expect(indexes).toContain('idx_sessions_server_id');
    expect(indexes).toContain('idx_sessions_project_id');
    expect(indexes).toContain('idx_artifacts_session_id');

    const sessionColumns = (
      sqlite.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
    ).map((column) => column.name);
    expect(sessionColumns).toContain('base_branch');
    expect(sessionColumns).toContain('base_commit');
    expect(sessionColumns).toContain('managed_worktree');
    expect(sessionColumns).toContain('creation_source');
  });

  it('is idempotent when executed multiple times', () => {
    sqlite = new Database(':memory:');
    const firstRun = runMigrations(sqlite);
    expect(firstRun.appliedCount).toBe(MIGRATIONS.length);

    const secondRun = runMigrations(sqlite);
    expect(secondRun.appliedCount).toBe(0);
    expect(secondRun.appliedNames).toHaveLength(0);
  });

  it('applies custom incremental migrations', () => {
    sqlite = new Database(':memory:');
    runMigrations(sqlite);

    const customMigrations: Migration[] = [
      ...MIGRATIONS,
      {
        name: '0002_test_table',
        sql: `CREATE TABLE test_items (id TEXT PRIMARY KEY, value TEXT NOT NULL);`,
      },
    ];

    const thirdRun = runMigrations(sqlite, customMigrations);
    expect(thirdRun.appliedCount).toBe(1);
    expect(thirdRun.appliedNames).toEqual(['0002_test_table']);

    const tables = (
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_items'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toContain('test_items');
  });
});
