import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { runMigrations, type Migration } from './migrations.js';
import {
  ensurePrivateSqliteStorage,
  ensurePrivateSqliteStorageForClient,
  resolveSqliteStorageTarget,
} from './storage-privacy.js';

export type DbClient = BetterSQLite3Database<typeof schema>;

const dbSqliteClients = new WeakMap<DbClient, Database.Database>();

export function getSqliteClient(db: DbClient): Database.Database | undefined {
  return dbSqliteClients.get(db) ?? (db as unknown as { $client?: Database.Database }).$client;
}

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
  const explicitReadonly = Boolean(options.readonly || options.sqliteOptions?.readonly);
  const fileMustExist = Boolean(options.sqliteOptions?.fileMustExist);
  const target = resolveSqliteStorageTarget({
    path: dbPath,
    readonly: explicitReadonly,
    fileMustExist,
  });
  const isMemory = target.kind === 'memory';
  const isReadonly = target.kind === 'readonly';

  // Ensure writable file-backed DB and sidecar storage is owner-only before opening or migrating.
  ensurePrivateSqliteStorage({
    path: dbPath,
    readonly: explicitReadonly,
    fileMustExist,
  });

  const sqlite = new Database(dbPath, {
    readonly: explicitReadonly,
    ...options.sqliteOptions,
  });

  try {
    // Enable foreign keys
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');

    // Configure WAL and synchronous mode for writable file-backed databases
    if (!isMemory && !isReadonly) {
      sqlite.pragma('journal_mode = WAL');
      sqlite.pragma('synchronous = NORMAL');
      ensurePrivateSqliteStorageForClient(sqlite);
    }

    // Run migrations if enabled and not in read-only mode
    if (options.migrate !== false && !isReadonly) {
      runMigrations(sqlite, options.customMigrations);
      if (!isMemory) {
        ensurePrivateSqliteStorageForClient(sqlite);
      }
    }
  } catch (error) {
    try {
      sqlite.close();
    } catch {
      // Preserve primary initialization or permission error.
    }
    throw error;
  }

  const db = drizzle(sqlite, { schema });
  dbSqliteClients.set(db, sqlite);

  return {
    db,
    sqlite,
    close: () => {
      sqlite.close();
    },
  };
}
