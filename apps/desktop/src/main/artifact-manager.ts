import { join, basename, dirname } from 'node:path';
import { mkdir, writeFile, readFile, rm, rename, readdir, stat as localStat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  detectOutputArtifacts,
  matchesBlacklistPattern,
} from '@spawnea/state';

export interface ArtifactManagerOptions {
  repositories: Repositories;
  sessionManager: SessionManager;
  cacheDir: string;
  blacklistFilePath?: string;
  logger?: Logger;
  maxFileBytes?: number;
  maxCacheBytes?: number;
  maxPreviewBytes?: number;
}

export const DEFAULT_ARTIFACT_LIMITS = {
  maxFileBytes: 50 * 1024 * 1024,
  maxCacheBytes: 250 * 1024 * 1024,
  maxPreviewBytes: 10 * 1024 * 1024,
} as const;

export class ArtifactManager {
  private readonly repos: Repositories;
  private readonly sessionManager: SessionManager;
  private readonly cacheDir: string;
  private readonly blacklistFilePath: string;
  private readonly logger: Logger;
  private readonly maxFileBytes: number;
  private readonly maxCacheBytes: number;
  private readonly maxPreviewBytes: number;
  private readonly sessionArtifactLocks = new Map<string, Promise<void>>();
  private cacheWriteQueue: Promise<void> = Promise.resolve();
  private artifactTransferQueue: Promise<void> = Promise.resolve();
  private readonly cacheReconciliation: Promise<void>;

  constructor(options: ArtifactManagerOptions) {
    this.repos = options.repositories;
    this.sessionManager = options.sessionManager;
    this.cacheDir = options.cacheDir;
    this.blacklistFilePath =
      options.blacklistFilePath || join(dirname(options.cacheDir), 'artifact-blacklist.json');
    this.logger = options.logger || createLogger('ArtifactManager');
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_ARTIFACT_LIMITS.maxFileBytes;
    this.maxCacheBytes = options.maxCacheBytes ?? DEFAULT_ARTIFACT_LIMITS.maxCacheBytes;
    this.maxPreviewBytes = options.maxPreviewBytes ?? DEFAULT_ARTIFACT_LIMITS.maxPreviewBytes;
    if (![this.maxFileBytes, this.maxCacheBytes, this.maxPreviewBytes].every(Number.isSafeInteger) ||
        this.maxFileBytes < 1 || this.maxCacheBytes < 1 || this.maxPreviewBytes < 1) {
      throw new Error('Artifact cache limits must be positive safe integers');
    }
    this.cacheReconciliation = this.reconcileCache();
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
      const artifactId = `art-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const cachedLocalPath = this.getCachePath(sessionId, `${persistedRemotePath}|${direction}|${artifactId}`, filename);
      await mkdir(dirname(cachedLocalPath), { recursive: true });
      const sourceStat = await localStat(localSourcePath);
      this.assertFileWithinLimit(sourceStat.size, 'upload');
      const sourceBuffer = await readLocalPrefix(localSourcePath, this.maxFileBytes + 1);
      const finalSourceStat = await localStat(localSourcePath);
      if (sourceBuffer.length !== finalSourceStat.size) {
        throw new Error(`Cannot upload artifact: source file changed while being read`);
      }
      this.assertFileWithinLimit(sourceBuffer.length, 'upload');


      this.logger.info('Uploading artifact file to host and caching locally', {
        sessionId,
        filename,
        cachedLocalPath,
        direction,
      });

      // Write a temporary cache entry so a failed replacement preserves the previous cache.
      const temporaryCachedPath = join(dirname(cachedLocalPath), `.tmp-${artifactId}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await this.withCacheWrite(sourceBuffer.length, async () => {
        await writeFile(temporaryCachedPath, sourceBuffer);
        try {
          await host.writeFile(remotePath, sourceBuffer);
          await rename(temporaryCachedPath, cachedLocalPath);
        } catch (error) {
          await rm(temporaryCachedPath, { force: true });
          throw error;
        }
      });

      const lstat = await localStat(cachedLocalPath);
      const sizeBytes = lstat?.size ?? 0;
      const mimeType = getMimeType(filename);

      const artifact: Omit<Artifact, 'createdAt'> & { createdAt?: Date } = {
        id: artifactId,
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
      const artifactId = `art-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const cachedLocalPath = this.getCachePath(sessionId, `${persistedRemotePath}|${direction}|${artifactId}`, safeFilename);
      await mkdir(dirname(cachedLocalPath), { recursive: true });
      this.assertFileWithinLimit(buffer.length, 'upload');


      this.logger.info('Writing artifact buffer to host and caching locally', {
        sessionId,
        filename,
        sizeBytes: buffer.length,
        direction,
      });

      // Write a temporary cache entry so a failed replacement preserves the previous cache.
      const temporaryCachedPath = join(dirname(cachedLocalPath), `.tmp-${artifactId}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await this.withCacheWrite(buffer.length, async () => {
        await writeFile(temporaryCachedPath, buffer);
        try {
          await host.writeFile(remotePath, buffer);
          await rename(temporaryCachedPath, cachedLocalPath);
        } catch (error) {
          await rm(temporaryCachedPath, { force: true });
          throw error;
        }
      });

      const artifact: Omit<Artifact, 'createdAt'> & { createdAt?: Date } = {
        id: artifactId,
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
    relativeOrAbsolutePath: string,
    allowMetadataOnly = false
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
        if (matched.cachedLocalPath && existsSync(matched.cachedLocalPath)) {
          this.logger.info('Artifact already registered, returning existing record', {
            sessionId,
            filename,
            id: matched.id,
          });
          return matched;
        }

        // Retry explicit promotion for metadata-only records instead of reporting a false success.
        this.assertFileWithinLimit(rstat.size, 'promote');
        const retryBytes = await host.readFileRaw(targetPath, this.maxFileBytes + 1);
        const retryStat = await host.stat(targetPath);
        if (retryStat.isDirectory || retryStat.size !== retryBytes.length || retryBytes.length > this.maxFileBytes) {
          throw new Error(`Artifact '${filename}' changed while being read or exceeds the ${formatBytes(this.maxFileBytes)} per-file cache limit`);
        }
        const retryCachePath = this.getCachePath(sessionId, `${persistedTargetPath}|output|${matched.id}`, filename);
        await mkdir(dirname(retryCachePath), { recursive: true });
        await this.withCacheWrite(retryBytes.length, () => writeFile(retryCachePath, retryBytes));
        return await this.repos.artifacts.save({ ...matched, cachedLocalPath: retryCachePath, sizeBytes: retryStat.size });
      }

      const cachedLocalPath = this.getCachePath(sessionId, `${persistedTargetPath}|output`, filename);

      let persistedSize = rstat.size;
      await this.withArtifactTransferSlot(async () => {
        try {
          this.assertFileWithinLimit(rstat.size, 'promote');

          const cachedBytes = await host.readFileRaw(targetPath, this.maxFileBytes + 1);
          const postReadStat = await host.stat(targetPath);
          if (postReadStat.isDirectory || postReadStat.size !== cachedBytes.length || cachedBytes.length > this.maxFileBytes) {
            throw new Error(`Artifact '${filename}' changed while being read or exceeds the ${formatBytes(this.maxFileBytes)} per-file cache limit`);
          }
          persistedSize = postReadStat.size;
          await mkdir(dirname(cachedLocalPath), { recursive: true });
          await this.withCacheWrite(cachedBytes.length, () => writeFile(cachedLocalPath, cachedBytes));
        } catch (err) {
          if (!allowMetadataOnly) throw err;
          this.logger.warn('Could not cache promoted file locally immediately', { filename, error: err });
          await this.removeEmptyCacheDirectories(dirname(cachedLocalPath));
        }
      });

      const mimeType = getMimeType(filename);
      const artifact: Omit<Artifact, 'createdAt'> & { createdAt?: Date } = {
        id: `art-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        sessionId,
        direction: 'output',
        remotePath: persistedTargetPath,
        cachedLocalPath: existsSync(cachedLocalPath) ? cachedLocalPath : undefined,
        filename,
        mimeType,
        sizeBytes: persistedSize,
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
   * Processes terminal lines or stream chunks, detects candidate artifact paths,
   * validates them against workspace/git/filesystem, and persists any new artifacts.
   */
  async processOutputChunk(
    sessionId: string,
    lines: string[] | string,
    harness?: string
  ): Promise<Artifact[]> {
    if (!lines || (Array.isArray(lines) && lines.length === 0)) {
      return [];
    }

    const session = await this.repos.sessions.findById(sessionId);
    if (!session) return [];

    const worktreePath = await this.sessionManager.resolveSessionWorktreePath(session);
    let detectedCandidates: ReturnType<typeof detectOutputArtifacts>;
    try {
      detectedCandidates = detectOutputArtifacts(lines, {
        worktreePath: worktreePath.value,
        harness,
      });
    } finally {
      worktreePath.release();
    }

    if (detectedCandidates.length === 0) {
      return [];
    }

    const createdArtifacts: Artifact[] = [];
    for (const candidate of detectedCandidates) {
      const created = await this.handleDetectedOutput(sessionId, candidate.normalizedPath);
      if (created) {
        createdArtifacts.push(created);
      }
    }

    return createdArtifacts;
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

      return await this.promoteFileUnlocked(sessionId, promotablePath, true);
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
    maxBytes = this.maxPreviewBytes
  ): Promise<FileContentResult> {
    return this.withSessionArtifactLock(sessionId, () =>
      this.getArtifactContentUnlocked(sessionId, artifactId, maxBytes, false)
    );
  }

  async getArtifactContentForExport(sessionId: string, artifactId: string): Promise<FileContentResult> {
    return this.withSessionArtifactLock(sessionId, () =>
      this.getArtifactContentUnlocked(sessionId, artifactId, this.maxFileBytes, true)
    );
  }

  private async getArtifactContentUnlocked(
    sessionId: string,
    artifactId: string,
    maxBytes = this.maxPreviewBytes,
    allowFullContent = false
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
    const previewLimit = allowFullContent
      ? Math.min(Math.max(1, maxBytes), this.maxFileBytes)
      : Math.min(Math.max(1, maxBytes), this.maxPreviewBytes);
    const expectedCachedLocalPath = this.getCachePath(sessionId, `${artifact.remotePath}|${artifact.direction}`, safeFilename);
    const legacyCachedLocalPath = resolveContainedPath(this.getSessionCacheDir(sessionId), safeFilename);
    const cachedPath = artifact.cachedLocalPath && isOwnedCachePath(this.getSessionCacheDir(sessionId), artifact.cachedLocalPath) && existsSync(artifact.cachedLocalPath)
      ? artifact.cachedLocalPath
      : null;

    // Accept both current hashed paths and ownership-checked legacy paths during migration.
    if (cachedPath) {
      try {
        if (cachedPath === legacyCachedLocalPath && await this.cachePathIsReferenced(cachedPath, artifact.id)) {
          try {
            await rm(cachedPath, { force: true });
          } catch (error) {
            this.logger.warn('Could not quarantine ambiguous legacy artifact cache', { artifactId, error });
          }
          throw new Error('Ambiguous legacy artifact cache was quarantined; refreshing from host');
        }
        const cachedStat = await localStat(cachedPath);
        const buf = await readLocalPrefix(cachedPath, previewLimit);
        const mimeType = artifact.mimeType || getMimeType(safeFilename);
        const isImage = mimeType.startsWith('image/');
        const isPdf = mimeType === 'application/pdf';
        const binary = isImage || isPdf ||
          (mimeType !== 'application/octet-stream' && !isTextMimeType(mimeType)) ||
          isBinaryBuffer(buf);

        let content: string;
        if (isImage || isPdf) {
          content = `data:${mimeType};base64,${buf.toString('base64')}`;
        } else if (binary) {
          content = buf.toString('base64');
        } else {
          content = buf.toString('utf8');
        }

        const isTruncated = cachedStat.size > previewLimit;
        const cacheSizeMatchesArtifact = cachedStat.size === artifact.sizeBytes;
        if (!cacheSizeMatchesArtifact) {
          throw new Error(`Cached artifact size mismatch: expected ${artifact.sizeBytes}, got ${cachedStat.size}`);
        }
        if (cachedPath === legacyCachedLocalPath && !isTruncated && !existsSync(expectedCachedLocalPath)) {
          try {
            await mkdir(dirname(expectedCachedLocalPath), { recursive: true });
            await rename(legacyCachedLocalPath, expectedCachedLocalPath);
            await this.repos.artifacts.save({ ...artifact, cachedLocalPath: expectedCachedLocalPath });
          } catch (error) {
            this.logger.warn('Could not migrate legacy artifact cache path', { artifactId, error });
          }
        }

        return {
          path: artifact.remotePath,
          content,
          isBinary: binary,
          isTruncated,
          sizeBytes: artifact.sizeBytes,
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
    let currentRemoteSize: number | undefined;
    let resolvedRemotePath: string | undefined;
    try {
      resolvedRemotePath = remotePath.value;
      result = await host.readFile(resolvedRemotePath, previewLimit);
      const postReadStat = await host.stat(resolvedRemotePath);
      currentRemoteSize = postReadStat.size;
      if (currentRemoteSize !== result.sizeBytes) {
        throw new Error(`Artifact '${artifact.filename}' changed size while being read`);
      }
    } finally {
      remotePath.release();
    }

    // Never cache a preview: a truncated response must not become a seemingly complete artifact.
    if (!result.isTruncated && result.sizeBytes <= this.maxFileBytes &&
        currentRemoteSize === result.sizeBytes && currentRemoteSize <= this.maxFileBytes) {
      try {
        await mkdir(dirname(expectedCachedLocalPath), { recursive: true });
        const currentSize = result.sizeBytes;
        const cachedBytes = encodeCachedResult(result);
        const oldSize = await localStat(expectedCachedLocalPath).then((s) => s.size).catch(() => 0);
        await this.withCacheWrite(Math.max(0, cachedBytes.length - oldSize), () => writeFile(expectedCachedLocalPath, cachedBytes));
        await this.repos.artifacts.save({ ...artifact, cachedLocalPath: expectedCachedLocalPath, sizeBytes: currentSize });
        if (artifact.cachedLocalPath && artifact.cachedLocalPath !== expectedCachedLocalPath &&
            isOwnedCachePath(this.getSessionCacheDir(sessionId), artifact.cachedLocalPath) &&
            !(await this.cachePathIsReferenced(artifact.cachedLocalPath, artifact.id))) {
          await rm(artifact.cachedLocalPath, { force: true });
        }
      } catch (error) {
        this.logger.warn('Could not cache complete artifact content', { artifactId, error });
      }
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

    const cacheRoot = this.getSessionCacheDir(sessionId);
    if (artifact.cachedLocalPath && isOwnedCachePath(cacheRoot, artifact.cachedLocalPath) &&
        existsSync(artifact.cachedLocalPath) && !(await this.cachePathIsReferenced(artifact.cachedLocalPath, artifact.id))) {
      try {
        await rm(artifact.cachedLocalPath, { force: true });
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
      const ownedPaths = new Set(
        artifacts
          .map((artifact) => artifact.cachedLocalPath)
          .filter((path): path is string => path !== undefined && isOwnedCachePath(this.getSessionCacheDir(sessionId), path))
      );
      for (const path of ownedPaths) {
        try {
          await rm(path, { force: true });
        } catch (error) {
          this.logger.warn('Could not remove artifact cache during clear', { sessionId, path, error });
        }
      }
      await this.removeEmptyCacheDirectories(this.getSessionCacheDir(sessionId));
      let deletedCount = 0;
      for (const artifact of artifacts) {
        if (await this.repos.artifacts.delete(artifact.id)) deletedCount++;
      }
      return deletedCount;
    });
  }

  private getCachePath(sessionId: string, sourceIdentity: string, filename: string): string {
    const key = createHash('sha256').update(sourceIdentity).digest('hex').slice(0, 16);
    return resolveContainedPath(this.getSessionCacheDir(sessionId), `${key}/${filename}`);
  }

  private assertFileWithinLimit(size: number, operation: string): void {
    if (!Number.isSafeInteger(size) || size > this.maxFileBytes) {
      throw new Error(`Cannot ${operation} artifact: file exceeds the ${formatBytes(this.maxFileBytes)} per-file limit`);
    }
  }

  getMaxFileBytes(): number {
    return this.maxFileBytes;
  }

  private async assertCacheCapacity(additionalBytes: number): Promise<void> {
    await this.cacheReconciliation;
    let used = 0;
    try {
      used = await getDirectorySize(this.cacheDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (used + additionalBytes > this.maxCacheBytes) {
      throw new Error(`Artifact cache limit reached (${formatBytes(this.maxCacheBytes)})`);
    }
  }

  private async withCacheWrite<T>(size: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.cacheWriteQueue;
    let release!: () => void;
    this.cacheWriteQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await this.assertCacheCapacity(size);
      return await operation();
    } finally {
      release();
    }
  }

  private async withArtifactTransferSlot<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.artifactTransferQueue;
    let release!: () => void;
    this.artifactTransferQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async reconcileCache(): Promise<void> {
    let files: Array<{ path: string; size: number; mtimeMs: number }>;
    try {
      files = await getCacheFiles(this.cacheDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const oversizedFiles = files.filter((file) => file.size > this.maxFileBytes);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files.sort((a, b) => {
      const oversizedOrder = Number(oversizedFiles.includes(b)) - Number(oversizedFiles.includes(a));
      return oversizedOrder || a.mtimeMs - b.mtimeMs;
    })) {
      if (total <= this.maxCacheBytes && file.size <= this.maxFileBytes) break;
      try {
        await rm(file.path, { force: true });
        total -= file.size;
      } catch (error) {
        this.logger.warn('Could not evict oversized artifact cache entry', { path: file.path, error });
      }
    }
    await this.removeEmptyCacheDirectories(this.cacheDir);
  }

  private async removeEmptyCacheDirectories(startPath: string): Promise<void> {
    let current = startPath;
    while (current.startsWith(this.cacheDir) && current !== this.cacheDir) {
      try {
        if ((await readdir(current)).length > 0) break;
        await rm(current, { recursive: false, force: true });
      } catch {
        break;
      }
      current = dirname(current);
    }
  }

  private async cachePathIsReferenced(path: string, exceptId: string): Promise<boolean> {
    const current = await this.repos.artifacts.findById(exceptId);
    if (!current) return false;
    const artifacts = await this.repos.artifacts.findBySessionId(current.sessionId);
    return artifacts.some((candidate) => candidate.id !== exceptId && candidate.cachedLocalPath === path);
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

function encodeCachedResult(result: FileContentResult): Buffer {
  return result.isBinary
    ? Buffer.from(result.content.includes('base64,') ? result.content.split('base64,')[1] : result.content, 'base64')
    : Buffer.from(result.content, 'utf8');
}

async function readLocalPrefix(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await (await import('node:fs/promises')).open(path, 'r');
  try {
    const fileStat = await handle.stat();
    const buffer = Buffer.alloc(Math.min(fileStat.size, maxBytes));
    let totalRead = 0;
    while (totalRead < buffer.length) {
      const { bytesRead } = await handle.read(buffer, totalRead, buffer.length - totalRead, totalRead);
      if (bytesRead === 0) break;
      totalRead += bytesRead;
    }
    return buffer.subarray(0, totalRead);
  } finally {
    await handle.close();
  }
}

function isTextMimeType(mimeType: string): boolean {
  return mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml' || mimeType === 'application/sql';
}

async function getCacheFiles(path: string): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
  const entries = await readdir(path, { withFileTypes: true });
  const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...await getCacheFiles(entryPath));
    } else if (entry.isFile()) {
      const fileStat = await localStat(entryPath);
      files.push({ path: entryPath, size: fileStat.size, mtimeMs: fileStat.mtimeMs });
    }
  }
  return files;
}

async function getDirectorySize(path: string): Promise<number> {
  const entries = await (await import('node:fs/promises')).readdir(path, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await getDirectorySize(child);
    else if (entry.isFile()) total += (await localStat(child)).size;
  }
  return total;
}

function isOwnedCachePath(root: string, candidate: string): boolean {
  try {
    return resolveContainedPath(root, candidate) === candidate;
  } catch {
    return false;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
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
