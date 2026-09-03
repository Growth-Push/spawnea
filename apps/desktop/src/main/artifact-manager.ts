import { join, basename, dirname } from 'node:path';
import { mkdir, copyFile, writeFile, readFile, rm, stat as localStat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type {
  Artifact,
  ArtifactDirection,
  FileContentResult,

  HostAdapter,
  Logger,
} from '@spawnea/domain';
import {
  assertSafeFilename,
  createLogger,
  relativeContainedPath,
  resolveContainedPath,
} from '@spawnea/domain';
import type { Repositories } from '@spawnea/db';
import type { SessionManager } from './session-manager.js';

import {
  DEFAULT_BLACKLIST_PATTERNS,
  matchesBlacklistPattern,
} from '@spawnea/state';

export interface ArtifactManagerOptions {
  repositories: Repositories;
  sessionManager: SessionManager;
  cacheDir: string;
  blacklistFilePath?: string;
  logger?: Logger;
}

export class ArtifactManager {
  private readonly repos: Repositories;
  private readonly sessionManager: SessionManager;
  private readonly cacheDir: string;
  private readonly blacklistFilePath: string;
  private readonly logger: Logger;
  private readonly sessionArtifactLocks = new Map<string, Promise<void>>();

  constructor(options: ArtifactManagerOptions) {
    this.repos = options.repositories;
    this.sessionManager = options.sessionManager;
    this.cacheDir = options.cacheDir;
    this.blacklistFilePath =
      options.blacklistFilePath || join(dirname(options.cacheDir), 'artifact-blacklist.json');
    this.logger = options.logger || createLogger('ArtifactManager');
  }

  /**
   * Returns full combined active blacklist (defaults + custom).
   */
  async getBlacklist(): Promise<string[]> {
    const custom = await this.getCustomBlacklist();
    return Array.from(new Set([...DEFAULT_BLACKLIST_PATTERNS, ...custom]));
  }

  /**
   * Returns user-defined custom blacklist patterns.
   */
  async getCustomBlacklist(): Promise<string[]> {
    if (!existsSync(this.blacklistFilePath)) {
      return [];
    }
    try {
      const data = await readFile(this.blacklistFilePath, 'utf8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        return parsed.filter((p) => typeof p === 'string' && p.trim().length > 0);
      }
      return [];
    } catch (err) {
      this.logger.warn('Failed to parse artifact blacklist file', { error: err });
      return [];
    }
  }

  /**
   * Adds a pattern to the blacklist, persists it, and removes any existing database artifacts matching this pattern.
   */
  async addToBlacklist(pattern: string): Promise<string[]> {
    const trimmed = pattern.trim();
    if (!trimmed) {
      return this.getBlacklist();
    }

    const current = await this.getCustomBlacklist();
    if (!current.includes(trimmed)) {
      current.push(trimmed);
      await mkdir(dirname(this.blacklistFilePath), { recursive: true });
      await writeFile(this.blacklistFilePath, JSON.stringify(current, null, 2), 'utf8');
      this.logger.info('Added pattern to artifact blacklist', { pattern: trimmed });
    }

    // Purge existing artifacts matching this pattern across sessions
    const allSessions = await this.repos.sessions.findAll();
    for (const sess of allSessions) {
      const sessArtifacts = await this.repos.artifacts.findBySessionId(sess.id);
      for (const art of sessArtifacts) {
        if (
          matchesBlacklistPattern(art.filename, trimmed) ||
          matchesBlacklistPattern(art.remotePath, trimmed)
        ) {
          await this.deleteArtifact(sess.id, art.id).catch(() => {});
        }
      }
    }

    return this.getBlacklist();
  }

  /**
   * Removes a pattern from the custom blacklist.
   */
  async removeFromBlacklist(pattern: string): Promise<string[]> {
    const trimmed = pattern.trim();
    const current = await this.getCustomBlacklist();
    const updated = current.filter((p) => p !== trimmed);
    await mkdir(dirname(this.blacklistFilePath), { recursive: true });
    await writeFile(this.blacklistFilePath, JSON.stringify(updated, null, 2), 'utf8');
    this.logger.info('Removed pattern from artifact blacklist', { pattern: trimmed });
    return this.getBlacklist();
  }

  /**
   * Checks if a path or filename is blacklisted.
   */
  async isPathBlacklisted(filePath: string): Promise<boolean> {
    const activeList = await this.getBlacklist();
    const filename = basename(filePath);
    return activeList.some(
      (pat) => matchesBlacklistPattern(filePath, pat) || matchesBlacklistPattern(filename, pat)
    );
  }

  /**
   * Resolves local cache directory for a session.
   */
  getSessionCacheDir(sessionId: string): string {
    return resolveContainedPath(this.cacheDir, sessionId);
  }

  /**
   * Ensures the remote workspace has a `.spawnea/artifacts/` folder with an automatic `.gitignore`.
   */
  private async ensureRemoteArtifactDir(host: HostAdapter, worktreePath: string): Promise<string> {
    const remoteArtDir = resolveContainedPath(worktreePath, '.spawnea/artifacts');
    await host.mkdir(remoteArtDir);

    // Ensure .spawnea/.gitignore exists with '*' so artifacts never dirty git working trees
    try {
      const gitignorePath = resolveContainedPath(worktreePath, '.spawnea/.gitignore');
      await host.stat(gitignorePath).catch(async () => {
        await host.writeFile(gitignorePath, '*\n!.gitignore\n');
      });
    } catch {
      // Non-critical if writing gitignore fails
    }

    return remoteArtDir;
  }

  /**
   * Uploads a local file to the session's workspace (.spawnea/artifacts/) and caches it locally.
   */
  async uploadArtifactFile(
    sessionId: string,
    localSourcePath: string,
    direction: ArtifactDirection = 'input',
    customFilename?: string
  ): Promise<Artifact> {
    return this.withSessionArtifactLock(sessionId, () =>
      this.uploadArtifactFileUnlocked(sessionId, localSourcePath, direction, customFilename)
    );
  }

  private async uploadArtifactFileUnlocked(
    sessionId: string,
    localSourcePath: string,
    direction: ArtifactDirection = 'input',
    customFilename?: string
  ): Promise<Artifact> {
    const session = await this.repos.sessions.findById(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    const host = await this.sessionManager.getHostAdapter(session.serverId);
    const filename = assertSafeFilename(customFilename || basename(localSourcePath) || `artifact-${Date.now()}`);
    const worktreePath = await this.sessionManager.resolveSessionWorktreePath(session);
    try {
      const remoteArtDir = await this.ensureRemoteArtifactDir(host, worktreePath.value);
      const remotePath = resolveContainedPath(remoteArtDir, filename);
      const persistedRemotePath = `${session.worktreePath.replace(/\/+$/, '')}/.spawnea/artifacts/${filename}`;

      const localSessionCache = this.getSessionCacheDir(sessionId);
      await mkdir(localSessionCache, { recursive: true });
      const cachedLocalPath = resolveContainedPath(localSessionCache, filename);

      this.logger.info('Uploading artifact file to host and caching locally', {
        sessionId,
        filename,
        cachedLocalPath,
        direction,
      });

      // Upload to host
      await host.uploadFile(localSourcePath, remotePath);

      // Cache locally if source is not already in cache
      if (localSourcePath !== cachedLocalPath) {
        await copyFile(localSourcePath, cachedLocalPath).catch(() => {});
      }

      const lstat = await localStat(cachedLocalPath).catch(() => null);
      const sizeBytes = lstat?.size ?? 0;
      const mimeType = getMimeType(filename);

      const artifact: Omit<Artifact, 'createdAt'> & { createdAt?: Date } = {
        id: `art-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        sessionId,
        direction,
        remotePath: persistedRemotePath,
        cachedLocalPath,
        filename,
        mimeType,
        sizeBytes,
        createdAt: new Date(),
      };

      return await this.repos.artifacts.save(artifact);
    } finally {
      worktreePath.release();
    }
  }

  /**
   * Writes an in-memory buffer (e.g. pasted clipboard image) to the remote session and local cache.
   */
  async uploadArtifactBuffer(
    sessionId: string,
    buffer: Buffer | Uint8Array,
    filename: string,
    mimeType: string,
    direction: ArtifactDirection = 'input'
  ): Promise<Artifact> {
    return this.withSessionArtifactLock(sessionId, () =>
      this.uploadArtifactBufferUnlocked(sessionId, buffer, filename, mimeType, direction)
    );
  }

  private async uploadArtifactBufferUnlocked(
    sessionId: string,
    buffer: Buffer | Uint8Array,
    filename: string,
    mimeType: string,
    direction: ArtifactDirection = 'input'
  ): Promise<Artifact> {
    const session = await this.repos.sessions.findById(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    const host = await this.sessionManager.getHostAdapter(session.serverId);
    const safeFilename = assertSafeFilename(filename);
    const worktreePath = await this.sessionManager.resolveSessionWorktreePath(session);
    try {
      const remoteArtDir = await this.ensureRemoteArtifactDir(host, worktreePath.value);
      const remotePath = resolveContainedPath(remoteArtDir, safeFilename);
      const persistedRemotePath = `${session.worktreePath.replace(/\/+$/, '')}/.spawnea/artifacts/${safeFilename}`;

      const localSessionCache = this.getSessionCacheDir(sessionId);
      await mkdir(localSessionCache, { recursive: true });
      const cachedLocalPath = resolveContainedPath(localSessionCache, safeFilename);

      this.logger.info('Writing artifact buffer to host and caching locally', {
        sessionId,
        filename,
        sizeBytes: buffer.length,
        direction,
      });

      // Write to remote host
      await host.writeFile(remotePath, buffer);

      // Write to local cache
      await writeFile(cachedLocalPath, buffer);

      const artifact: Omit<Artifact, 'createdAt'> & { createdAt?: Date } = {
        id: `art-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        sessionId,
        direction,
        remotePath: persistedRemotePath,
        cachedLocalPath,
        filename: safeFilename,
        mimeType,
        sizeBytes: buffer.length,
        createdAt: new Date(),
      };

      return await this.repos.artifacts.save(artifact);
    } finally {
      worktreePath.release();
    }
  }

  /**
   * Creates an artifact from a text snippet (e.g. from terminal selection).
   */
  async createTextArtifact(
    sessionId: string,
    filename: string,
    textContent: string,
    direction: ArtifactDirection = 'output'
  ): Promise<Artifact> {
    const buffer = Buffer.from(textContent, 'utf8');
    const mimeType = filename.endsWith('.md') ? 'text/markdown' : 'text/plain';
    return this.uploadArtifactBuffer(sessionId, buffer, filename, mimeType, direction);
  }

  /**
   * Promotes an existing workspace file to a tracked session output artifact.
   */
  async promoteFile(
    sessionId: string,
    relativeOrAbsolutePath: string
  ): Promise<Artifact> {
    return this.withSessionArtifactLock(sessionId, () =>
      this.promoteFileUnlocked(sessionId, relativeOrAbsolutePath)
    );
  }

  private async promoteFileUnlocked(
    sessionId: string,
    relativeOrAbsolutePath: string
  ): Promise<Artifact> {
    const session = await this.repos.sessions.findById(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    const worktreePath = await this.sessionManager.resolveSessionWorktreePath(session);
    try {
      const persistedRoot = session.worktreePath.replace(/\/+$/, '');
      const runtimeRoot = worktreePath.value.replace(/\/+$/, '');
      const targetPath = resolveContainedPath(runtimeRoot, relativeOrAbsolutePath.trim());
      const relativePath = relativeContainedPath(runtimeRoot, targetPath);
      const persistedTargetPath = relativePath ? `${persistedRoot}/${relativePath}` : persistedRoot;

      const filename = assertSafeFilename(basename(targetPath));
      if (await this.isPathBlacklisted(targetPath) || await this.isPathBlacklisted(filename)) {
        this.logger.info('Refusing to promote blacklisted file to artifact', { filename });
        throw new Error(`File '${filename}' is blacklisted and cannot be added as an artifact`);
      }

      const host = await this.sessionManager.getHostAdapter(session.serverId);

      // Verify file exists on remote host
      const rstat = await host.stat(targetPath);
      if (rstat.isDirectory) {
        throw new Error(`Cannot promote directory '${filename}' to an artifact`);
      }

      // Check if already registered
      const existing = await this.repos.artifacts.findBySessionId(sessionId);
      const matched = existing.find((a) => a.remotePath === persistedTargetPath);
      if (matched) {
        this.logger.info('Artifact already registered, returning existing record', {
          sessionId,
          filename,
          id: matched.id,
        });
        return matched;
      }

      // Cache locally in background
      const localSessionCache = this.getSessionCacheDir(sessionId);
      await mkdir(localSessionCache, { recursive: true });
      const cachedLocalPath = resolveContainedPath(localSessionCache, filename);

      try {
        await host.downloadFile(targetPath, cachedLocalPath);
      } catch (err) {
        this.logger.warn('Could not cache promoted file locally immediately', { filename, error: err });
      }

      const mimeType = getMimeType(filename);
      const artifact: Omit<Artifact, 'createdAt'> & { createdAt?: Date } = {
        id: `art-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        sessionId,
        direction: 'output',
        remotePath: persistedTargetPath,
        cachedLocalPath: existsSync(cachedLocalPath) ? cachedLocalPath : undefined,
        filename,
        mimeType,
        sizeBytes: rstat.size,
        createdAt: new Date(),
      };

      this.logger.info('Promoted workspace file to session output artifact', {
        sessionId,
        filename,
      });

      return await this.repos.artifacts.save(artifact);
    } finally {
      worktreePath.release();
    }
  }

  /**
   * Handles detected output file from terminal stream or capture pane.
   */
  async handleDetectedOutput(
    sessionId: string,
    detectedPath: string
  ): Promise<Artifact | null> {
    return this.withSessionArtifactLock(sessionId, () =>
      this.handleDetectedOutputUnlocked(sessionId, detectedPath)
    );
  }

  private async handleDetectedOutputUnlocked(
    sessionId: string,
    detectedPath: string
  ): Promise<Artifact | null> {
    try {
      const session = await this.repos.sessions.findById(sessionId);
      if (!session) return null;

      const worktreePath = await this.sessionManager.resolveSessionWorktreePath(session);
      let promotablePath: string;
      try {
        const runtimeRoot = worktreePath.value.replace(/\/+$/, '');
        const targetPath = resolveContainedPath(runtimeRoot, detectedPath.trim());
        const relativePath = relativeContainedPath(runtimeRoot, targetPath);
        if (!relativePath) return null;
        promotablePath = relativePath;
      } finally {
        worktreePath.release();
      }

      if (await this.isPathBlacklisted(promotablePath)) {
        return null;
      }

      const host = await this.sessionManager.getHostAdapter(session.serverId);
      const worktreeForGit = await this.sessionManager.resolveSessionWorktreePath(session);
      try {
        const tracked = await host.execute(
          `git ls-files --error-unmatch -- ${quoteShellArgument(`:(literal)${promotablePath}`)}`,
          { cwd: worktreeForGit.value }
        );
        if (tracked.exitCode === 0) {
          this.logger.info('Ignoring detected versioned file', { sessionId, path: promotablePath });
          return null;
        }
        if (tracked.exitCode !== 1) {
          this.logger.warn('Could not determine whether detected file is versioned', {
            sessionId,
            path: promotablePath,
            exitCode: tracked.exitCode,
            stderr: tracked.stderr,
          });
          return null;
        }
      } finally {
        worktreeForGit.release();
      }

      // Check if already registered
      const existing = await this.repos.artifacts.findBySessionId(sessionId);
      const persistedTargetPath = `${session.worktreePath.replace(/\/+$/, '')}/${promotablePath}`;
      if (existing.some((a) => a.remotePath === persistedTargetPath)) {
        return null; // Already tracked
      }

      const runtimeTargetPath = await this.sessionManager.resolvePersistedSessionPath(session, persistedTargetPath);
      try {
        const rstat = await host.stat(runtimeTargetPath.value).catch(() => null);
        if (!rstat || rstat.isDirectory) {
          return null; // Doesn't exist on host
        }
      } finally {
        runtimeTargetPath.release();
      }

      return await this.promoteFileUnlocked(sessionId, promotablePath);
    } catch {
      return null;
    }
  }

  /**
   * Reads artifact content, using local cache when available or downloading on demand.
   */
  async getArtifactContent(
    sessionId: string,
    artifactId: string,
    maxBytes = 10 * 1024 * 1024
  ): Promise<FileContentResult> {
    return this.withSessionArtifactLock(sessionId, () =>
      this.getArtifactContentUnlocked(sessionId, artifactId, maxBytes)
    );
  }

  private async getArtifactContentUnlocked(
    sessionId: string,
    artifactId: string,
    maxBytes = 10 * 1024 * 1024
  ): Promise<FileContentResult> {
    const session = await this.repos.sessions.findById(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    const artifact = await this.repos.artifacts.findById(artifactId);
    if (!artifact) {
      throw new Error(`Artifact '${artifactId}' not found`);
    }
    if (artifact.sessionId !== sessionId) {
      throw new Error(`Artifact '${artifactId}' does not belong to session '${sessionId}'`);
    }

    const safeFilename = assertSafeFilename(artifact.filename);
    const localSessionCache = this.getSessionCacheDir(sessionId);
    const expectedCachedLocalPath = resolveContainedPath(localSessionCache, safeFilename);

    // Only read a cache path derived from the validated session and filename.
    if (artifact.cachedLocalPath === expectedCachedLocalPath && existsSync(expectedCachedLocalPath)) {
      try {
        const buf = await readFile(expectedCachedLocalPath);
        const mimeType = artifact.mimeType || getMimeType(safeFilename);
        const isImage = mimeType.startsWith('image/');
        const isPdf = mimeType === 'application/pdf';
        const binary = isImage || isPdf || isBinaryBuffer(buf);

        let content: string;
        if (isImage || isPdf) {
          content = `data:${mimeType};base64,${buf.toString('base64')}`;
        } else if (binary) {
          content = buf.toString('base64');
        } else {
          content = buf.toString('utf8');
        }

        return {
          path: artifact.remotePath,
          content,
          isBinary: binary,
          isTruncated: false,
          sizeBytes: buf.length,
          mimeType,
        };
      } catch (err) {
        this.logger.warn('Failed to read from local artifact cache, falling back to host', {
          artifactId,
          error: err,
        });
      }
    }

    // Fallback: read directly via host adapter and cache
    const host = await this.sessionManager.getHostAdapter(session.serverId);
    const remotePath = await this.sessionManager.resolvePersistedSessionPath(session, artifact.remotePath);
    let result: FileContentResult;
    try {
      result = await host.readFile(remotePath.value, maxBytes);
    } finally {
      remotePath.release();
    }

    // Cache locally for next time
    await mkdir(localSessionCache, { recursive: true });
    try {
      if (result.isBinary) {
        const rawBase64 = result.content.includes('base64,')
          ? result.content.split('base64,')[1]
          : result.content;
        await writeFile(expectedCachedLocalPath, Buffer.from(rawBase64, 'base64'));
      } else {
        await writeFile(expectedCachedLocalPath, result.content, 'utf8');
      }
      await this.repos.artifacts.save({
        ...artifact,
        cachedLocalPath: expectedCachedLocalPath,
      });
    } catch {
      // Ignore cache write errors
    }

    return { ...result, path: artifact.remotePath };
  }

  /**
   * Deletes an artifact from the registry and removes the local cached copy.
   */
  async deleteArtifact(sessionId: string, artifactId: string): Promise<boolean> {
    return this.withSessionArtifactLock(sessionId, () =>
      this.deleteArtifactUnlocked(sessionId, artifactId)
    );
  }

  private async deleteArtifactUnlocked(sessionId: string, artifactId: string): Promise<boolean> {
    const artifact = await this.repos.artifacts.findById(artifactId);
    if (!artifact || artifact.sessionId !== sessionId) {
      return false;
    }

    const safeFilename = assertSafeFilename(artifact.filename);
    const expectedCachedLocalPath = resolveContainedPath(this.getSessionCacheDir(sessionId), safeFilename);
    if (artifact.cachedLocalPath === expectedCachedLocalPath && existsSync(expectedCachedLocalPath)) {
      try {
        await rm(expectedCachedLocalPath, { force: true });
      } catch {
        // Ignore cache removal errors
      }
    }

    this.logger.info('Deleted artifact record', { sessionId, artifactId });
    return this.repos.artifacts.delete(artifactId);
  }

  /** Clears the session registry and local cache without touching remote files. */
  async clearArtifacts(sessionId: string): Promise<number> {
    return this.withSessionArtifactLock(sessionId, async () => {
      const session = await this.repos.sessions.findById(sessionId);
      if (!session) {
        throw new Error(`Session '${sessionId}' not found`);
      }

      const artifacts = await this.repos.artifacts.findBySessionId(sessionId);
      const deleted = await Promise.all(
        artifacts.map((artifact) => this.deleteArtifactUnlocked(sessionId, artifact.id))
      );
      return deleted.filter(Boolean).length;
    });
  }

  private async withSessionArtifactLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionArtifactLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.sessionArtifactLocks.set(sessionId, queued);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionArtifactLocks.get(sessionId) === queued) {
        this.sessionArtifactLocks.delete(sessionId);
      }
    }
  }
}

function quoteShellArgument(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function getMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'svg': return 'image/svg+xml';
    case 'webp': return 'image/webp';
    case 'ico': return 'image/x-icon';
    case 'json': return 'application/json';
    case 'md': return 'text/markdown';
    case 'ts':
    case 'tsx': return 'text/typescript';
    case 'js':
    case 'jsx': return 'text/javascript';
    case 'html': return 'text/html';
    case 'css': return 'text/css';
    case 'txt': return 'text/plain';
    case 'yaml':
    case 'yml': return 'text/yaml';
    case 'pdf': return 'application/pdf';
    case 'csv': return 'text/csv';
    case 'sql': return 'application/sql';
    default: return 'application/octet-stream';
  }
}

function isBinaryBuffer(buf: Buffer): boolean {
  const checkLength = Math.min(buf.length, 1024);
  for (let i = 0; i < checkLength; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
