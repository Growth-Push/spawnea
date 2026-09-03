import type Database from 'better-sqlite3';

export interface Migration {
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    name: '0001_initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        ssh_user TEXT,
        ssh_port INTEGER NOT NULL DEFAULT 22,
        ssh_config_alias TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        repo_url TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        harness TEXT NOT NULL,
        command TEXT NOT NULL,
        args_template TEXT,
        env_vars TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        task TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        branch TEXT NOT NULL,
        tmux_session_name TEXT NOT NULL,
        tmux_window_name TEXT,
        status TEXT NOT NULL DEFAULT 'disconnected',
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        direction TEXT NOT NULL,
        remote_path TEXT NOT NULL,
        cached_local_path TEXT,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_server_id ON sessions(server_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_session_id ON artifacts(session_id);
    `,
  },
  {
    name: '0002_add_is_external_to_sessions',
    sql: `
      ALTER TABLE sessions ADD COLUMN is_external INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    name: '0003_add_managed_worktree_metadata',
    sql: `
      ALTER TABLE sessions ADD COLUMN base_branch TEXT;
      ALTER TABLE sessions ADD COLUMN managed_worktree INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    name: '0004_add_project_base_branch',
    sql: `
      ALTER TABLE projects ADD COLUMN base_branch TEXT;
    `,
  },
  {
    name: '0005_add_managed_worktree_base_commit',
    sql: `
      ALTER TABLE sessions ADD COLUMN base_commit TEXT;
    `,
  },
  {
    name: '0006_add_session_creation_source',
    sql: `
      ALTER TABLE sessions ADD COLUMN creation_source TEXT NOT NULL DEFAULT 'ui';
    `,
  },
  {
    name: '0007_add_session_hierarchy',
    sql: `
      ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;
      ALTER TABLE sessions ADD COLUMN child_alias TEXT;

      CREATE INDEX IF NOT EXISTS idx_sessions_parent_session_id ON sessions(parent_session_id);

      CREATE TABLE IF NOT EXISTS session_child_alias_counters (
        parent_session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        next_alias_index INTEGER NOT NULL DEFAULT 1
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_parent_child_alias ON sessions(parent_session_id, child_alias) WHERE parent_session_id IS NOT NULL AND child_alias IS NOT NULL;
    `,
  },
];

export function runMigrations(sqlite: Database.Database, migrations: Migration[] = MIGRATIONS): {
  appliedCount: number;
  appliedNames: string[];
} {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __spawnea_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    );
  `);

  const appliedRows = sqlite
    .prepare('SELECT name FROM __spawnea_migrations')
    .all() as { name: string }[];
  const appliedSet = new Set(appliedRows.map((r) => r.name));

  const appliedNames: string[] = [];

  for (const migration of migrations) {
    if (!appliedSet.has(migration.name)) {
      const applyTx = sqlite.transaction(() => {
        sqlite.exec(migration.sql);
        sqlite
          .prepare('INSERT INTO __spawnea_migrations (name, applied_at) VALUES (?, ?)')
          .run(migration.name, Date.now());
      });
      applyTx();
      appliedNames.push(migration.name);
    }
  }

  return {
    appliedCount: appliedNames.length,
    appliedNames,
  };
}
