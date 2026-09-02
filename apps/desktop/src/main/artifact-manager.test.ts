import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, createRepositories, type Repositories } from '@spawnea/db';
import { MockHostAdapter } from '@spawnea/hosts';
import { CatalogManager } from './catalog-manager.js';
import { SessionContextStore } from './session-context-store.js';
import { PtyBroker } from './pty-broker.js';
import { SessionManager } from './session-manager.js';
import { ArtifactManager } from './artifact-manager.js';

describe('ArtifactManager', () => {
  let tempDir: string;
  let repos: Repositories;
  let dbConn: ReturnType<typeof createDatabase>;
  let sessionManager: SessionManager;
  let artifactManager: ArtifactManager;
  let mockHost: MockHostAdapter;
  let sessionId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'spawnea-test-art-'));
    dbConn = createDatabase({ path: ':memory:', migrate: true });
    repos = createRepositories(dbConn.db);
    mockHost = new MockHostAdapter('dev-workstation', [
      '/workspace/spawnea',
      '/workspace/spawnea/docs',
    ]);

    await repos.servers.save({
      id: 'dev-workstation',
      name: 'Development Workstation',
      host: 'example-host',
      sshPort: 22,
      enabled: true,
    });

    await repos.projects.save({
      id: 'dev-workstation:spawnea',
      serverId: 'dev-workstation',
      name: 'Spawnea',
      rootPath: '/workspace/spawnea',
    });

    await repos.agents.save({
      id: 'dev-workstation:claude',
      name: 'Claude Code',
      harness: 'claude',
      command: 'claude',
    });

    const session = await repos.sessions.save({
      id: 'sess-art-1',
      name: 'Artifact Session',
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Test artifacts',
      worktreePath: '/workspace/spawnea',
      branch: 'main',
      tmuxSessionName: 'spawnea-art-test',
      status: 'working',
    });
    sessionId = session.id;

    sessionManager = new SessionManager({
      repositories: repos,
      catalogManager: new CatalogManager(),
      contextStore: new SessionContextStore({ storeDir: join(tempDir, 'sessions') }),
      ptyBroker: new PtyBroker(),
      hostAdapterFactory: async () => mockHost,
    });

    artifactManager = new ArtifactManager({
      repositories: repos,
      sessionManager,
      cacheDir: join(tempDir, 'artifacts'),
    });
  });

  afterEach(async () => {
    await sessionManager.dispose();
    dbConn.close();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('uploads a local file as an input artifact into workspace and caches it', async () => {
    const localSrc = join(tempDir, 'sample.md');
    writeFileSync(localSrc, '# Sample Header\nText content');

    const artifact = await artifactManager.uploadArtifactFile(sessionId, localSrc, 'input');

    expect(artifact.sessionId).toBe(sessionId);
    expect(artifact.direction).toBe('input');
    expect(artifact.filename).toBe('sample.md');
    expect(artifact.mimeType).toBe('text/markdown');
    expect(artifact.remotePath).toBe('/workspace/spawnea/.spawnea/artifacts/sample.md');
    expect(artifact.cachedLocalPath).toBeDefined();

    // Verify stored in DB
    const list = await repos.artifacts.findBySessionId(sessionId);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(artifact.id);
  });

  it('writes an in-memory buffer as an input artifact (clipboard paste)', async () => {
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]);
    const artifact = await artifactManager.uploadArtifactBuffer(
      sessionId,
      pngBuffer,
      'screenshot-1.png',
      'image/png',
      'input'
    );

    expect(artifact.filename).toBe('screenshot-1.png');
    expect(artifact.mimeType).toBe('image/png');
    expect(artifact.sizeBytes).toBe(pngBuffer.length);
    expect(artifact.direction).toBe('input');
    expect(artifact.remotePath).toBe('/workspace/spawnea/.spawnea/artifacts/screenshot-1.png');
  });

  it('persists artifact paths against a safe locator for credential-backed worktrees', async () => {
    const session = await repos.sessions.findById(sessionId);
    expect(session).not.toBeNull();
    if (!session) return;
    const locator = 'catalog-project://dev-workstation/spawnea';
    await repos.sessions.save({ ...session, worktreePath: locator });
    const release = vi.fn();
    vi.spyOn(sessionManager, 'resolveSessionWorktreePath').mockResolvedValue({
      value: '/workspace/spawnea',
      sensitive: true,
      release,
    });

    const artifact = await artifactManager.uploadArtifactBuffer(
      sessionId,
      Buffer.from('safe'),
      'safe.txt',
      'text/plain',
      'input'
    );

    expect(artifact.remotePath).toBe(`${locator}/.spawnea/artifacts/safe.txt`);
    expect(artifact.remotePath).not.toContain('/workspace/spawnea');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('promotes an existing workspace file to an output artifact', async () => {
    mockHost.mockFiles.set('/workspace/spawnea/docs/architecture.md', {
      content: '# Architecture Overview',
      mimeType: 'text/markdown',
      size: 23,
    });

    const artifact = await artifactManager.promoteFile(sessionId, 'docs/architecture.md');

    expect(artifact.direction).toBe('output');
    expect(artifact.filename).toBe('architecture.md');
    expect(artifact.remotePath).toBe('/workspace/spawnea/docs/architecture.md');
    expect(artifact.sizeBytes).toBe(23);

    // Promote again should return existing artifact record
    const duplicate = await artifactManager.promoteFile(sessionId, 'docs/architecture.md');
    expect(duplicate.id).toBe(artifact.id);
  });

  it('handles detected outputs from terminal stream', async () => {
    mockHost.mockFiles.set('/workspace/spawnea/TO_DELETE_README.md', {
      content: '# Created by LLM',
      mimeType: 'text/markdown',
      size: 16,
    });
    mockHost.customRules.push({
      pattern: 'git ls-files --error-unmatch',
      response: { stdout: '', stderr: 'pathspec did not match any files', exitCode: 1 },
    });

    const artifact = await artifactManager.handleDetectedOutput(
      sessionId,
      '/workspace/spawnea/TO_DELETE_README.md'
    );

    expect(artifact).not.toBeNull();
    expect(artifact?.filename).toBe('TO_DELETE_README.md');
    expect(artifact?.direction).toBe('output');

    // If file does not exist on host, handleDetectedOutput should return null
    const missing = await artifactManager.handleDetectedOutput(
      sessionId,
      '/workspace/spawnea/nonexistent.md'
    );
    expect(missing).toBeNull();
  });

  it('ignores automatically detected files that are tracked by Git', async () => {
    mockHost.mockFiles.set('/workspace/spawnea/README.md', {
      content: '# Tracked file',
      mimeType: 'text/markdown',
      size: 14,
    });
    mockHost.customRules.push({
      pattern: 'git ls-files --error-unmatch',
      response: { stdout: 'README.md\n', stderr: '', exitCode: 0 },
    });

    const artifact = await artifactManager.handleDetectedOutput(sessionId, '/workspace/spawnea/README.md');

    expect(artifact).toBeNull();
    expect(await repos.artifacts.findBySessionId(sessionId)).toHaveLength(0);
  });

  it('ignores tracked UTF-8 filenames when Git quotes its output', async () => {
    const filename = 'résumé.md';
    mockHost.mockFiles.set(`/workspace/spawnea/${filename}`, {
      content: '# Tracked UTF-8 file',
      mimeType: 'text/markdown',
      size: 20,
    });
    mockHost.customRules.push({
      pattern: 'git ls-files --error-unmatch',
      response: { stdout: '"r\\303\\251sum\\303\\251.md"\n', stderr: '', exitCode: 0 },
    });

    const artifact = await artifactManager.handleDetectedOutput(
      sessionId,
      `/workspace/spawnea/${filename}`
    );

    expect(mockHost.executedCommands.some(({ command }) =>
      command === `git ls-files --error-unmatch -- '${filename}'`
    )).toBe(true);
    expect(artifact).toBeNull();
    expect(await repos.artifacts.findBySessionId(sessionId)).toHaveLength(0);
  });

  it('does not promote a detected file when Git status cannot be determined', async () => {
    mockHost.mockFiles.set('/workspace/spawnea/unknown.md', {
      content: '# Unknown Git status',
      mimeType: 'text/markdown',
      size: 20,
    });
    mockHost.customRules.push({
      pattern: 'git ls-files --error-unmatch',
      response: { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 },
    });

    const artifact = await artifactManager.handleDetectedOutput(
      sessionId,
      '/workspace/spawnea/unknown.md'
    );

    expect(artifact).toBeNull();
    expect(await repos.artifacts.findBySessionId(sessionId)).toHaveLength(0);
  });

  it('rejects artifact path traversal and unsafe filenames', async () => {
    writeFileSync(join(tempDir, 'source.txt'), 'safe');

    await expect(
      artifactManager.uploadArtifactFile(sessionId, join(tempDir, 'source.txt'), 'input', '../escape.txt')
    ).rejects.toThrow();
    await expect(
      artifactManager.uploadArtifactBuffer(sessionId, Buffer.from('safe'), 'nested/escape.txt', 'text/plain')
    ).rejects.toThrow();
    await expect(artifactManager.promoteFile(sessionId, '../../outside.txt')).rejects.toThrow();
    await expect(artifactManager.promoteFile(sessionId, '/workspace/spawnea-extra/outside.txt')).rejects.toThrow();

    expect(await artifactManager.handleDetectedOutput(sessionId, '../../outside.txt')).toBeNull();
    expect(await artifactManager.handleDetectedOutput(sessionId, '/workspace/spawnea-extra/outside.txt')).toBeNull();
  });

  it('reads artifact content and supports deletion', async () => {
    const pngBuffer = Buffer.from('test-image-data');
    const artifact = await artifactManager.uploadArtifactBuffer(
      sessionId,
      pngBuffer,
      'test.png',
      'image/png'
    );

    const contentRes = await artifactManager.getArtifactContent(sessionId, artifact.id);
    expect(contentRes.isBinary).toBe(true);
    expect(contentRes.mimeType).toBe('image/png');

    const deleted = await artifactManager.deleteArtifact(sessionId, artifact.id);
    expect(deleted).toBe(true);

    const check = await repos.artifacts.findById(artifact.id);
    expect(check).toBeNull();
  });

  it('clears all session artifacts without deleting remote files', async () => {
    const first = await artifactManager.createTextArtifact(sessionId, 'first.txt', 'first');
    const second = await artifactManager.createTextArtifact(sessionId, 'second.txt', 'second');

    expect(first.cachedLocalPath).toBeDefined();
    expect(second.cachedLocalPath).toBeDefined();
    expect(existsSync(first.cachedLocalPath!)).toBe(true);
    expect(existsSync(second.cachedLocalPath!)).toBe(true);

    await expect(artifactManager.clearArtifacts(sessionId)).resolves.toBe(2);
    expect(await repos.artifacts.findBySessionId(sessionId)).toHaveLength(0);
    expect(existsSync(first.cachedLocalPath!)).toBe(false);
    expect(existsSync(second.cachedLocalPath!)).toBe(false);
    expect(mockHost.mockFiles.has(first.remotePath)).toBe(true);
    expect(mockHost.mockFiles.has(second.remotePath)).toBe(true);
    expect(mockHost.executedCommands.some(({ command }) => command.includes('rm '))).toBe(false);
  });

  it('enforces artifact ownership for reads and deletes', async () => {
    const otherSession = await repos.sessions.save({
      id: 'sess-art-other',
      name: 'Other Artifact Session',
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Other session',
      worktreePath: '/workspace/spawnea',
      branch: 'main',
      tmuxSessionName: 'spawnea-art-other',
      status: 'working',
    });
    const artifact = await artifactManager.createTextArtifact(sessionId, 'owned.txt', 'owned');

    await expect(artifactManager.getArtifactContent(otherSession.id, artifact.id)).rejects.toThrow(/does not belong/);
    await expect(artifactManager.deleteArtifact(otherSession.id, artifact.id)).resolves.toBe(false);
    expect(await repos.artifacts.findById(artifact.id)).not.toBeNull();
  });

  it('creates text artifacts from snippets with correct mimeType and local cache', async () => {
    const textSnippet = 'const x = 42;\nconsole.log(x);';
    const artifact = await artifactManager.createTextArtifact(
      sessionId,
      'snippet-1.ts',
      textSnippet
    );

    expect(artifact.sessionId).toBe(sessionId);
    expect(artifact.filename).toBe('snippet-1.ts');
    expect(artifact.direction).toBe('output');

    const contentRes = await artifactManager.getArtifactContent(sessionId, artifact.id);
    expect(contentRes.isBinary).toBe(false);
    expect(contentRes.content).toBe(textSnippet);
  });

  it('manages blacklist patterns and prevents blacklisted file promotions', async () => {
    // Default blacklist contains package-lock.json, *.log, etc.
    const isLogBlacklisted = await artifactManager.isPathBlacklisted('server.log');
    expect(isLogBlacklisted).toBe(true);

    const isLockfileBlacklisted = await artifactManager.isPathBlacklisted('package-lock.json');
    expect(isLockfileBlacklisted).toBe(true);

    // Create an artifact that will later be blacklisted
    const art = await artifactManager.createTextArtifact(
      sessionId,
      'temp-data.csv',
      'a,b,c\n1,2,3'
    );
    expect(await repos.artifacts.findById(art.id)).not.toBeNull();

    // Add pattern to blacklist -> should purge matching artifacts
    await artifactManager.addToBlacklist('*.csv');

    expect(await artifactManager.isPathBlacklisted('temp-data.csv')).toBe(true);
    expect(await repos.artifacts.findById(art.id)).toBeNull();

    // Attempting to promote blacklisted file should throw or return null on detection
    await expect(
      artifactManager.promoteFile(sessionId, '/workspace/spawnea/output.csv')
    ).rejects.toThrow();

    const detected = await artifactManager.handleDetectedOutput(
      sessionId,
      '/workspace/spawnea/output.csv'
    );
    expect(detected).toBeNull();

    // Remove from blacklist
    await artifactManager.removeFromBlacklist('*.csv');
    expect(await artifactManager.isPathBlacklisted('temp-data.csv')).toBe(false);
  });
});
