import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionContextFile, SessionStatus, Logger } from '@spawnea/domain';
import { createLogger, parseSessionContextFile, serializeSessionContextFile } from '@spawnea/domain';

export interface SessionContextStoreOptions {
  storeDir: string;
  logger?: Logger;
}

const contextRevision = Symbol('contextRevision');
type RevisionedContext = SessionContextFile & { [contextRevision]?: number };

export class SessionContextStore {
  private readonly storeDir: string;
  private readonly logger: Logger;
  private readonly writes = new Map<string, Promise<unknown>>();
  private readonly revisions = new Map<string, number>();
  private readonly deletedSnapshots = new Map<string, SessionContextFile>();

  constructor(options: SessionContextStoreOptions) {
    this.storeDir = options.storeDir;
    this.logger = options.logger || createLogger('SessionContextStore');
    this.ensureDirectory();
  }

  private ensureDirectory(): void {
    if (!existsSync(this.storeDir)) {
      mkdirSync(this.storeDir, { recursive: true });
    }
  }

  private getFilePath(sessionId: string): string {
    const sanitized = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.storeDir, `${sanitized}.json`);
  }

  /**
   * Saves or updates a session context file on disk.
   */
  async save(context: SessionContextFile): Promise<string> {
    return this.serialize(context.sessionId, () => {
      const revision = this.revision(context.sessionId);
      const expected = (context as RevisionedContext)[contextRevision];
      if ((expected === undefined && (revision !== 0 || existsSync(this.getFilePath(context.sessionId)))) || (expected !== undefined && expected !== revision)) {
        throw new Error('Session context changed since it was read');
      }
      return this.write(context);
    });
  }

  private revision(sessionId: string): number {
    return this.revisions.get(this.getFilePath(sessionId)) ?? 0;
  }

  private serialize<T>(sessionId: string, action: () => T | Promise<T>): Promise<T> {
    const key = this.getFilePath(sessionId);
    const previous = this.writes.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(action);
    this.writes.set(key, operation);
    void operation.finally(() => { if (this.writes.get(key) === operation) this.writes.delete(key); }).catch(() => {});
    return operation;
  }

  private write(context: SessionContextFile): string {
    this.ensureDirectory();
    const filePath = this.getFilePath(context.sessionId);
    this.logger.info('Persisting session context file', { sessionId: context.sessionId, filePath });

    const content = serializeSessionContextFile(context);
    writeFileSync(filePath, content, 'utf8');
    this.revisions.set(filePath, this.revision(context.sessionId) + 1);
    return filePath;
  }

  /** Apply a change to the current context, never to an earlier snapshot. */
  async update(sessionId: string, change: (context: SessionContextFile) => SessionContextFile): Promise<boolean> {
    return this.serialize(sessionId, async () => {
      const current = await this.load(sessionId);
      if (!current) return false;
      this.write(change(current));
      return true;
    });
  }

  /** Restore a deleted context only when database removal failed. */
  async restoreDeleted(context: SessionContextFile): Promise<void> {
    await this.serialize(context.sessionId, () => {
      if (existsSync(this.getFilePath(context.sessionId))) throw new Error('Cannot restore over an existing session context');
      const key = this.getFilePath(context.sessionId);
      this.write(this.deletedSnapshots.get(key) ?? context);
      this.deletedSnapshots.delete(key);
    });
  }

  discardDeletedSnapshot(sessionId: string): void {
    this.deletedSnapshots.delete(this.getFilePath(sessionId));
  }

  async retainLinks(sessionId: string, links: NonNullable<SessionContextFile['retainedLinks']>): Promise<void> {
    await this.update(sessionId, (context) => {
      const merged = new Map((context.retainedLinks ?? []).map((link) => [`${link.source}:${link.url}`, link]));
      for (const link of links) merged.set(`${link.source}:${link.url}`, link);
      return { ...context, retainedLinks: [...merged.values()] };
    });
  }

  /**
   * Loads and validates a session context file from disk.
   */
  async load(sessionId: string): Promise<SessionContextFile | null> {
    const filePath = this.getFilePath(sessionId);
    if (!existsSync(filePath)) {
      this.logger.debug('Session context file not found', { sessionId, filePath });
      return null;
    }

    try {
      const content = readFileSync(filePath, 'utf8');
      const result = parseSessionContextFile(content);
      if (result.success) {
        Object.defineProperty(result.context, contextRevision, { value: this.revision(sessionId) });
        return result.context;
      }
      this.logger.error('Invalid session context file format', undefined, {
        sessionId,
        errors: result.errors,
      });
      return null;
    } catch (err) {
      this.logger.error('Failed to read session context file', err, { sessionId, filePath });
      return null;
    }
  }

  /**
   * Lists all valid session context files found in the store directory.
   */
  async list(): Promise<SessionContextFile[]> {
    this.ensureDirectory();
    const results: SessionContextFile[] = [];

    try {
      const files = readdirSync(this.storeDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const fullPath = join(this.storeDir, file);
          try {
            const content = readFileSync(fullPath, 'utf8');
            const parsed = parseSessionContextFile(content);
            if (parsed.success) {
              results.push(parsed.context);
            }
          } catch {
            // Ignore unreadable or corrupt single files
          }
        }
      }
    } catch (err) {
      this.logger.error('Failed to list session context directory', err, { storeDir: this.storeDir });
    }

    return results;
  }

  /**
   * Updates the status of an existing session context file on disk.
   */
  async updateStatus(sessionId: string, status: SessionStatus): Promise<boolean> {
    return this.update(sessionId, (existing) => ({ ...existing,
      status,
      updatedAt: new Date().toISOString(),
    }));
  }

  /**
   * Updates only the operator-facing display name. Runtime identities stay unchanged.
   */
  async updateSessionName(sessionId: string, sessionName: string): Promise<boolean> {
    return this.update(sessionId, (existing) => ({ ...existing,
      sessionName,
      updatedAt: new Date().toISOString(),
    }));
  }

  /**
   * Deletes a session context file from disk.
   */
  async delete(sessionId: string, options?: { captureForRollback?: boolean }): Promise<boolean> {
    return this.serialize(sessionId, async () => {
      const filePath = this.getFilePath(sessionId);
      if (existsSync(filePath)) {
        try {
          const snapshot = options?.captureForRollback ? await this.load(sessionId) : null;
          unlinkSync(filePath);
          if (snapshot) this.deletedSnapshots.set(filePath, snapshot);
          this.revisions.set(filePath, this.revision(sessionId) + 1);
          this.logger.info('Deleted session context file', { sessionId, filePath });
          return true;
        } catch (err) {
          this.logger.error('Failed to delete session context file', err, { sessionId, filePath });
          return false;
        }
      }
      // Deletion is idempotent: an already-absent context is successfully clean.
      this.revisions.set(filePath, this.revision(sessionId) + 1);
      return true;
    });
  }
}
