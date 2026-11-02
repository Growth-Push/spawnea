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
    expect(indexes).toContain('idx_sessions_parent_session_id');
    expect(indexes).toContain('idx_artifacts_session_id');

    expect(tables).toContain('session_child_alias_counters');

    const sessionColumns = (
      sqlite.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
    ).map((column) => column.name);
    expect(sessionColumns).toContain('base_branch');
    expect(sessionColumns).toContain('base_commit');
    expect(sessionColumns).toContain('managed_worktree');
    expect(sessionColumns).toContain('creation_source');
    expect(sessionColumns).toContain('parent_session_id');
    expect(sessionColumns).toContain('child_alias');
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

  it('rewrites legacy mcp creation sources to control without touching other rows', () => {
    sqlite = new Database(':memory:');
    const before = MIGRATIONS.filter((migration) => migration.name < '0010_rename_mcp_creation_source');
    runMigrations(sqlite, before);
    sqlite.exec(`
      INSERT INTO servers (id, name, host, created_at) VALUES ('srv', 'Srv', 'localhost', 0);
      INSERT INTO projects (id, server_id, name, root_path, created_at) VALUES ('proj', 'srv', 'Proj', '/p', 0);
      INSERT INTO agents (id, name, harness, command, created_at) VALUES ('agent', 'A', 'codex', 'codex', 0);
    `);
    const insert = sqlite.prepare(
      `INSERT INTO sessions (id, name, server_id, project_id, agent_id, task, worktree_path, branch, tmux_session_name, status, creation_source, created_at, last_activity_at)
       VALUES (?, 'Name', 'srv', 'proj', 'agent', 'task', '/p', 'main', ?, 'idle', ?, 0, 0)`,
    );
    insert.run('legacy', 'tmux-legacy', 'mcp');
    insert.run('ui', 'tmux-ui', 'ui');

    const result = runMigrations(sqlite);
    expect(result.appliedNames).toContain('0010_rename_mcp_creation_source');
    const rows = sqlite.prepare('SELECT id, creation_source FROM sessions ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'legacy', creation_source: 'control' },
      { id: 'ui', creation_source: 'ui' },
    ]);
  });

  it('adds GitHub storage to an old database with opt-ins disabled and retains provenance', () => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    runMigrations(sqlite, MIGRATIONS.filter((migration) => migration.name < '0012_github_integration'));
    sqlite.exec(`
      INSERT INTO servers (id,name,host,created_at) VALUES ('s','Server','localhost',0);
      INSERT INTO projects (id,server_id,name,root_path,created_at) VALUES ('p','s','Project','/p',0);
      INSERT INTO agents (id,name,harness,command,created_at) VALUES ('a','Agent','shell','sh',0);
      INSERT INTO sessions (id,name,server_id,project_id,agent_id,task,worktree_path,branch,tmux_session_name,status,created_at,last_activity_at)
        VALUES ('x','Session','s','p','a','Task','/p','main','tmux','idle',0,0);
    `);
    expect(runMigrations(sqlite).appliedNames).toEqual(['0012_github_integration']);
    expect(sqlite.prepare('SELECT origin_issue_url FROM sessions WHERE id = ?').get('x')).toEqual({ origin_issue_url: null });
    sqlite.prepare('INSERT INTO github_project_settings (project_id) VALUES (?)').run('p');
    expect(sqlite.prepare('SELECT tracker_enabled, ci_enabled FROM github_project_settings').get()).toEqual({ tracker_enabled: 0, ci_enabled: 0 });
    const add = sqlite.prepare('INSERT OR IGNORE INTO session_links VALUES (?, ?, ?, ?, ?)');
    add.run('x', 'https://github.com/example/repo/issues/1', 'issue', 'task', 1);
    add.run('x', 'https://github.com/example/repo/issues/1', 'issue', 'task', 2);
    add.run('x', 'https://github.com/example/repo/issues/1', 'issue', 'output', 3);
    expect(sqlite.prepare('SELECT source FROM session_links ORDER BY source').all()).toEqual([{ source: 'output' }, { source: 'task' }]);
    sqlite.prepare('DELETE FROM sessions WHERE id = ?').run('x');
    expect(sqlite.prepare('SELECT count(*) AS count FROM session_links').get()).toEqual({ count: 0 });
  });
});
