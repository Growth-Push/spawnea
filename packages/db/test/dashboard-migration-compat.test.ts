import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, runMigrations } from '../src/migrations.js';

const externalMigrationSql = process.env.SPAWNEA_COMPAT_MIGRATION_SQL;
describe('dashboard migration compatibility', () => {
  it.skipIf(!externalMigrationSql)('preserves old data through both additive migrations', () => {
    const sqlite = new Database(':memory:');
    try {
      runMigrations(sqlite, MIGRATIONS.filter((m) => m.name < '0011_dashboard_history'));
      sqlite.exec(`INSERT INTO servers (id, name, host, created_at) VALUES ('s', 'S', 'example', 1);
        INSERT INTO projects (id, server_id, name, root_path, created_at) VALUES ('p', 's', 'P', '/example', 1);
        INSERT INTO agents (id, name, harness, command, created_at) VALUES ('a', 'A', 'shell', 'sh', 1);
        INSERT INTO sessions (id, name, server_id, project_id, agent_id, task, worktree_path, branch, tmux_session_name, status, created_at, last_activity_at)
        VALUES ('one', 'One', 's', 'p', 'a', '', '/example', 'main', 'one', 'idle', 1, 1)`);
      const later = { name: '0012_github_integration', sql: readFileSync(externalMigrationSql!, 'utf8') };
      expect(runMigrations(sqlite).appliedNames).toEqual(['0011_dashboard_history']);
      sqlite.exec('INSERT INTO dashboard_activity_samples(observed_at, parents, children, gap) VALUES (10, 1, 2, 0)');
      expect(runMigrations(sqlite, [...MIGRATIONS, later]).appliedNames).toEqual([later.name]);
      expect(sqlite.prepare('SELECT id, origin_issue_url FROM sessions').get()).toEqual({ id: 'one', origin_issue_url: null });
      expect(sqlite.prepare('SELECT parents, children FROM dashboard_activity_samples').get()).toEqual({ parents: 1, children: 2 });
      expect(runMigrations(sqlite, [...MIGRATIONS, later]).appliedCount).toBe(0);
    } finally { sqlite.close(); }
  });
});
