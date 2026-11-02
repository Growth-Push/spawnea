import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, statSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionContextFile, SessionStatus, Logger } from '@spawnea/domain';
import { createLogger, normalizeRetainedGitHubLinks, parseSessionContextFile, serializeSessionContextFile } from '@spawnea/domain';

const MAX_CONTEXT_BYTES = 8 * 1024 * 1024;
const CONTEXT_TOO_LARGE = 'Session context exceeds the 8 MiB safety limit';

function readBoundedContext(path: string): string {
  const fd = openSync(path, 'r');
  try {
    if (fstatSync(fd).size > MAX_CONTEXT_BYTES) throw new Error(CONTEXT_TOO_LARGE);
    const chunks: Buffer[] = [];
    let used = 0;
    while (used <= MAX_CONTEXT_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_CONTEXT_BYTES + 1 - used));
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (!read) break;
      chunks.push(chunk.subarray(0, read));
      used += read;
    }
    if (used > MAX_CONTEXT_BYTES) throw new Error(CONTEXT_TOO_LARGE);
    return Buffer.concat(chunks, used).toString('utf8');
  } finally { closeSync(fd); }
}

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
      const filePath = this.getFilePath(context.sessionId);
      if (existsSync(filePath) && statSync(filePath).size > MAX_CONTEXT_BYTES) throw new Error(CONTEXT_TOO_LARGE);
      const revision = this.revision(context.sessionId);
      const expected = (context as RevisionedContext)[contextRevision];
      if ((expected === undefined && (revision !== 0 || existsSync(filePath))) || (expected !== undefined && expected !== revision)) {
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

    if (existsSync(filePath) && statSync(filePath).size > MAX_CONTEXT_BYTES) throw new Error(CONTEXT_TOO_LARGE);
    const content = serializeSessionContextFile({ ...context, retainedLinks: context.retainedLinks ? normalizeRetainedGitHubLinks(context.retainedLinks) : undefined });
    if (Buffer.byteLength(content, 'utf8') > MAX_CONTEXT_BYTES) throw new Error(CONTEXT_TOO_LARGE);
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
      if (existsSync(this.getFilePath(context.sessionId))) {
        if (statSync(this.getFilePath(context.sessionId)).size > MAX_CONTEXT_BYTES) throw new Error(CONTEXT_TOO_LARGE);
        throw new Error('Cannot restore over an existing session context');
      }
      const key = this.getFilePath(context.sessionId);
      this.write(this.deletedSnapshots.get(key) ?? context);
      this.deletedSnapshots.delete(key);
    });
  }

  discardDeletedSnapshot(sessionId: string): void {
    this.deletedSnapshots.delete(this.getFilePath(sessionId));
  }

  async retainLinks(sessionId: string, links: NonNullable<SessionContextFile['retainedLinks']>): Promise<void> {
    await this.serialize(sessionId, async () => {
      const context = await this.load(sessionId);
      if (!context) return;
      const retainedLinks = normalizeRetainedGitHubLinks([...(context.retainedLinks ?? []), ...links]);
      if (JSON.stringify(context.retainedLinks ?? []) !== JSON.stringify(retainedLinks)) this.write({ ...context, retainedLinks });
    });
  }

  /** Run admission and read its accepted snapshot while holding the context queue. */
  async syncRetainedLinks(sessionId: string, admit: () => Promise<NonNullable<SessionContextFile['retainedLinks']>>): Promise<void> {
    await this.serialize(sessionId, async () => {
      const retainedLinks = normalizeRetainedGitHubLinks(await admit());
      const context = await this.load(sessionId);
      if (context && JSON.stringify(context.retainedLinks ?? []) !== JSON.stringify(retainedLinks)) this.write({ ...context, retainedLinks });
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
      const content = readBoundedContext(filePath);
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
            const content = readBoundedContext(fullPath);
            const parsed = parseSessionContextFile(content);
            if (parsed.success) {
              results.push(parsed.context);
            }
          } catch (err) {
            this.logger.error('Failed to read session context file', err, { filePath: fullPath });
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
          if (statSync(filePath).size > MAX_CONTEXT_BYTES) throw new Error(CONTEXT_TOO_LARGE);
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
