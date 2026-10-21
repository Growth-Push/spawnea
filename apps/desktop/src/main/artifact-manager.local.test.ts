import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createDatabase, createRepositories, type Repositories } from '@spawnea/db';
import { LocalHostAdapter } from '@spawnea/hosts';
import { CatalogManager } from './catalog-manager.js';
import { SessionContextStore } from './session-context-store.js';
import { PtyBroker } from './pty-broker.js';
import { SessionManager } from './session-manager.js';
import { ArtifactManager } from './artifact-manager.js';

// Exercises detection against the real filesystem through the local host adapter.
describe('ArtifactManager with a local host', () => {
  const originalHome = process.env['HOME'];
  let root: string;
  let project: string;
  let home: string;
  let outside: string;
  let dbConn: ReturnType<typeof createDatabase>;
  let repos: Repositories;
  let sessionManager: SessionManager;
  let artifactManager: ArtifactManager;
  let sessionId: string;

  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'spawnea-local-art-')));
    project = join(root, 'project');
    home = join(root, 'home');
    outside = join(root, 'outside');
    for (const dir of [project, join(home, '.config', 'demo'), outside]) mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: project });
    process.env['HOME'] = home;

    dbConn = createDatabase({ path: ':memory:', migrate: true });
    repos = createRepositories(dbConn.db);
    await repos.servers.save({ id: 'local', name: 'Local', host: 'localhost', sshPort: 22, enabled: true });
    await repos.projects.save({ id: 'local:p', serverId: 'local', name: 'P', rootPath: project });
    await repos.agents.save({ id: 'local:claude', name: 'Claude', harness: 'claude', command: 'claude' });
    const session = await repos.sessions.save({
      id: 'sess-local',
      name: 'Local',
      serverId: 'local',
      projectId: 'local:p',
      agentId: 'local:claude',
      task: 'artifacts',
      worktreePath: project,
      branch: 'main',
      tmuxSessionName: 'spawnea-local-art',
      status: 'working',
    });
    sessionId = session.id;
    const host = new LocalHostAdapter({ serverId: 'local' });
    sessionManager = new SessionManager({
      repositories: repos,
      catalogManager: new CatalogManager(),
      contextStore: new SessionContextStore({ storeDir: join(root, 'sessions') }),
      ptyBroker: new PtyBroker(),
      hostAdapterFactory: async () => host,
    });
    artifactManager = new ArtifactManager({
      repositories: repos,
      sessionManager,
      cacheDir: join(root, 'cache'),
    });
  });

  afterEach(async () => {
    process.env['HOME'] = originalHome;
    await sessionManager.dispose();
    dbConn.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('lists, previews and opens external and project files in place without caching', async () => {
    writeFileSync(join(outside, 'shot.jpg'), jpg);
    writeFileSync(join(home, '.config', 'demo', 'settings.yaml'), 'key: value\n');
    writeFileSync(join(outside, 'report.pdf'), '%PDF-1.4\n%%EOF\n');
    writeFileSync(join(project, 'notes.md'), '# Notes\n');

    const created = await artifactManager.processOutputChunk(sessionId, [
      `Saved ${join(outside, 'shot.jpg')}`,
      'Wrote ~/.config/demo/settings.yaml',
      `Report: ${join(outside, 'report.pdf')}`,
      `Created ${join(project, 'notes.md')}`,
    ]);

    expect(created.map((a) => a.remotePath).sort()).toEqual([
      join(home, '.config', 'demo', 'settings.yaml'),
      join(outside, 'report.pdf'),
      join(outside, 'shot.jpg'),
      join(project, 'notes.md'),
    ].sort());
    for (const artifact of created) {
      expect(artifact.cachedLocalPath).toBeUndefined();
      const preview = await artifactManager.getArtifactContent(sessionId, artifact.id);
      expect(preview.sizeBytes).toBe(artifact.sizeBytes);
      const target = await artifactManager.resolveArtifactOpenTarget(sessionId, artifact.id);
      expect(target).toEqual({ path: artifact.remotePath, temporaryCopy: false });
    }
    expect(existsSync(join(root, 'cache'))).toBe(false);
  });

  it('does not create previews for unsupported, missing, unreadable, or escaping paths', async () => {
    writeFileSync(join(outside, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(outside, 'tool.sh'), 'echo hi\n');
    // Permission bits do not stop root, so fall back to content that fails validation.
    const isRoot = process.getuid?.() === 0;
    writeFileSync(join(outside, 'private.json'), isRoot ? Buffer.from([0x7b, 0x00, 0x7d]) : '{}');
    if (!isRoot) chmodSync(join(outside, 'private.json'), 0o000);
    writeFileSync(join(outside, 'bin.json'), Buffer.from([0x7b, 0x00, 0x7d]));
    writeFileSync(join(outside, 'secret.txt'), 'top secret');
    symlinkSync(join(outside, 'icon.svg'), join(outside, 'link.png'));

    const created = await artifactManager.processOutputChunk(sessionId, [
      `a ${join(outside, 'icon.svg')}`,
      `b ${join(outside, 'tool.sh')}`,
      `c ${join(outside, 'private.json')}`,
      `d ${join(outside, 'bin.json')}`,
      `e ${join(outside, 'missing.png')}`,
      `f ${join(outside, 'link.png')}`,
      'g ../secret.txt',
      'h ./../outside/secret.txt',
    ]);

    expect(created).toEqual([]);
    expect(await repos.artifacts.findBySessionId(sessionId)).toHaveLength(0);
  });

  it('resolves explicit local references without reading content or registering artifacts', async () => {
    const host = await sessionManager.getHostAdapter('local');
    const read = vi.spyOn(host, 'readFileRaw');
    expect(await artifactManager.getLocalReferenceContext(sessionId)).toEqual({ workspacePath: project, homePath: home, persistedWorkspacePath: project });
    expect(await artifactManager.getLocalReferencePaths(sessionId, '~/notes with spaces.md')).toEqual({ fullPath: join(home, 'notes with spaces.md'), relativePath: relative(project, join(home, 'notes with spaces.md')) });
    expect(await artifactManager.getLocalReferencePaths(sessionId, 'notes.md')).toEqual({ fullPath: join(project, 'notes.md'), relativePath: 'notes.md' });
    expect(read).not.toHaveBeenCalled();
    expect(await repos.artifacts.findBySessionId(sessionId)).toEqual([]);
  });

  it('previews tracked files and absolute or home external references without registering them', async () => {
    writeFileSync(join(project, 'tracked.md'), '# Tracked\n');
    execFileSync('git', ['add', 'tracked.md'], { cwd: project });
    writeFileSync(join(home, 'notes with spaces.md'), '# Home\n');
    writeFileSync(join(outside, 'notes.txt'), 'External\n');
    expect((await artifactManager.getLocalReferenceContent(sessionId, './tracked.md')).content).toBe('# Tracked\n');
    expect((await artifactManager.getLocalReferenceContent(sessionId, '~/notes with spaces.md')).content).toBe('# Home\n');
    expect((await artifactManager.getLocalReferenceContent(sessionId, join(outside, 'notes.txt'))).content).toBe('External\n');
    const open = vi.fn().mockResolvedValue(undefined);
    await artifactManager.withLocalReference(sessionId, 'tracked.md', open);
    expect(open).toHaveBeenCalledWith(join(project, 'tracked.md'), 'text/markdown', true);
    expect(await repos.artifacts.findBySessionId(sessionId)).toEqual([]);
    expect(existsSync(join(root, 'cache'))).toBe(false);
  });

  it('allows external references through symlinked home and parents only when their real destinations are permitted', async () => {
    writeFileSync(join(home, 'notes.txt'), 'Home reference');
    writeFileSync(join(outside, 'notes.txt'), 'External reference');
    writeFileSync(join(outside, 'page.html'), '<h1>Excluded HTML</h1>');
    symlinkSync(home, join(root, 'home-link'), 'dir');
    symlinkSync(outside, join(root, 'outside-link'), 'dir');
    symlinkSync(join(outside, 'page.html'), join(outside, 'disguised.txt'));
    process.env['HOME'] = join(root, 'home-link');
    expect((await artifactManager.getLocalReferenceContent(sessionId, '~/notes.txt')).content).toBe('Home reference');
    expect((await artifactManager.getLocalReferenceContent(sessionId, join(root, 'outside-link', 'notes.txt'))).content).toBe('External reference');
    await expect(artifactManager.getLocalReferenceContent(sessionId, join(root, 'outside-link', 'disguised.txt'))).rejects.toThrow();
    await expect(artifactManager.getLocalReferenceContent(sessionId, '../outside-link/notes.txt')).rejects.toThrow();
    expect(await repos.artifacts.findBySessionId(sessionId)).toEqual([]);
  });

  it.each(['page.html', 'page.htm'])('recognizes workspace HTML browser targets: %s', async (filename) => {
    writeFileSync(join(project, filename), '<h1>Internal HTML</h1>');
    const open = vi.fn().mockResolvedValue(undefined);
    await artifactManager.withLocalReference(sessionId, filename, open);
    expect(open).toHaveBeenCalledWith(join(project, filename), 'text/html', true);
  });

  it('validates missing, inaccessible, excluded and symlink targets at action time', async () => {
    writeFileSync(join(outside, 'notes.txt'), 'External');
    writeFileSync(join(outside, 'page.html'), '<html>External</html>');
    writeFileSync(join(outside, 'binary.json'), Buffer.from([0, 1]));
    writeFileSync(join(project, 'page.html'), '<html>Internal</html>');
    writeFileSync(join(project, 'private.txt'), 'Unreadable');
    chmodSync(join(project, 'private.txt'), 0o000);
    symlinkSync(join(outside, 'page.html'), join(project, 'link.html'));
    symlinkSync(join(outside, 'notes.txt'), join(project, 'link.txt'));
    const open = vi.fn().mockResolvedValue(undefined);
    await artifactManager.withLocalReference(sessionId, 'page.html', open);
    expect(open).toHaveBeenCalledWith(join(project, 'page.html'), 'text/html', true);
    for (const path of ['missing.md', '../outside/notes.txt', join(outside, 'page.html'), 'link.html', 'link.txt', join(outside, 'binary.json')]) {
      await expect(artifactManager.getLocalReferenceContent(sessionId, path)).rejects.toThrow();
    }
    if (process.getuid?.() !== 0) await expect(artifactManager.getLocalReferenceContent(sessionId, 'private.txt')).rejects.toThrow();
    expect(await repos.artifacts.findBySessionId(sessionId)).toEqual([]);
  });
});
