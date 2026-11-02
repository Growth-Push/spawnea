import { describe, expect, it, vi } from 'vitest';
import { GitHubProvider } from './github-provider.js';
import { githubRepositoryFromRemote, GitHubIntegration } from './github-integration.js';

const sha = 'a'.repeat(40);
const local = 'b'.repeat(40);

describe('GitHub provider', () => {
  it('combines check runs with the latest commit status', async () => {
    const run = vi.fn(async (args: string[]) => args.at(-1)?.includes('check-runs')
      ? `HTTP/2 200 OK\n\n${JSON.stringify({ total_count: 1, check_runs: [{ app: { id: 1 }, name: 'build', status: 'completed', conclusion: 'success', started_at: '2026-01-02T00:00:00Z' }] })}`
      : `HTTP/2 200 OK\n\n${JSON.stringify([{ context: 'test', state: 'success', created_at: '2026-01-02T00:00:00Z' }, { context: 'test', state: 'failure', created_at: '2026-01-01T00:00:00Z' }])}`);
    const result = await new GitHubProvider(run).ci('example/repo', sha, local, true);
    expect(result.state).toBe('successful');
    expect(result.sha).toBe(sha);
    expect(result.localSha).toBe(local);
    expect(result.dirty).toBe(true);
    expect(result.checks).toHaveLength(2);
    expect(run.mock.calls.every(([args]) => args.includes('github.com'))).toBe(true);
  });

  it('does not report success for incomplete pages or provider failures', async () => {
    const partial = new GitHubProvider(async (args) => args.at(-1)?.includes('check-runs')
      ? `HTTP/2 200 OK\n\n${JSON.stringify({ total_count: 2, check_runs: [] })}` : 'HTTP/2 200 OK\n\n[]');
    expect((await partial.ci('example/repo', sha, sha, false)).state).toBe('unavailable');
    const offline = new GitHubProvider(async () => { throw new Error('offline'); });
    expect((await offline.ci('example/repo', sha, sha, false)).state).toBe('unavailable');
    expect((await offline.issue('https://github.com/example/repo/issues/1')).state).toBe('unavailable');
  });

  it('follows all pages before aggregating statuses', async () => {
    const run = vi.fn(async (args: string[]) => {
      const endpoint = args.at(-1)!;
      if (endpoint.includes('check-runs')) return 'HTTP/2 200 OK\n\n{"total_count":0,"check_runs":[]}';
      if (/[?&]page=1(?:&|$)/.test(endpoint)) return 'HTTP/2 200 OK\nLink: <https://api.github.com/next>; rel="next"\n\n[{"context":"one","state":"success","created_at":"2026-01-01T00:00:00Z"}]';
      return 'HTTP/2 200 OK\n\n[{"context":"two","state":"failure","created_at":"2026-01-01T00:00:00Z"}]';
    });
    const result = await new GitHubProvider(run).ci('example/repo', sha, sha, false);
    expect(result.state).toBe('failed');
    expect(result.checks).toHaveLength(2);
  });

  it('accepts only supported remote identities', () => {
    expect(githubRepositoryFromRemote(['git', 'github.com:Example/Repo.git'].join('@'))).toBe('example/repo');
    expect(githubRepositoryFromRemote('https://github.com/example/repo')).toBe('example/repo');
    expect(githubRepositoryFromRemote('https://github.com.evil/example/repo')).toBeUndefined();
    expect(githubRepositoryFromRemote(['https://token', 'github.com/example/repo'].join('@'))).toBeUndefined();
  });

  it('rejects a changed pushed head after the request', async () => {
    let remoteReads = 0;
    const host = { execute: vi.fn(async (command: string) => {
      let stdout = '';
      if (command.includes('symbolic-ref')) stdout = 'feature';
      else if (command.includes('branch.feature.remote')) stdout = 'origin';
      else if (command.includes('branch.feature.merge')) stdout = 'refs/heads/feature';
      else if (command.includes('get-url')) stdout = ['git', 'github.com:example/repo.git'].join('@');
      else if (command.includes('rev-parse')) stdout = local;
      else if (command.includes('ls-remote')) stdout = `${++remoteReads === 1 ? sha : local}\trefs/heads/feature`;
      return { stdout, stderr: '', exitCode: 0 };
    }) };
    const repo = { sessions: { findById: async () => ({ id: 's', projectId: 'p', serverId: 'h' }) }, github: { settings: async () => ({ ciEnabled: true }) } };
    const sessions = { getHostAdapter: async () => host, resolveSessionWorktreePath: async () => ({ value: '/tmp/fixture', release() {} }) };
    const provider = { ci: vi.fn(async () => ({ state: 'successful', sha, checks: [], fetchedAt: '' })) };
    const integration = new GitHubIntegration(repo as never, sessions as never, provider as never);
    expect((await integration.ci('s')).state).toBe('unavailable');
  });

  it('uses an explicitly selected fork PR without reading an upstream', async () => {
    const pull = { repository: 'example/base', headRepository: 'contributor/fork', headBranch: 'feature', sha };
    const provider = { getRetryAt: () => undefined, pull: vi.fn().mockResolvedValue(pull), ci: vi.fn().mockResolvedValue({ state: 'successful', repository: pull.repository, sha, localSha: local, dirty: true, checks: [], fetchedAt: '' }) };
    const host = { execute: vi.fn(async (command: string) => ({ stdout: command.includes('rev-parse') ? local : ' M file', stderr: '', exitCode: 0 })) };
    const repo = { sessions: { findById: async () => ({ projectId: 'p', serverId: 'h' }) }, github: { settings: async () => ({ ciEnabled: true }) } };
    const sessions = { getHostAdapter: async () => host, resolveSessionWorktreePath: async () => ({ value: '/fixture', release() {} }) };
    const result = await new GitHubIntegration(repo as never, sessions as never, provider).ci('s', 'https://github.com/example/base/pull/4');
    expect(result).toMatchObject({ state: 'successful', repository: 'example/base', sha, localSha: local, dirty: true });
    expect(provider.ci).toHaveBeenCalledWith('example/base', sha, local, true);
    expect(provider.pull).toHaveBeenCalledTimes(2);
    expect(host.execute.mock.calls.every(([command]) => !/symbolic-ref|ls-remote|config/.test(command))).toBe(true);
  });

  it('checks the selected PR even when the local checkout is unreachable and rejects a changed head', async () => {
    const pull = { repository: 'example/base', headRepository: 'contributor/fork', headBranch: 'feature', sha };
    const provider = { getRetryAt: () => undefined, pull: vi.fn().mockResolvedValueOnce(pull).mockResolvedValueOnce({ ...pull, sha: local }), ci: vi.fn().mockResolvedValue({ state: 'successful', repository: pull.repository, sha, checks: [], fetchedAt: '' }) };
    const repo = { sessions: { findById: async () => ({ projectId: 'p', serverId: 'h' }) }, github: { settings: async () => ({ ciEnabled: true }) } };
    const sessions = { getHostAdapter: async () => { throw new Error('offline'); } };
    const result = await new GitHubIntegration(repo as never, sessions as never, provider).ci('s', 'https://github.com/example/base/pull/4');
    expect(provider.ci).toHaveBeenCalledWith('example/base', sha, undefined, undefined);
    expect(result).toMatchObject({ state: 'unavailable', message: 'Pull request head changed during refresh; refresh again.' });
    provider.pull.mockResolvedValue(pull);
    const stable = await new GitHubIntegration(repo as never, sessions as never, provider).ci('s', 'https://github.com/example/base/pull/4');
    expect(stable).toMatchObject({ state: 'successful', sha });
  });

  it('reports and observes the provider rate-limit wait', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      const run = vi.fn(async () => { throw Object.assign(new Error('limited'), { stderr: 'HTTP 429 rate limit; Retry-After: 120' }); });
      const provider = new GitHubProvider(run);
      const first = await provider.ci('example/repo', sha, sha, false);
      expect(first.state).toBe('unavailable');
      expect(first.retryAt).toBe('2026-01-01T00:02:00.000Z');
      const calls = run.mock.calls.length;
      await provider.ci('example/repo', sha, sha, false);
      expect(run).toHaveBeenCalledTimes(calls);
      vi.advanceTimersByTime(120_001);
    } finally { vi.useRealTimers(); }
  });
});
