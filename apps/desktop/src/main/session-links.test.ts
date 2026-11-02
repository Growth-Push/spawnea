import { describe, expect, it, vi } from 'vitest';
import { retainSessionLinks } from './session-links.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, createRepositories } from '@spawnea/db';
import { SessionContextStore } from './session-context-store.js';

describe('session link capture', () => {
  it('retains only canonical identity and source, without the surrounding text', async () => {
    const admitLinks = vi.fn(async (_id: string, links: unknown[]) => links);
    const retainLinks = vi.fn();
    const input = 'private prose \u001b[32mhttps://github.com/Example/Repo/issues/12?secret=ignored\u001b[0m and more prose';
    await retainSessionLinks({ github: { admitLinks } } as never, 'session', 'output', input, { syncRetainedLinks: async (id: string, callback: () => Promise<unknown>) => retainLinks(id, await callback()) } as never);
    expect(admitLinks).toHaveBeenCalledWith('session', [expect.objectContaining({ sessionId: 'session', url: 'https://github.com/example/repo/issues/12', kind: 'issue', source: 'output' })]);
    expect(retainLinks).toHaveBeenCalledWith('session', [{ url: 'https://github.com/example/repo/issues/12', kind: 'issue', source: 'output' }]);
    expect(JSON.stringify(admitLinks.mock.calls)).not.toContain('private prose');
    expect(JSON.stringify(admitLinks.mock.calls)).not.toContain('secret');
  });

  it.each(['task', 'prompt', 'output'] as const)('retains a complete repository URL from %s', async (source) => {
    const admitLinks = vi.fn(async (_id: string, links: unknown[]) => links);
    const retainLinks = vi.fn();
    await retainSessionLinks({ github: { admitLinks } } as never, 'session', source, 'See **https://github.com/Example/my_repo?tab=readme**', { syncRetainedLinks: async (id: string, callback: () => Promise<unknown>) => retainLinks(id, await callback()) } as never);
    expect(admitLinks).toHaveBeenCalledWith('session', [expect.objectContaining({ url: 'https://github.com/example/my_repo', kind: 'repository', source })]);
    expect(retainLinks).toHaveBeenCalledWith('session', [{ url: 'https://github.com/example/my_repo', kind: 'repository', source }]);
  });

  it('bounds repeated captured references in both persistence copies while preserving an origin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawnea-link-bound-'));
    const db = createDatabase({ path: ':memory:' });
    db.sqlite.pragma('foreign_keys = OFF');
    try {
      const repos = createRepositories(db.db);
      const context = new SessionContextStore({ storeDir: dir });
      await context.save({ version: 1, sessionId: 's', sessionName: 'S', task: 'Task', originIssueUrl: 'https://github.com/example/repo/issues/1', host: { id: 'h', name: 'Host' }, project: { id: 'p', name: 'Project', path: '/fixture' }, harness: { id: 'a', name: 'Agent', command: 'shell', args: [] }, persistentSession: { type: 'tmux', name: 's' }, reconnectTarget: { type: 'tmux', name: 's', hostId: 'h' }, status: 'idle', createdAt: '2026-01-01', updatedAt: '2026-01-01' });
      await retainSessionLinks(repos, 's', 'task', 'https://github.com/example/repo https://github.com/example/repo/pull/7', context);
      await retainSessionLinks(repos, 's', 'prompt', 'https://github.com/example/repo/issues/2', context);
      for (let batch = 0; batch < 6; batch++) {
        const text = Array.from({ length: 250 }, (_, i) => `https://github.com/example/repo/issues/${batch * 500 + i * 2 + 10} https://github.com/example/repo/issues/${batch * 500 + i * 2 + 11}`).join('\n');
        await retainSessionLinks(repos, 's', 'output', text, context);
      }
      const links = await repos.github!.links('s');
      const saved = (await context.load('s'))!;
      expect(new Set(links.map((link) => link.url)).size).toBe(128);
      expect(links.length).toBeLessThanOrEqual(384);
      expect(saved.retainedLinks).toEqual(links.map(({ url, kind, source }) => ({ url, kind, source })));
      expect(saved.originIssueUrl).toBe('https://github.com/example/repo/issues/1');
      expect(saved.retainedLinks).toEqual(expect.arrayContaining([{ url: 'https://github.com/example/repo', kind: 'repository', source: 'task' }, { url: 'https://github.com/example/repo/pull/7', kind: 'pull', source: 'task' }, { url: 'https://github.com/example/repo/issues/2', kind: 'issue', source: 'prompt' }]));
      await retainSessionLinks(repos, 's', 'prompt', 'https://github.com/example/repo', context);
      expect((await context.load('s'))?.retainedLinks).toEqual(expect.arrayContaining([{ url: 'https://github.com/example/repo', kind: 'repository', source: 'task' }, { url: 'https://github.com/example/repo', kind: 'repository', source: 'prompt' }]));
      const snapshot = (await context.load('s'))!;
      await retainSessionLinks(repos, 's', 'prompt', 'https://github.com/example/repo', context);
      await expect(context.save(snapshot)).resolves.toBeTruthy();
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('retains the final reference from an actual remain-on-exit tmux pane', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawnea-dead-links-'));
    const tmux = (...args: string[]) => execFileSync('tmux', ['-S', join(dir, 'tmux.sock'), ...args], { encoding: 'utf8' });
    try {
      tmux('new-session', '-d', '-x', '80', '-y', '12', '-s', 'fixture', 'sh');
      tmux('set-option', '-t', 'fixture', 'remain-on-exit', 'on');
      tmux('send-keys', '-t', 'fixture', '-l', "printf '%s\\n' 'https://github.com/example/repo/pull/71'; exit");
      tmux('send-keys', '-t', 'fixture', 'Enter');
      await expect.poll(() => tmux('display-message', '-p', '-t', 'fixture', '#{pane_dead}').trim()).toBe('1');
      const text = tmux('capture-pane', '-p', '-J', '-t', 'fixture', '-S', '-250');
      expect(text).toContain('\nhttps://github.com/example/repo/pull/71\n');
      const admitLinks = vi.fn(async (_id: string, links: unknown[]) => links);
      const retainLinks = vi.fn();
      await retainSessionLinks({ github: { admitLinks } } as never, 'session', 'output', text, { syncRetainedLinks: async (id: string, callback: () => Promise<unknown>) => retainLinks(id, await callback()) } as never);
      expect(admitLinks).toHaveBeenCalledWith('session', [expect.objectContaining({ sessionId: 'session', url: 'https://github.com/example/repo/pull/71', kind: 'pull', source: 'output' })]);
      expect(retainLinks).toHaveBeenCalledWith('session', [{ url: 'https://github.com/example/repo/pull/71', kind: 'pull', source: 'output' }]);
    } finally {
      try { tmux('kill-server'); } catch { /* The disposable server may already have exited. */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
