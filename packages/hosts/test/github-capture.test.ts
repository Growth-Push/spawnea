import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findGitHubLinks } from '@spawnea/domain';

describe('real tmux link capture', () => {
  it('joins soft wraps while keeping hard breaks, Unicode and ANSI rendering', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawnea-link-capture-'));
    const socket = join(dir, 'tmux.sock');
    const tmux = (...args: string[]) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' });
    try {
      tmux('new-session', '-d', '-x', '24', '-y', '12', '-s', 'fixture', 'sh');
      tmux('send-keys', '-t', 'fixture', '-l', "printf '\\033[32m界e\\314\\201 https://github.com/example/repo/issues/123\\033[0m\\nhttps://github.com/example/\\nrepo/pull/5\\n'");
      tmux('send-keys', '-t', 'fixture', 'Enter');
      tmux('send-keys', '-t', 'fixture', '-l', "printf '\\n**https://github.com/example/my_repo/pull/7**\\n`https://github.com/example/my_repo/issues/8`\\n'");
      tmux('send-keys', '-t', 'fixture', 'Enter');
      await expect.poll(() => tmux('capture-pane', '-p', '-J', '-t', 'fixture', '-S', '-50')).toContain('界é https://github.com/example/repo/issues/123');
      await expect.poll(() => tmux('capture-pane', '-p', '-J', '-t', 'fixture', '-S', '-50')).toContain('**https://github.com/example/my_repo/pull/7**\n`https://github.com/example/my_repo/issues/8`');
      const text = tmux('capture-pane', '-p', '-J', '-t', 'fixture', '-S', '-50');
      expect(findGitHubLinks(text).map((link) => link.url), JSON.stringify(text)).toContain('https://github.com/example/repo/issues/123');
      expect(findGitHubLinks(text).map((link) => link.url)).not.toContain('https://github.com/example/repo/pull/5');
      expect(findGitHubLinks(text).map((link) => link.url)).toContain('https://github.com/example/my_repo/pull/7');
      expect(findGitHubLinks(text).map((link) => link.url)).toContain('https://github.com/example/my_repo/issues/8');
    } finally {
      try { tmux('kill-server'); } catch { /* The disposable server may already have exited. */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
