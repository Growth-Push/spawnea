import { join, basename, dirname, resolve, relative, isAbsolute } from 'node:path';
import { mkdir, writeFile, readFile, rm, rename, readdir, stat as localStat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type {
  Artifact,
  ArtifactDirection,
  FileContentResult,

  HostAdapter,
  Logger,
  Session,
} from '@spawnea/domain';
import {
  assertSafeFilename,
  createLogger,
  isPathContained,
  relativeContainedPath,
  resolveContainedPath,
} from '@spawnea/domain';
import { LocalHostAdapter } from '@spawnea/hosts';
import type { Repositories } from '@spawnea/db';
import type { SessionManager } from './session-manager.js';

import {
  DEFAULT_BLACKLIST_PATTERNS,
  detectOutputArtifacts,
  isExternalArtifactFilename,
  matchesBlacklistPattern,
  validateExternalArtifactContent,
} from '@spawnea/state';

export interface ArtifactManagerOptions {
  repositories: Repositories;
  sessionManager: SessionManager;
  cacheDir: string;
  blacklistFilePath?: string;
  /** Directory for temporary copies of remote artifacts opened in the OS default app. */
  openCopiesDir?: string;
  logger?: Logger;
  maxFileBytes?: number;
  maxCacheBytes?: number;
  maxPreviewBytes?: number;
}

const EXTERNAL_VALIDATION_BYTES = 8192;
const HOST_COMMAND_TIMEOUT_MS = 5000;
const REJECTED_CANDIDATE_TTL_MS = 60_000;
const REJECTED_CANDIDATE_MAX_ENTRIES = 500;

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
  private readonly openCopiesDir: string;
  private readonly hostHomes = new Map<string, string>();
  /** Recently rejected candidates (session + requested path) -> expiry time. */
  private readonly rejectedCandidates = new Map<string, number>();
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
    this.openCopiesDir = options.openCopiesDir || join(dirname(options.cacheDir), 'artifact-open-copies');
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

      // Verify file exists on the host
      const rstat = await host.stat(targetPath);
      if (rstat.isDirectory) {
        throw new Error(`Cannot promote directory '${filename}' to an artifact`);
      }

      const existing = await this.repos.artifacts.findBySessionId(sessionId);
      const matched = existing.find((a) => a.remotePath === persistedTargetPath);
      if (matched) {
        return matched;
      }

      // The artifact is a pointer to the original file; no content is copied.
      const artifact: Omit<Artifact, 'createdAt'> & { createdAt?: Date } = {
        id: `art-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        sessionId,
        direction: 'output',
        remotePath: persistedTargetPath,
        filename,
        mimeType: getMimeType(filename),
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

    const host = await this.sessionManager.getHostAdapter(session.serverId);
    const homeDir = await this.resolveHostHome(session.serverId, host);
    const worktreePath = await this.sessionManager.resolveSessionWorktreePath(session);
    let detectedCandidates: ReturnType<typeof detectOutputArtifacts>;
    try {
      detectedCandidates = detectOutputArtifacts(lines, {
        worktreePath: worktreePath.value,
        harness,
        homeDir,
      });
    } finally {
      worktreePath.release();
    }

    if (detectedCandidates.length === 0) {
      return [];
    }

    // The project's real root is the same for every candidate of this chunk.
    const rootLease = await this.sessionManager.resolveSessionWorktreePath(session);
    let realRoot: string | null;
    try {
      realRoot = await this.realPath(host, rootLease.value.replace(/\/+$/, '')).catch(() => null);
    } finally {
      rootLease.release();
    }
    if (!realRoot) return [];

    const createdArtifacts: Artifact[] = [];
    for (const candidate of detectedCandidates) {
      const created = await this.handleDetectedOutput(sessionId, candidate.normalizedPath, realRoot);
      if (created) {
        createdArtifacts.push(created);
      }
    }

    return createdArtifacts;
  }

  /**
   * Handles a detected output file from terminal stream or capture pane. The
   * real target (after symlink resolution) decides whether it is a project
   * file or an external one; either way the artifact only points at it.
   */
  async handleDetectedOutput(
    sessionId: string,
    detectedPath: string,
    knownRealRoot?: string
  ): Promise<Artifact | null> {
    return this.withSessionArtifactLock(sessionId, () =>
      this.handleDetectedOutputUnlocked(sessionId, detectedPath, knownRealRoot)
    );
  }

  private async handleDetectedOutputUnlocked(
    sessionId: string,
    detectedPath: string,
    knownRealRoot?: string
  ): Promise<Artifact | null> {
    const rejectionKey = `${sessionId}\0${detectedPath.trim()}`;
    if (this.isRecentlyRejected(rejectionKey)) return null;
    const result = await this.detectOutputUnlocked(sessionId, detectedPath, knownRealRoot);
    if (!result.skip && !result.artifact) this.rememberRejected(rejectionKey);
    return result.artifact;
  }

  private isRecentlyRejected(key: string): boolean {
    const expiresAt = this.rejectedCandidates.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt > Date.now()) return true;
    this.rejectedCandidates.delete(key);
    return false;
  }

  private rememberRejected(key: string): void {
    this.rejectedCandidates.delete(key);
    this.rejectedCandidates.set(key, Date.now() + REJECTED_CANDIDATE_TTL_MS);
    while (this.rejectedCandidates.size > REJECTED_CANDIDATE_MAX_ENTRIES) {
      const oldest = this.rejectedCandidates.keys().next().value;
      if (oldest === undefined) break;
      this.rejectedCandidates.delete(oldest);
    }
  }

  /** `skip` marks cheap early exits (already registered by the literal path) that are not worth remembering. */
  private async detectOutputUnlocked(
    sessionId: string,
    detectedPath: string,
    knownRealRoot?: string
  ): Promise<{ artifact: Artifact | null; skip?: boolean }> {
    const none = { artifact: null };
    try {
      const session = await this.repos.sessions.findById(sessionId);
      if (!session) return { artifact: null, skip: true };

      const host = await this.sessionManager.getHostAdapter(session.serverId);
      const worktreePath = await this.sessionManager.resolveSessionWorktreePath(session);
      let runtimeRoot: string;
      try {
        runtimeRoot = worktreePath.value.replace(/\/+$/, '');
      } finally {
        worktreePath.release();
      }

      const requested = detectedPath.trim();
      if (!requested.startsWith('/')) return none;

      // Already registered paths are skipped before spawning any host process.
      const persistedRoot = session.worktreePath.replace(/\/+$/, '');
      const lexicalKeys = new Set([requested]);
      if (isPathContained(runtimeRoot, requested)) {
        const relative = relativeContainedPath(runtimeRoot, requested);
        if (relative) lexicalKeys.add(`${persistedRoot}/${relative}`);
      }
      const registered = await this.repos.artifacts.findBySessionId(sessionId);
      if (registered.some((a) => lexicalKeys.has(a.remotePath))) return { artifact: null, skip: true };

      const realTarget = await this.realPath(host, requested);
      const realRoot = knownRealRoot ?? await this.realPath(host, runtimeRoot);
      if (!realTarget || !realRoot) return none;

      if (isPathContained(realRoot, realTarget)) {
        const relativePath = relativeContainedPath(realRoot, realTarget);
        if (!relativePath) return none;
        // A link to an already registered project file is registered under its real path.
        if (registered.some((a) => a.remotePath === `${persistedRoot}/${relativePath}`)) return none;
        return { artifact: await this.registerProjectFile(sessionId, host, relativePath) };
      }
      if (registered.some((a) => a.remotePath === realTarget)) return none;
      return { artifact: await this.registerExternalFile(sessionId, host, realTarget) };
    } catch {
      return none;
    }
  }

  private async registerProjectFile(
    sessionId: string,
    host: HostAdapter,
    promotablePath: string
  ): Promise<Artifact | null> {
    const session = await this.repos.sessions.findById(sessionId);
    if (!session) return null;

    if (await this.isPathBlacklisted(promotablePath)) {
      return null;
    }

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
  }

  /**
   * Registers a readable, supported file outside the project as a pointer to
   * its real path. Nothing is copied; unsupported, missing or unreadable files
   * never become artifacts.
   */
  private async registerExternalFile(
    sessionId: string,
    host: HostAdapter,
    realPath: string
  ): Promise<Artifact | null> {
    const filename = basename(realPath);
    if (!isExternalArtifactFilename(filename) || await this.isPathBlacklisted(realPath)) {
      return null;
    }
    const existing = await this.repos.artifacts.findBySessionId(sessionId);
    if (existing.some((a) => a.remotePath === realPath)) return null;

    const rstat = await host.stat(realPath).catch(() => null);
    if (!rstat || !rstat.isFile) return null;
    const head = await host.readFileRaw(realPath, EXTERNAL_VALIDATION_BYTES).catch(() => null);
    if (!head || !validateExternalArtifactContent(filename, head)) return null;

    this.logger.info('Registered external file as session output artifact', { sessionId, filename });
    return await this.repos.artifacts.save({
      id: `art-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      sessionId,
      direction: 'output',
      remotePath: realPath,
      filename,
      mimeType: getMimeType(filename),
      sizeBytes: rstat.size,
      createdAt: new Date(),
    });
  }

  /** The external-file rules of registerExternalFile, applied to an already resolved real path. */
  private async isAcceptableExternalFile(host: HostAdapter, realPath: string): Promise<boolean> {
    const filename = basename(realPath);
    if (!isExternalArtifactFilename(filename) || await this.isPathBlacklisted(realPath)) return false;
    const rstat = await host.stat(realPath).catch(() => null);
    if (!rstat || !rstat.isFile) return false;
    const head = await host.readFileRaw(realPath, EXTERNAL_VALIDATION_BYTES).catch(() => null);
    return head !== null && validateExternalArtifactContent(filename, head);
  }

  private async realPath(host: HostAdapter, path: string): Promise<string | null> {
    const result = await host.execute(`realpath -- ${quoteShellArgument(path)}`, {
      timeoutMs: HOST_COMMAND_TIMEOUT_MS,
    });
    const resolved = result.stdout.replace(/\r?\n$/, '');
    return result.exitCode === 0 && resolved.startsWith('/') ? resolved : null;
  }

  /** The session host's real `$HOME`, queried once per host and then remembered. */
  private async resolveHostHome(serverId: string, host: HostAdapter): Promise<string | undefined> {
    const known = this.hostHomes.get(serverId);
    if (known) return known;
    try {
      const result = await host.execute('printf %s "$HOME"', { timeoutMs: HOST_COMMAND_TIMEOUT_MS });
      const home = result.stdout.trim();
      if (result.exitCode === 0 && home.startsWith('/')) {
        this.hostHomes.set(serverId, home);
        return home;
      }
    } catch {
      // Retry on the next poll.
    }
    return undefined;
  }

  /** Metadata only: no target is inspected when reference menus are displayed. */
  async getLocalReferenceContext(sessionId: string): Promise<{ workspacePath: string; homePath: string; persistedWorkspacePath: string } | null> {
    const session = await this.repos.sessions.findById(sessionId);
    if (!session) throw new Error('Session not found');
    const host = await this.sessionManager.getHostAdapter(session.serverId);
    if (!(host instanceof LocalHostAdapter)) return null;
    const root = await this.sessionManager.resolveSessionWorktreePath(session);
    try {
      const homePath = await this.resolveHostHome(session.serverId, host);
      if (!homePath) throw new Error('Session host home directory is unavailable');
      return { workspacePath: root.value, homePath, persistedWorkspacePath: session.worktreePath };
    } finally {
      root.release();
    }
  }

  async getLocalReferencePaths(sessionId: string, reference: string): Promise<{ fullPath: string; relativePath: string }> {
    if (typeof reference !== 'string' || !reference.trim() || Array.from(reference).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
      throw new Error('Invalid file reference');
    }
    const context = await this.getLocalReferenceContext(sessionId);
    if (!context) throw new Error('File reference actions are available for local sessions only');
    const fullPath = reference.startsWith('~/')
      ? resolve(context.homePath, reference.slice(2))
      : resolve(context.workspacePath, reference);
    return { fullPath, relativePath: relative(context.workspacePath, fullPath) };
  }

  /** Explicit references bypass detection/registration, never the external-file policy. */
  async withLocalReference<T>(sessionId: string, reference: string, action: (path: string, mimeType: string, internal: boolean) => Promise<T>): Promise<T> {
    const { fullPath } = await this.getLocalReferencePaths(sessionId, reference);
    const session = (await this.repos.sessions.findById(sessionId))!;
    const host = await this.sessionManager.getHostAdapter(session.serverId);
    const root = await this.sessionManager.resolveSessionWorktreePath(session);
    try {
      const realRoot = await this.realPath(host, root.value);
      const realTarget = await this.realPath(host, fullPath);
      if (!realRoot || !realTarget) throw new Error('File is missing or inaccessible');
      const internal = isPathContained(realRoot, realTarget);
      if (await this.isPathBlacklisted(fullPath) || await this.isPathBlacklisted(realTarget)) {
        throw new Error('File is excluded by the artifact access policy');
      }
      if (!internal && ((!isAbsolute(reference) && !reference.startsWith('~/')) || !(await this.isAcceptableExternalFile(host, realTarget)))) {
        throw new Error('External file reference is not supported by the artifact access policy');
      }
      const stat = await host.stat(realTarget);
      if (!stat.isFile) throw new Error('Reference is not a regular file');
      this.assertFileWithinLimit(stat.size, 'open');
      // Check readability even for an OS open, without changing permissions.
      await host.readFileRaw(realTarget, 1);
      return await action(realTarget, getMimeType(basename(realTarget)), internal);
    } finally {
      root.release();
    }
  }

  async getLocalReferenceContent(sessionId: string, reference: string): Promise<FileContentResult> {
    return this.withLocalReference(sessionId, reference, async (path, mimeType) => {
      const session = (await this.repos.sessions.findById(sessionId))!;
      const host = await this.sessionManager.getHostAdapter(session.serverId);
      return withDataUri(await host.readFile(path, this.maxPreviewBytes), mimeType);
    });
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

  async getArtifactContentForExport(sessionId: string, artifactId: string): Promise<FileContentResult & { cachedLocalPath?: string }> {
    return this.withSessionArtifactLock(sessionId, () =>
      this.getArtifactContentUnlocked(sessionId, artifactId, this.maxFileBytes, true)
    );
  }

  private async getArtifactContentUnlocked(
    sessionId: string,
    artifactId: string,
    maxBytes = this.maxPreviewBytes,
    allowFullContent = false
  ): Promise<FileContentResult & { cachedLocalPath?: string }> {
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
        let resolvedCachedPath = cachedPath;
        if (cachedPath === legacyCachedLocalPath && !isTruncated && !existsSync(expectedCachedLocalPath)) {
          try {
            await mkdir(dirname(expectedCachedLocalPath), { recursive: true });
            await rename(legacyCachedLocalPath, expectedCachedLocalPath);
            resolvedCachedPath = expectedCachedLocalPath;
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
          cachedLocalPath: resolvedCachedPath,
        };
      } catch (err) {
        this.logger.warn('Failed to read from local artifact cache, falling back to host', {
          artifactId,
          error: err,
        });
      }
    }

    // No usable local copy: read the original through the host. The result is
    // never written to the artifact cache.
    const host = await this.sessionManager.getHostAdapter(session.serverId);
    const remotePath = await this.resolveArtifactHostPath(session, host, artifact);
    try {
      const result = await host.readFile(remotePath.value, previewLimit).catch((error: unknown) => {
        throw unavailableError(artifact.filename, error);
      });
      const postReadStat = await host.stat(remotePath.value).catch((error: unknown) => {
        throw unavailableError(artifact.filename, error);
      });
      if (postReadStat.size !== result.sizeBytes) {
        throw new Error(`Artifact '${artifact.filename}' changed size while being read`);
      }
      return { ...withDataUri(result, artifact.mimeType), path: artifact.remotePath };
    } finally {
      remotePath.release();
    }
  }

  /**
   * Resolves the host path an artifact points at. Project files resolve
   * against the session workspace; external pointers must still be the same
   * readable, supported file they were registered as.
   */
  private async resolveArtifactHostPath(
    session: Session,
    host: HostAdapter,
    artifact: Artifact
  ): Promise<{ value: string; release: () => void }> {
    const persistedRoot = session.worktreePath.replace(/\/+$/, '');
    if (artifact.remotePath === persistedRoot || artifact.remotePath.startsWith(`${persistedRoot}/`)) {
      const lease = await this.sessionManager.resolvePersistedSessionPath(session, artifact.remotePath);
      try {
        // A project file may since have become a link to somewhere else: judge its real target.
        const worktree = await this.sessionManager.resolveSessionWorktreePath(session);
        let realRoot: string | null;
        try {
          realRoot = await this.realPath(host, worktree.value.replace(/\/+$/, ''));
        } finally {
          worktree.release();
        }
        const realTarget = await this.realPath(host, lease.value).catch(() => null);
        if (!realRoot || !realTarget) throw unavailableError(artifact.filename);
        if (isPathContained(realRoot, realTarget)) return lease;
        if (!(await this.isAcceptableExternalFile(host, realTarget))) {
          throw unavailableError(artifact.filename);
        }
        return { value: realTarget, release: lease.release };
      } catch (error) {
        lease.release();
        throw error;
      }
    }

    const externalPath = artifact.remotePath;
    if (!externalPath.startsWith('/') || !isExternalArtifactFilename(basename(externalPath))) {
      throw new Error(`Artifact '${artifact.filename}' points outside the project and is not a supported type`);
    }
    const real = await this.realPath(host, externalPath).catch(() => null);
    if (real !== externalPath) {
      throw unavailableError(artifact.filename);
    }
    const head = await host.readFileRaw(externalPath, EXTERNAL_VALIDATION_BYTES).catch((error: unknown) => {
      throw unavailableError(artifact.filename, error);
    });
    if (!validateExternalArtifactContent(basename(externalPath), head)) {
      throw unavailableError(artifact.filename);
    }
    return { value: externalPath, release: () => {} };
  }

  /**
   * Returns the file to hand to the OS "open" action. Local sessions open the
   * original; remote sessions download a temporary copy at this moment.
   */
  async resolveArtifactOpenTarget(
    sessionId: string,
    artifactId: string
  ): Promise<{ path: string; temporaryCopy: boolean }> {
    return this.withSessionArtifactLock(sessionId, async () => {
      const session = await this.repos.sessions.findById(sessionId);
      if (!session) throw new Error(`Session '${sessionId}' not found`);
      const artifact = await this.repos.artifacts.findById(artifactId);
      if (!artifact || artifact.sessionId !== sessionId) {
        throw new Error(`Artifact '${artifactId}' not found`);
      }

      const cachedPath = await this.usableCachedCopy(sessionId, artifact);
      if (cachedPath) return { path: cachedPath, temporaryCopy: false };

      const host = await this.sessionManager.getHostAdapter(session.serverId);
      const remotePath = await this.resolveArtifactHostPath(session, host, artifact);
      try {
        const rstat = await host.stat(remotePath.value).catch((error: unknown) => {
          throw unavailableError(artifact.filename, error);
        });
        if (!rstat.isFile) throw unavailableError(artifact.filename);
        if (host instanceof LocalHostAdapter) {
          return { path: remotePath.value, temporaryCopy: false };
        }
        this.assertFileWithinLimit(rstat.size, 'open');
        // One stable location per artifact, overwritten on each open.
        const copyDir = resolveContainedPath(this.openCopiesDir, artifact.id);
        const copyPath = join(copyDir, assertSafeFilename(artifact.filename));
        await rm(copyDir, { recursive: true, force: true });
        await mkdir(copyDir, { recursive: true });
        try {
          await host.downloadFile(remotePath.value, copyPath);
          const copied = await localStat(copyPath);
          this.assertFileWithinLimit(copied.size, 'open');
        } catch (error) {
          await rm(copyDir, { recursive: true, force: true });
          throw error;
        }
        return { path: copyPath, temporaryCopy: true };
      } finally {
        remotePath.release();
      }
    });
  }

  /**
   * The artifact's own cached copy, only if it is owned by this session's
   * cache, matches the recorded size, and is not a legacy file shared with
   * another artifact. Anything else must be read from the host instead.
   */
  private async usableCachedCopy(sessionId: string, artifact: Artifact): Promise<string | null> {
    const cachedPath = artifact.cachedLocalPath;
    const cacheRoot = this.getSessionCacheDir(sessionId);
    if (!cachedPath || !isOwnedCachePath(cacheRoot, cachedPath) || !existsSync(cachedPath)) return null;
    const legacyPath = resolveContainedPath(cacheRoot, assertSafeFilename(artifact.filename));
    if (cachedPath === legacyPath && await this.cachePathIsReferenced(cachedPath, artifact.id)) return null;
    const cachedStat = await localStat(cachedPath).catch(() => null);
    return cachedStat && cachedStat.isFile() && cachedStat.size === artifact.sizeBytes ? cachedPath : null;
  }

  /** Deletes a temporary copy made for opening, e.g. when the OS could not open it. */
  async discardTemporaryCopy(copyPath: string): Promise<void> {
    try {
      const copyDir = dirname(resolveContainedPath(this.openCopiesDir, copyPath));
      if (copyDir !== this.openCopiesDir) await rm(copyDir, { recursive: true, force: true });
    } catch (error) {
      this.logger.warn('Could not discard temporary artifact copy', { error });
    }
  }

  /** Removes every temporary copy left by earlier runs. */
  async removeTemporaryCopies(): Promise<void> {
    await rm(this.openCopiesDir, { recursive: true, force: true }).catch((error: unknown) => {
      this.logger.warn('Could not remove temporary artifact copies', { error });
    });
  }

  /**
   * Drops cache files Spawnea created for detected or promoted artifacts, which
   * are now plain pointers to the original file. Upload cache entries stay.
   */
  async removeDetectedArtifactCaches(): Promise<number> {
    let removed = 0;
    const sessions = await this.repos.sessions.findAll();
    for (const session of sessions) {
      await this.withSessionArtifactLock(session.id, async () => {
        const cacheRoot = this.getSessionCacheDir(session.id);
        for (const artifact of await this.repos.artifacts.findBySessionId(session.id)) {
          if (!artifact.cachedLocalPath || artifact.remotePath.includes('/.spawnea/artifacts/')) continue;
          if (isOwnedCachePath(cacheRoot, artifact.cachedLocalPath)) {
            await rm(artifact.cachedLocalPath, { force: true }).catch((error: unknown) => {
              this.logger.warn('Could not remove legacy artifact cache', { artifactId: artifact.id, error });
            });
          }
          await this.repos.artifacts.save({ ...artifact, cachedLocalPath: undefined });
          removed++;
        }
        await this.removeEmptyCacheDirectories(cacheRoot);
      });
    }
    return removed;
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
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || existsSync(this.cacheDir)) throw error;
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

/** Hosts return PDF bytes as bare base64; the preview needs a data URI like the cached path gives. */
function withDataUri(result: FileContentResult, artifactMimeType: string): FileContentResult {
  const mimeType = result.mimeType || artifactMimeType;
  if (result.isBinary && mimeType === 'application/pdf' && !result.content.startsWith('data:')) {
    return { ...result, content: `data:${mimeType};base64,${result.content}` };
  }
  return result;
}

function unavailableError(filename: string, cause?: unknown): Error {
  const detail = cause instanceof Error ? `: ${cause.message}` : '';
  return new Error(`Artifact '${filename}' is no longer available${detail}`);
}

function quoteShellArgument(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
    case 'htm':
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
