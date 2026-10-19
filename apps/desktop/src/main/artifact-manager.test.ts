import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, createRepositories, type Repositories } from '@spawnea/db';
import { MockHostAdapter } from '@spawnea/hosts';
import { CatalogManager } from './catalog-manager.js';
import { SessionContextStore } from './session-context-store.js';
import { PtyBroker } from './pty-broker.js';
import { SessionManager } from './session-manager.js';
import { ArtifactManager } from './artifact-manager.js';

const DEMO_HOME = ['', 'home', 'demo'].join('/');

describe('ArtifactManager', () => {
  let tempDir: string;
  let repos: Repositories;
  let dbConn: ReturnType<typeof createDatabase>;
  let sessionManager: SessionManager;
  let artifactManager: ArtifactManager;
  let mockHost: MockHostAdapter;
  let sessionId: string;
  let symlinks: Map<string, string>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'spawnea-test-art-'));
    symlinks = new Map();
    dbConn = createDatabase({ path: ':memory:', migrate: true });
    repos = createRepositories(dbConn.db);
    mockHost = new MockHostAdapter('dev-workstation', [
      '/workspace/spawnea',
      '/workspace/spawnea/docs',
    ]);

    mockHost.customRules.push(
      {
        pattern: /^realpath -- /,
        response: (command) => {
          const requested = command.replace(/^realpath -- '/, '').replace(/'$/, '');
          const target = symlinks.get(requested) ?? requested;
          return { stdout: `${target}\n`, stderr: '', exitCode: 0 };
        },
      },
      { pattern: 'printf %s "$HOME"', response: { stdout: DEMO_HOME, stderr: '', exitCode: 0 } }
    );

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
      command === `git ls-files --error-unmatch -- ':(literal)${filename}'`
    )).toBe(true);
    expect(artifact).toBeNull();
    expect(await repos.artifacts.findBySessionId(sessionId)).toHaveLength(0);
  });

  it('uses literal Git pathspecs for detected filenames containing wildcards', async () => {
    mockHost.mockFiles.set('/workspace/spawnea/report*.txt', {
      content: 'literal filename',
      mimeType: 'text/plain',
      size: 16,
    });
    mockHost.customRules.push({
      pattern: 'git ls-files --error-unmatch',
      response: { stdout: '', stderr: 'pathspec did not match any files', exitCode: 1 },
    });

    const artifact = await artifactManager.handleDetectedOutput(
      sessionId,
      '/workspace/spawnea/report*.txt'
    );

    expect(mockHost.executedCommands.some(({ command }) =>
      command === "git ls-files --error-unmatch -- ':(literal)report*.txt'"
    )).toBe(true);
    expect(artifact?.filename).toBe('report*.txt');
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

  it('reads and migrates a complete legacy cached artifact while the host is unavailable', async () => {
    const artifact = await artifactManager.createTextArtifact(sessionId, 'legacy.txt', 'legacy content');
    const legacyPath = join(artifactManager.getSessionCacheDir(sessionId), artifact.filename);
    renameSync(artifact.cachedLocalPath!, legacyPath);
    await repos.artifacts.save({ ...artifact, cachedLocalPath: legacyPath });
    mockHost.mockFiles.delete(artifact.remotePath);

    const result = await artifactManager.getArtifactContentForExport(sessionId, artifact.id);

    expect(result.content).toBe('legacy content');
    expect(result.isTruncated).toBe(false);
    expect(existsSync(legacyPath)).toBe(false);
    expect(result.cachedLocalPath).toBeDefined();
    expect(result.cachedLocalPath).not.toBe(legacyPath);
    expect(existsSync(result.cachedLocalPath!)).toBe(true);
    expect((await repos.artifacts.findById(artifact.id))?.cachedLocalPath).toBe(result.cachedLocalPath);
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

  it('serializes artifact creation with clearing', async () => {
    const artifact = await artifactManager.createTextArtifact(sessionId, 'during-clear.txt', 'content');
    const originalFind = repos.artifacts.findBySessionId.bind(repos.artifacts);
    let releaseSnapshot!: () => void;
    const snapshotPaused = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    vi.spyOn(repos.artifacts, 'findBySessionId').mockImplementation(async (id) => {
      const result = await originalFind(id);
      if (id === sessionId) {
        await snapshotPaused;
      }
      return result;
    });

    const clearing = artifactManager.clearArtifacts(sessionId);
    await new Promise((resolve) => setImmediate(resolve));
    const creating = artifactManager.createTextArtifact(sessionId, 'after-clear.txt', 'content');
    releaseSnapshot();

    await expect(clearing).resolves.toBe(1);
    await expect(creating).resolves.toMatchObject({ filename: 'after-clear.txt' });
    expect(await repos.artifacts.findBySessionId(sessionId)).toHaveLength(1);
    expect(await repos.artifacts.findById(artifact.id)).toBeNull();
  });

  it('serializes cache-filling reads with clearing', async () => {
    const artifact = await artifactManager.createTextArtifact(sessionId, 'read-through.txt', 'content');
    expect(artifact.cachedLocalPath).toBeDefined();
    rmSync(artifact.cachedLocalPath!, { force: true });

    let releaseRead!: () => void;
    const readPaused = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const originalReadFile = mockHost.readFile.bind(mockHost);
    vi.spyOn(mockHost, 'readFile').mockImplementation(async (...args) => {
      await readPaused;
      return originalReadFile(...args);
    });

    const reading = artifactManager.getArtifactContent(sessionId, artifact.id);
    await new Promise((resolve) => setImmediate(resolve));
    const clearing = artifactManager.clearArtifacts(sessionId);
    releaseRead();

    await expect(reading).resolves.toMatchObject({ content: 'content' });
    await expect(clearing).resolves.toBe(1);
    expect(existsSync(artifact.cachedLocalPath!)).toBe(false);
    expect(await repos.artifacts.findById(artifact.id)).toBeNull();
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

  it('enforces injectable file and total cache limits before writing', async () => {
    const limited = new ArtifactManager({
      repositories: repos,
      sessionManager,
      cacheDir: join(tempDir, 'limited-artifacts'),
      maxFileBytes: 4,
      maxCacheBytes: 6,
      maxPreviewBytes: 3,
    });

    await expect(
      limited.uploadArtifactBuffer(sessionId, Buffer.from('12345'), 'too-large.txt', 'text/plain')
    ).rejects.toThrow(/per-file limit/);

    await limited.uploadArtifactBuffer(sessionId, Buffer.from('1234'), 'first.txt', 'text/plain');
    await expect(
      limited.uploadArtifactBuffer(sessionId, Buffer.from('1234'), 'second.txt', 'text/plain')
    ).rejects.toThrow(/cache limit/);

    const localSource = join(tempDir, 'quota-source.txt');
    writeFileSync(localSource, '1234');
    await expect(limited.uploadArtifactFile(sessionId, localSource, 'input')).rejects.toThrow(/cache limit/);
  });

  it('registers promoted and detected project files as pointers without copying content', async () => {
    mockHost.mockFiles.set('/workspace/spawnea/docs/oversized.txt', {
      content: '12345',
      mimeType: 'text/plain',
      size: 5,
    });
    mockHost.customRules.push({
      pattern: 'git ls-files --error-unmatch',
      response: { stdout: '', stderr: 'pathspec did not match', exitCode: 1 },
    });

    const promoted = await artifactManager.promoteFile(sessionId, 'docs/oversized.txt');
    expect(promoted).toMatchObject({ filename: 'oversized.txt', sizeBytes: 5 });
    expect(promoted.cachedLocalPath).toBeUndefined();
    expect(existsSync(join(tempDir, 'artifacts'))).toBe(false);
  });

  it('reads pointer artifacts from the original on each preview and never caches', async () => {
    mockHost.mockFiles.set('/workspace/spawnea/docs/report.txt', {
      content: 'docs-version',
      mimeType: 'text/plain',
      size: 12,
    });
    const artifact = await artifactManager.promoteFile(sessionId, 'docs/report.txt');
    expect((await artifactManager.getArtifactContent(sessionId, artifact.id)).content).toBe('docs-version');

    mockHost.mockFiles.set('/workspace/spawnea/docs/report.txt', {
      content: 'edited',
      mimeType: 'text/plain',
      size: 6,
    });
    expect((await artifactManager.getArtifactContent(sessionId, artifact.id)).content).toBe('edited');
    expect(existsSync(join(tempDir, 'artifacts'))).toBe(false);

    mockHost.mockFiles.delete('/workspace/spawnea/docs/report.txt');
    await expect(artifactManager.getArtifactContent(sessionId, artifact.id)).rejects.toThrow(/no longer available/);
  });

  it('reports preview truncation for a pointer artifact', async () => {
    mockHost.mockFiles.set('/workspace/spawnea/docs/large.txt', {
      content: '0123456789',
      mimeType: 'text/plain',
      size: 10,
    });
    const artifact = await artifactManager.promoteFile(sessionId, 'docs/large.txt');
    const result = await artifactManager.getArtifactContent(sessionId, artifact.id, 3);
    expect(result.content).toBe('012');
    expect(result.isTruncated).toBe(true);
    expect(existsSync(join(tempDir, 'artifacts'))).toBe(false);
  });

  describe('files outside the project', () => {
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
    const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n');

    const setBinary = (path: string, bytes: Buffer, mimeType: string) =>
      mockHost.mockFiles.set(path, {
        content: bytes.toString('base64'),
        mimeType,
        // The mock host measures the stored (base64) text.
        size: bytes.toString('base64').length,
        isBinary: true,
      });

    it('registers readable supported files as pointers to the original', async () => {
      setBinary('/tmp/demo/shot.jpg', jpg, 'image/jpeg');
      mockHost.mockFiles.set(`${DEMO_HOME}/.config/demo/settings.yaml`, {
        content: 'key: value\n',
        mimeType: 'text/yaml',
        size: 11,
      });
      setBinary('/var/reports/summary.pdf', pdf, 'application/pdf');

      const results = await artifactManager.processOutputChunk(sessionId, [
        'Saved /tmp/demo/shot.jpg',
        'Wrote ~/.config/demo/settings.yaml',
        'Report at /var/reports/summary.pdf',
      ]);

      expect(results.map((a) => a.remotePath).sort()).toEqual([
        `${DEMO_HOME}/.config/demo/settings.yaml`,
        '/tmp/demo/shot.jpg',
        '/var/reports/summary.pdf',
      ]);
      expect(results.every((a) => a.cachedLocalPath === undefined && a.direction === 'output')).toBe(true);
      expect(existsSync(join(tempDir, 'artifacts'))).toBe(false);

      const preview = await artifactManager.getArtifactContent(sessionId, results.find((a) => a.filename === 'shot.jpg')!.id);
      expect(preview.isBinary).toBe(true);
      expect(await artifactManager.processOutputChunk(sessionId, ['Saved /tmp/demo/shot.jpg'])).toEqual([]);
    });

    it('rejects unsupported types, missing, unreadable, mismatching, and escaping files', async () => {
      mockHost.mockFiles.set('/tmp/demo/icon.svg', { content: '<svg/>', mimeType: 'image/svg+xml', size: 6 });
      mockHost.mockFiles.set('/tmp/demo/run.sh', { content: 'echo hi', mimeType: 'text/plain', size: 7 });
      mockHost.mockFiles.set('/tmp/demo/fake.png', { content: 'not an image', mimeType: 'image/png', size: 12 });
      mockHost.mockFiles.set('/tmp/demo/binary.txt', { content: 'a\u0000b', mimeType: 'text/plain', size: 3 });
      mockHost.mockFiles.set('/tmp/demo/secret.json', { content: '{}', mimeType: 'application/json', size: 2 });
      mockHost.mockFiles.set('/tmp/demo/.cache/x.json', { content: '{}', mimeType: 'application/json', size: 2 });
      mockHost.directories.add('/tmp/demo/dir.json');
      const originalReadRaw = mockHost.readFileRaw.bind(mockHost);
      vi.spyOn(mockHost, 'readFileRaw').mockImplementation(async (path, max) => {
        if (path === '/tmp/demo/secret.json') throw new Error('EACCES: permission denied');
        return originalReadRaw(path, max);
      });

      for (const path of [
        '/tmp/demo/icon.svg',
        '/tmp/demo/run.sh',
        '/tmp/demo/fake.png',
        '/tmp/demo/binary.txt',
        '/tmp/demo/secret.json',
        '/tmp/demo/missing.png',
        '/tmp/demo/.cache/x.json',
        '/tmp/demo/dir.json',
        '../outside.png',
      ]) {
        expect(await artifactManager.handleDetectedOutput(sessionId, path)).toBeNull();
      }
      expect(await repos.artifacts.findBySessionId(sessionId)).toHaveLength(0);
    });

    it('applies the same rules to the real target of a symlink', async () => {
      mockHost.mockFiles.set('/tmp/demo/target.svg', { content: '<svg/>', mimeType: 'image/svg+xml', size: 6 });
      mockHost.mockFiles.set('/tmp/demo/real.txt', { content: 'hello', mimeType: 'text/plain', size: 5 });
      symlinks.set('/tmp/demo/link.png', '/tmp/demo/target.svg');
      symlinks.set('/tmp/demo/link.txt', '/tmp/demo/real.txt');

      expect(await artifactManager.handleDetectedOutput(sessionId, '/tmp/demo/link.png')).toBeNull();
      const viaLink = await artifactManager.handleDetectedOutput(sessionId, '/tmp/demo/link.txt');
      expect(viaLink?.remotePath).toBe('/tmp/demo/real.txt');
    });

    it('treats a link that resolves into the project as a project file', async () => {
      mockHost.mockFiles.set('/workspace/spawnea/docs/real.md', { content: '# Doc', mimeType: 'text/markdown', size: 5 });
      symlinks.set('/tmp/demo/to-project.md', '/workspace/spawnea/docs/real.md');
      mockHost.customRules.push({
        pattern: 'git ls-files --error-unmatch',
        response: { stdout: '', stderr: 'did not match', exitCode: 1 },
      });

      const artifact = await artifactManager.handleDetectedOutput(sessionId, '/tmp/demo/to-project.md');
      expect(artifact?.remotePath).toBe('/workspace/spawnea/docs/real.md');
    });

    it('marks an external artifact unavailable once it is deleted or replaced by a link', async () => {
      mockHost.mockFiles.set('/tmp/demo/note.txt', { content: 'hello', mimeType: 'text/plain', size: 5 });
      const artifact = await artifactManager.handleDetectedOutput(sessionId, '/tmp/demo/note.txt');
      expect(artifact).not.toBeNull();
      expect((await artifactManager.getArtifactContent(sessionId, artifact!.id)).content).toBe('hello');

      symlinks.set('/tmp/demo/note.txt', '/etc/other.txt');
      await expect(artifactManager.getArtifactContent(sessionId, artifact!.id)).rejects.toThrow(/no longer available/);
      symlinks.clear();
      mockHost.mockFiles.delete('/tmp/demo/note.txt');
      await expect(artifactManager.getArtifactContent(sessionId, artifact!.id)).rejects.toThrow(/no longer available/);
    });

    it('applies the external rules when a registered project file becomes a link to outside', async () => {
      mockHost.mockFiles.set('/workspace/spawnea/docs/pic.png', { content: 'x', mimeType: 'text/plain', size: 1 });
      mockHost.mockFiles.set('/tmp/demo/fake.png', { content: 'not an image', mimeType: 'image/png', size: 12 });
      mockHost.mockFiles.set('/tmp/demo/good.txt', { content: 'fine', mimeType: 'text/plain', size: 4 });
      mockHost.mockFiles.set('/tmp/demo/icon.svg', { content: '<svg/>', mimeType: 'image/svg+xml', size: 6 });
      const artifact = await artifactManager.promoteFile(sessionId, 'docs/pic.png');

      for (const target of ['/tmp/demo/fake.png', '/tmp/demo/icon.svg', '/tmp/demo/missing.png']) {
        symlinks.set('/workspace/spawnea/docs/pic.png', target);
        await expect(artifactManager.getArtifactContent(sessionId, artifact.id)).rejects.toThrow(/no longer available/);
        await expect(artifactManager.getArtifactContentForExport(sessionId, artifact.id)).rejects.toThrow(/no longer available/);
        await expect(artifactManager.resolveArtifactOpenTarget(sessionId, artifact.id)).rejects.toThrow(/no longer available/);
      }

      symlinks.set('/workspace/spawnea/docs/pic.png', '/tmp/demo/good.txt');
      expect((await artifactManager.getArtifactContent(sessionId, artifact.id)).content).toBe('fine');
      symlinks.set('/workspace/spawnea/docs/pic.png', '/workspace/spawnea/docs/other.png');
      mockHost.mockFiles.set('/workspace/spawnea/docs/other.png', { content: 'inside', mimeType: 'text/plain', size: 6 });
      expect((await artifactManager.getArtifactContent(sessionId, artifact.id)).content).toBe('x');
    });

    it('opens a temporary copy at a stable per-artifact path and cleans it up', async () => {
      mockHost.mockFiles.set('/tmp/demo/note.txt', { content: 'hello', mimeType: 'text/plain', size: 5 });
      const artifact = await artifactManager.handleDetectedOutput(sessionId, '/tmp/demo/note.txt');
      const copiesDir = join(tempDir, 'artifact-open-copies');

      const download = vi.spyOn(mockHost, 'downloadFile').mockImplementation(async (_remote, local) => {
        writeFileSync(local, 'hello');
      });
      const first = await artifactManager.resolveArtifactOpenTarget(sessionId, artifact!.id);
      const second = await artifactManager.resolveArtifactOpenTarget(sessionId, artifact!.id);
      expect(first).toEqual({ path: join(copiesDir, artifact!.id, 'note.txt'), temporaryCopy: true });
      expect(second.path).toBe(first.path);
      expect(readdirSync(copiesDir)).toEqual([artifact!.id]);

      await artifactManager.discardTemporaryCopy(first.path);
      expect(existsSync(first.path)).toBe(false);

      download.mockImplementation(async (_remote, local) => {
        writeFileSync(local, 'partial');
        throw new Error('connection lost');
      });
      await expect(artifactManager.resolveArtifactOpenTarget(sessionId, artifact!.id)).rejects.toThrow('connection lost');
      expect(existsSync(join(copiesDir, artifact!.id))).toBe(false);

      download.mockImplementation(async (_remote, local) => writeFileSync(local, 'hello'));
      await artifactManager.resolveArtifactOpenTarget(sessionId, artifact!.id);
      await artifactManager.removeTemporaryCopies();
      expect(existsSync(copiesDir)).toBe(false);
    });
  });

  it('returns PDF previews as data URIs, for project files too', async () => {
    const bytes = Buffer.from('%PDF-1.7\n');
    mockHost.mockFiles.set('/workspace/spawnea/docs/spec.pdf', {
      content: bytes.toString('base64'),
      mimeType: 'application/pdf',
      size: bytes.toString('base64').length,
      isBinary: true,
    });
    const artifact = await artifactManager.promoteFile(sessionId, 'docs/spec.pdf');

    const preview = await artifactManager.getArtifactContent(sessionId, artifact.id);
    expect(preview.content).toBe(`data:application/pdf;base64,${bytes.toString('base64')}`);
  });

  it('queries the host home once and skips registered paths before resolving them', async () => {
    mockHost.mockFiles.set('/tmp/demo/note.txt', { content: 'hello', mimeType: 'text/plain', size: 5 });
    const commands = () => mockHost.executedCommands.map((c) => c.command);
    const lines = ['Saved /tmp/demo/note.txt'];

    expect(await artifactManager.processOutputChunk(sessionId, lines)).toHaveLength(1);
    const afterFirst = commands().length;
    expect(await artifactManager.processOutputChunk(sessionId, lines)).toEqual([]);
    expect(await artifactManager.processOutputChunk(sessionId, lines)).toEqual([]);

    expect(commands().filter((c) => c === 'printf %s "$HOME"')).toHaveLength(1);
    expect(commands().slice(afterFirst)).toEqual([]);
  });

  it('removes only the cache of detected artifacts left by earlier versions', async () => {
    const upload = await artifactManager.createTextArtifact(sessionId, 'snippet.txt', 'kept', 'output');
    const legacyPath = join(artifactManager.getSessionCacheDir(sessionId), 'legacy', 'old.md');
    mkdirSync(join(legacyPath, '..'), { recursive: true });
    writeFileSync(legacyPath, 'old');
    await repos.artifacts.save({
      id: 'art-legacy',
      sessionId,
      direction: 'output',
      remotePath: '/workspace/spawnea/old.md',
      cachedLocalPath: legacyPath,
      filename: 'old.md',
      mimeType: 'text/markdown',
      sizeBytes: 3,
      createdAt: new Date(),
    });

    expect(await artifactManager.removeDetectedArtifactCaches()).toBe(1);

    expect(existsSync(legacyPath)).toBe(false);
    expect((await repos.artifacts.findById('art-legacy'))?.cachedLocalPath).toBeUndefined();
    expect(existsSync((await repos.artifacts.findById(upload.id))!.cachedLocalPath!)).toBe(true);
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

  it('processes output chunks, filters non-existent or git-tracked files, and registers artifacts', async () => {
    // 1. Prepare files on mockHost
    mockHost.mockFiles.set('/workspace/spawnea/generated-report.md', {
      content: '# Generated Report',
      mimeType: 'text/markdown',
      size: 18,
    });
    // Tracked git file should be ignored
    mockHost.mockFiles.set('/workspace/spawnea/tracked-code.ts', {
      content: 'export const a = 1;',
      mimeType: 'text/typescript',
      size: 19,
    });
    mockHost.customRules.push({
      pattern: 'git ls-files --error-unmatch -- \':(literal)tracked-code.ts\'',
      response: { stdout: 'tracked-code.ts\n', stderr: '', exitCode: 0 },
    });
    mockHost.customRules.push({
      pattern: 'git ls-files --error-unmatch -- \':(literal)generated-report.md\'',
      response: { stdout: '', stderr: 'did not match', exitCode: 1 },
    });

    const terminalChunk = [
      'Some agent output...',
      '● [Pasted text #1: 28 lines → /workspace/spawnea/generated-report.md',
      'Created file /workspace/spawnea/tracked-code.ts',
      'Also mentioned /workspace/spawnea/does-not-exist.txt',
      'Done!',
    ];

    const results = await artifactManager.processOutputChunk(sessionId, terminalChunk, 'hermes');

    expect(results).toHaveLength(1);
    expect(results[0].filename).toBe('generated-report.md');
    expect(results[0].remotePath).toBe('/workspace/spawnea/generated-report.md');

    // Calling again with the same chunk should deduplicate and return empty
    const duplicateResults = await artifactManager.processOutputChunk(sessionId, terminalChunk, 'hermes');
    expect(duplicateResults).toHaveLength(0);
  });
});
