import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionContextStore } from './session-context-store.js';
import type { SessionContextFile } from '@spawnea/domain';
import { validateSessionContext } from '@spawnea/domain';

describe('SessionContextStore', () => {
  let tempDir: string;
  let store: SessionContextStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'spawnea-test-sessions-'));
    store = new SessionContextStore({ storeDir: tempDir });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const sampleContext: SessionContextFile = {
    version: 1,
    sessionId: 'sess-abc-123',
    sessionName: 'Test Task',
    task: 'Test Task',
    host: {
      id: 'dev-workstation',
      name: 'Development Workstation',
      ssh: { target: 'example-host', user: 'developer', port: 22 },
    },
    project: {
      id: 'spawnea',
      name: 'Spawnea',
      path: '/workspace/spawnea',
    },
    harness: {
      id: 'claude',
      name: 'Claude Code',
      command: 'claude',
      args: [],
    },
    persistentSession: {
      type: 'tmux',
      name: 'spawnea-task',
    },
    reconnectTarget: {
      type: 'tmux',
      name: 'spawnea-task',
      hostId: 'dev-workstation',
    },
    status: 'working',
    creationSource: 'control',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it('saves and loads a session context file', async () => {
    const filePath = await store.save(sampleContext);
    expect(existsSync(filePath)).toBe(true);

    const loaded = await store.load('sess-abc-123');
    expect(loaded).not.toBeNull();
    expect(loaded?.sessionId).toBe('sess-abc-123');
    expect(loaded?.task).toBe('Test Task');
    expect(loaded?.creationSource).toBe('control');
  });

  it('lists all saved session context files', async () => {
    await store.save(sampleContext);
    await store.save({
      ...sampleContext,
      sessionId: 'sess-def-456',
      task: 'Another Task',
    });

    const list = await store.list();
    expect(list.length).toBe(2);
    expect(list.some((s) => s.sessionId === 'sess-abc-123')).toBe(true);
    expect(list.some((s) => s.sessionId === 'sess-def-456')).toBe(true);
  });

  it('updates the status of an existing session context file', async () => {
    await store.save(sampleContext);
    const updated = await store.updateStatus('sess-abc-123', 'disconnected');
    expect(updated).toBe(true);

    const loaded = await store.load('sess-abc-123');
    expect(loaded?.status).toBe('disconnected');
  });

  it('deletes a session context file', async () => {
    await store.save(sampleContext);
    const deleted = await store.delete('sess-abc-123');
    expect(deleted).toBe(true);

    const loaded = await store.load('sess-abc-123');
    expect(loaded).toBeNull();
  });

  it('serializes link, status, name and layout changes without losing fields', async () => {
    await store.save(sampleContext);
    const link = { url: 'https://github.com/example/repo/issues/1', kind: 'issue' as const, source: 'output' as const };
    await Promise.all([
      store.retainLinks(sampleContext.sessionId, [link]),
      store.updateStatus(sampleContext.sessionId, 'idle'),
      store.updateSessionName(sampleContext.sessionId, 'Renamed'),
      store.update(sampleContext.sessionId, (current) => ({ ...current, agentSessionId: 'fixture-layout' })),
    ]);
    expect(await store.load(sampleContext.sessionId)).toMatchObject({ status: 'idle', sessionName: 'Renamed', agentSessionId: 'fixture-layout', retainedLinks: [link] });
  });

  it('preserves repository references alongside older issue references and rejects repositories as origins', async () => {
    const issue = { url: 'https://github.com/example/repo/issues/1', kind: 'issue' as const, source: 'task' as const };
    const repo = { url: 'https://github.com/example/repo', kind: 'repository' as const, source: 'output' as const };
    await store.save({ ...sampleContext, retainedLinks: [issue] });
    await store.retainLinks(sampleContext.sessionId, [repo]);
    expect((await store.load(sampleContext.sessionId))?.retainedLinks).toEqual([issue, repo]);
    expect(validateSessionContext({ ...sampleContext, originIssueUrl: repo.url }).success).toBe(false);
  });

  it('rejects a stale snapshot after a link update or deletion and never recreates the file', async () => {
    await store.save(sampleContext);
    const stale = (await store.load(sampleContext.sessionId))!;
    const link = { url: 'https://github.com/example/repo/issues/1', kind: 'issue' as const, source: 'output' as const };
    await store.retainLinks(sampleContext.sessionId, [link]);
    await expect(store.save({ ...stale, sessionName: 'Old snapshot' })).rejects.toThrow('changed since it was read');
    const pending = store.retainLinks(sampleContext.sessionId, [link]);
    const deleted = store.delete(sampleContext.sessionId);
    await Promise.all([pending, deleted]);
    await expect(store.save(stale)).rejects.toThrow('changed since it was read');
    expect(await store.load(sampleContext.sessionId)).toBeNull();
  });

  it('restores the state at deletion, including updates queued after the rollback snapshot', async () => {
    await store.save(sampleContext);
    const previous = (await store.load(sampleContext.sessionId))!;
    const link = { url: 'https://github.com/example/repo/pull/5', kind: 'pull' as const, source: 'prompt' as const };
    await Promise.all([store.retainLinks(sampleContext.sessionId, [link]), store.delete(sampleContext.sessionId, { captureForRollback: true })]);
    await store.restoreDeleted(previous);
    expect((await store.load(sampleContext.sessionId))?.retainedLinks).toEqual([link]);
  });

  it('normalizes legacy metadata while preserving the rest of the context and avoids duplicate writes', async () => {
    const links = Array.from({ length: 300 }, (_, i) => ({ url: `https://github.com/example/repo/issues/${i + 1}`, kind: 'issue', source: 'output' }));
    writeFileSync(join(tempDir, `${sampleContext.sessionId}.json`), JSON.stringify({ ...sampleContext, retainedLinks: [...links, { url: 'invalid', kind: 'issue', source: 'output' }, { url: 'https://github.com/example/repo', kind: 'repository', source: { toString: null, valueOf: null } }] }));
    const loaded = (await store.load(sampleContext.sessionId))!;
    expect(loaded.task).toBe(sampleContext.task);
    expect(loaded.retainedLinks).toHaveLength(128);
    expect((await store.list())[0].retainedLinks).toHaveLength(128);
    await store.updateStatus(sampleContext.sessionId, 'idle');
    const before = readFileSync(join(tempDir, `${sampleContext.sessionId}.json`), 'utf8');
    const snapshot = (await store.load(sampleContext.sessionId))!;
    await store.retainLinks(sampleContext.sessionId, [snapshot.retainedLinks![0]]);
    expect(readFileSync(join(tempDir, `${sampleContext.sessionId}.json`), 'utf8')).toBe(before);
    await expect(store.save(snapshot)).resolves.toBeTruthy();
  });

  it('preserves oversized context files and refuses oversized new writes', async () => {
    const path = join(tempDir, `${sampleContext.sessionId}.json`);
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 1, 97);
    writeFileSync(path, bytes);
    const error = vi.fn();
    const guarded = new SessionContextStore({ storeDir: tempDir, logger: { info: vi.fn(), debug: vi.fn(), error } as never });
    expect(await guarded.load(sampleContext.sessionId)).toBeNull();
    expect(await guarded.list()).toEqual([]);
    expect(await guarded.delete(sampleContext.sessionId, { captureForRollback: true })).toBe(false);
    await expect(guarded.save(sampleContext)).rejects.toThrow('8 MiB');
    await expect(guarded.restoreDeleted(sampleContext)).rejects.toThrow('8 MiB');
    expect(readFileSync(path).equals(bytes)).toBe(true);
    expect(error.mock.calls.some((call) => call.some((arg: unknown) => arg instanceof Error && arg.message.includes('8 MiB')))).toBe(true);
    await expect(guarded.save({ ...sampleContext, sessionId: 'new', task: 'x'.repeat(8 * 1024 * 1024) })).rejects.toThrow('8 MiB');
    expect(existsSync(join(tempDir, 'new.json'))).toBe(false);
  });

  it('serializes admission with deletion and never recreates a deleted context', async () => {
    await store.save(sampleContext);
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const link = { url: 'https://github.com/example/repo', kind: 'repository' as const, source: 'prompt' as const };
    const sync = store.syncRetainedLinks(sampleContext.sessionId, async () => { started(); await wait; return [link]; });
    await entered;
    const deletion = store.delete(sampleContext.sessionId, { captureForRollback: true });
    release();
    await Promise.all([sync, deletion]);
    await store.syncRetainedLinks(sampleContext.sessionId, async () => [link]);
    expect(await store.load(sampleContext.sessionId)).toBeNull();
    await store.restoreDeleted(sampleContext);
    expect((await store.load(sampleContext.sessionId))?.retainedLinks).toEqual([link]);
  });

  it('keeps unrelated updates queued while admission is in flight', async () => {
    await store.save(sampleContext);
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const link = { url: 'https://github.com/example/repo/pull/5', kind: 'pull' as const, source: 'output' as const };
    const sync = store.syncRetainedLinks(sampleContext.sessionId, async () => { started(); await wait; return [link]; });
    await entered;
    const update = store.updateSessionName(sampleContext.sessionId, 'Renamed');
    release();
    await Promise.all([sync, update]);
    expect(await store.load(sampleContext.sessionId)).toMatchObject({ sessionName: 'Renamed', retainedLinks: [link] });
  });
});
