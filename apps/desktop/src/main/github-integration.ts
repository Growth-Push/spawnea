import type { Repositories } from '@spawnea/db';
import type { CiProvider, GitHubCiResult, HostAdapter, Session } from '@spawnea/domain';
import type { SessionManager } from './session-manager.js';
import { GitHubProvider } from './github-provider.js';

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

export function githubRepositoryFromRemote(url: string): string | undefined {
  const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([a-z0-9-]+)\/([a-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : undefined;
}

async function git(host: HostAdapter, cwd: string, args: string[]): Promise<string> {
  const result = await host.execute(`git ${args.map(quote).join(' ')}`, { cwd, timeoutMs: 30000, maxOutputBytes: 65536 });
  if (result.exitCode !== 0 || result.truncated) throw new Error('Git target unavailable');
  return result.stdout.trim();
}

export class GitHubIntegration {
  constructor(private readonly repos: Repositories, private readonly sessions: SessionManager, private readonly testProvider?: CiProvider) {}

  private async localState(session: Session): Promise<{ sha: string; dirty: boolean } | undefined> {
    try {
      const host = await this.sessions.getHostAdapter(session.serverId);
      const lease = await this.sessions.resolveSessionWorktreePath(session);
      try {
        const sha = await git(host, lease.value, ['rev-parse', 'HEAD']);
        if (!/^[0-9a-f]{40}$/i.test(sha)) return undefined;
        return { sha, dirty: Boolean(await git(host, lease.value, ['status', '--porcelain'])) };
      } finally { lease.release(); }
    } catch { return undefined; }
  }

  async ci(sessionId: string, pullUrl?: string, signal?: AbortSignal): Promise<GitHubCiResult> {
    const provider = this.testProvider ?? new GitHubProvider(undefined, signal);
    const unavailable = (message: string): GitHubCiResult => ({ state: 'unavailable', checks: [], fetchedAt: new Date().toISOString(), message, retryAt: provider.getRetryAt?.() });
    try {
      const session = await this.repos.sessions.findById(sessionId);
      if (!session || !(await this.repos.github?.settings(session.projectId))?.ciEnabled) return unavailable('GitHub CI is disabled for this project.');
      if (pullUrl) {
        const pull = await provider.pull(pullUrl);
        if (!pull) return unavailable('Selected pull request is unavailable or invalid.');
        if (signal?.aborted) return unavailable('Refresh cancelled.');
        const local = await this.localState(session);
        const result = await provider.ci(pull.repository, pull.sha, local?.sha, local?.dirty);
        if (signal?.aborted) return unavailable('Refresh cancelled.');
        const current = await provider.pull(pullUrl);
        if (!current || current.sha !== pull.sha || current.headRepository !== pull.headRepository || current.headBranch !== pull.headBranch || current.repository !== pull.repository) return unavailable('Pull request head changed during refresh; refresh again.');
        if (local) {
          const latestLocal = await this.localState(session);
          if (!latestLocal || latestLocal.sha !== local.sha || latestLocal.dirty !== local.dirty) return unavailable('Local checkout changed during refresh; refresh again.');
        }
        return result;
      }
      const host = await this.sessions.getHostAdapter(session.serverId);
      const lease = await this.sessions.resolveSessionWorktreePath(session);
      try {
        const cwd = lease.value;
        const branch = await git(host, cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
        const remote = await git(host, cwd, ['config', '--get', `branch.${branch}.remote`]);
        const merge = await git(host, cwd, ['config', '--get', `branch.${branch}.merge`]);
        if (!remote || remote === '.' || !merge.startsWith('refs/heads/')) throw new Error();
        const repository = githubRepositoryFromRemote(await git(host, cwd, ['remote', 'get-url', '--', remote]));
        if (!repository) return unavailable('The branch upstream is not a github.com repository.');
        const localSha = await git(host, cwd, ['rev-parse', 'HEAD']);
        const dirty = Boolean(await git(host, cwd, ['status', '--porcelain']));
        const readPushed = async () => {
          const value = await git(host, cwd, ['ls-remote', '--heads', '--', remote, merge]);
          const [sha, ref] = value.split(/\s+/);
          if (!/^[0-9a-f]{40}$/i.test(sha) || ref !== merge) throw new Error();
          return sha;
        };
        const pushed = await readPushed();
        if (signal?.aborted) return unavailable('Refresh cancelled.');
        const result = await provider.ci(repository, pushed, localSha, dirty);
        if (signal?.aborted) return unavailable('Refresh cancelled.');
        if (await readPushed() !== pushed || await git(host, cwd, ['rev-parse', 'HEAD']) !== localSha || Boolean(await git(host, cwd, ['status', '--porcelain'])) !== dirty || await git(host, cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']) !== branch || await git(host, cwd, ['config', '--get', `branch.${branch}.remote`]) !== remote || await git(host, cwd, ['config', '--get', `branch.${branch}.merge`]) !== merge || githubRepositoryFromRemote(await git(host, cwd, ['remote', 'get-url', '--', remote])) !== repository) return unavailable('Branch changed during refresh; refresh again.');
        return result;
      } finally { lease.release(); }
    } catch { return unavailable('Published branch is unavailable. Configure a GitHub upstream and refresh.'); }
  }
}
