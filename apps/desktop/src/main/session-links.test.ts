import { describe, expect, it, vi } from 'vitest';
import { retainSessionLinks } from './session-links.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('session link capture', () => {
  it('retains only canonical identity and source, without the surrounding text', async () => {
    const addLink = vi.fn();
    const retainLinks = vi.fn();
    const input = 'private prose \u001b[32mhttps://github.com/Example/Repo/issues/12?secret=ignored\u001b[0m and more prose';
    await retainSessionLinks({ github: { addLink } } as never, 'session', 'output', input, { retainLinks } as never);
    expect(addLink).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session', url: 'https://github.com/example/repo/issues/12', kind: 'issue', source: 'output' }));
    expect(retainLinks).toHaveBeenCalledWith('session', [{ url: 'https://github.com/example/repo/issues/12', kind: 'issue', source: 'output' }]);
    expect(JSON.stringify(addLink.mock.calls)).not.toContain('private prose');
    expect(JSON.stringify(addLink.mock.calls)).not.toContain('secret');
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
      const addLink = vi.fn();
      const retainLinks = vi.fn();
      await retainSessionLinks({ github: { addLink } } as never, 'session', 'output', text, { retainLinks } as never);
      expect(addLink).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session', url: 'https://github.com/example/repo/pull/71', kind: 'pull', source: 'output' }));
      expect(retainLinks).toHaveBeenCalledWith('session', [{ url: 'https://github.com/example/repo/pull/71', kind: 'pull', source: 'output' }]);
    } finally {
      try { tmux('kill-server'); } catch { /* The disposable server may already have exited. */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
