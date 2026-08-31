import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionContextFile, SessionStatus, Logger } from '@spawnea/domain';
import { createLogger, parseSessionContextFile, serializeSessionContextFile } from '@spawnea/domain';

export interface SessionContextStoreOptions {
  storeDir: string;
  logger?: Logger;
}

export class SessionContextStore {
  private readonly storeDir: string;
  private readonly logger: Logger;

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
    this.ensureDirectory();
    const filePath = this.getFilePath(context.sessionId);
    this.logger.info('Persisting session context file', { sessionId: context.sessionId, filePath });

    const content = serializeSessionContextFile(context);
    writeFileSync(filePath, content, 'utf8');
    return filePath;
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
    const existing = await this.load(sessionId);
    if (!existing) {
      this.logger.warn('Cannot update status: context file not found', { sessionId, status });
      return false;
    }

    const updated: SessionContextFile = {
      ...existing,
      status,
      updatedAt: new Date().toISOString(),
    };

    await this.save(updated);
    return true;
  }

  /**
   * Updates only the operator-facing display name. Runtime identities stay unchanged.
   */
  async updateSessionName(sessionId: string, sessionName: string): Promise<boolean> {
    const existing = await this.load(sessionId);
    if (!existing) {
      this.logger.warn('Cannot update session name: context file not found', { sessionId });
      return false;
    }

    await this.save({
      ...existing,
      sessionName,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  /**
   * Deletes a session context file from disk.
   */
  async delete(sessionId: string): Promise<boolean> {
    const filePath = this.getFilePath(sessionId);
    if (existsSync(filePath)) {
      try {
        unlinkSync(filePath);
        this.logger.info('Deleted session context file', { sessionId, filePath });
        return true;
      } catch (err) {
        this.logger.error('Failed to delete session context file', err, { sessionId, filePath });
        return false;
      }
    }
    return false;
  }
}

