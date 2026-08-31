import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { runMigrations, type Migration } from './migrations.js';

export type DbClient = BetterSQLite3Database<typeof schema>;

export interface DatabaseOptions {
  /**
   * File path to SQLite database or ':memory:'.
   * Defaults to ':memory:'.
   */
  path?: string;
  /**
   * Read-only mode.
   */
  readonly?: boolean;
  /**
   * Whether to auto-run pending migrations on connect.
   * Defaults to true.
   */
  migrate?: boolean;
  /**
   * Optional custom migrations to execute instead of defaults.
   */
  customMigrations?: Migration[];
  /**
   * Additional better-sqlite3 options.
   */
  sqliteOptions?: Database.Options;
}

export interface DatabaseConnection {
  db: DbClient;
  sqlite: Database.Database;
  close: () => void;
}

export function createDatabase(options: DatabaseOptions = {}): DatabaseConnection {
  const dbPath = options.path ?? ':memory:';
  const isMemory = dbPath === ':memory:' || dbPath.startsWith('file::memory:');

  // Ensure parent directory exists for file-backed SQLite databases
  if (!isMemory && !options.readonly) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const sqlite = new Database(dbPath, {
    readonly: options.readonly ?? false,
    ...options.sqliteOptions,
  });

  // Enable foreign keys
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  // Configure WAL and synchronous mode for file-backed databases
  if (!isMemory && !options.readonly) {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = NORMAL');
  }

  // Run migrations if enabled and not in read-only mode
  if (options.migrate !== false && !options.readonly) {
    runMigrations(sqlite, options.customMigrations);
  }

  const db = drizzle(sqlite, { schema });

  return {
    db,
    sqlite,
    close: () => {
      sqlite.close();
    },
  };
}
