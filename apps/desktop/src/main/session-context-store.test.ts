import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionContextStore } from './session-context-store.js';
import type { SessionContextFile } from '@spawnea/domain';

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
    creationSource: 'mcp',
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
    expect(loaded?.creationSource).toBe('mcp');
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
});
