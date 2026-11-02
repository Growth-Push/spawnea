import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { aggregateCi, parseGitHubLink, type CiProvider, type TrackerProvider, type PullHead, type GitHubCheck, type GitHubCiResult, type GitHubIssueMetadata } from '@spawnea/domain';

const execFileAsync = promisify(execFile);
type Runner = (args: string[]) => Promise<string>;
let githubRetryAt = 0;

/** Read-only provider. gh always runs locally and uses its existing authentication. */
export class GitHubProvider implements TrackerProvider, CiProvider {
  getRetryAt(): string | undefined {
    return githubRetryAt > Date.now() ? new Date(githubRetryAt).toISOString() : undefined;
  }
  constructor(private readonly run: Runner = async (args) => {
    const result = await execFileAsync('gh', args, {
      timeout: 30000, maxBuffer: 8 * 1024 * 1024,
      signal,
      env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' },
    });
    return result.stdout;
  }, signal?: AbortSignal) {}

  private async api(path: string): Promise<any> {
    if (Date.now() < githubRetryAt) throw new Error('Rate limited');
    try {
      const pages: unknown[] = [];
      for (let page = 1; page <= 100; page += 1) {
        const endpoint = `${path}${path.includes('?') ? '&' : '?'}page=${page}`;
        const response = await this.run(['api', '--hostname', 'github.com', '--include', endpoint]);
        const separator = /\r?\n\r?\n/.exec(response);
        if (!separator || !response.startsWith('HTTP/')) throw new Error('Missing provider response headers');
        const headers = response.slice(0, separator.index);
        pages.push(JSON.parse(response.slice(separator.index + separator[0].length)));
        if (!/^link:.*rel="next"/im.test(headers)) return pages;
      }
      throw new Error('Provider response exceeded pagination limit');
    } catch (error) {
      const response = typeof error === 'object' && error ? `${'stderr' in error ? String(error.stderr) : ''}\n${'stdout' in error ? String(error.stdout) : ''}` : '';
      if (/rate limit|HTTP\/[\d.]+ 429/i.test(response)) {
        const retry = /retry-after:\s*(\d+)/i.exec(response);
        const reset = /x-ratelimit-reset:\s*(\d+)/i.exec(response);
        githubRetryAt = Math.max(Date.now() + (retry ? Number(retry[1]) * 1000 : 60000), reset ? Number(reset[1]) * 1000 : 0);
      }
      throw error;
    }
  }

  async issue(url: string): Promise<GitHubIssueMetadata> {
    const fetchedAt = new Date().toISOString();
    const link = parseGitHubLink(url);
    if (!link || link.kind !== 'issue') return { state: 'unavailable', fetchedAt };
    try {
      const pages = await this.api(`repos/${link.owner}/${link.repository}/issues/${link.number}`);
      const item = pages[0];
      if (item?.pull_request || typeof item?.title !== 'string' || !['open', 'closed'].includes(item.state)) throw new Error();
      return { state: item.state, title: item.title, fetchedAt };
    } catch {
      return { state: 'unavailable', fetchedAt };
    }
  }

  async pull(url: string): Promise<PullHead | undefined> {
    const link = parseGitHubLink(url);
    if (!link || link.kind !== 'pull') return undefined;
    try {
      const pages = await this.api(`repos/${link.owner}/${link.repository}/pulls/${link.number}`);
      const pr = pages[0];
      if (typeof pr?.head?.repo?.full_name !== 'string' || !/^[a-z0-9-]+\/[a-z0-9_.-]+$/i.test(pr.head.repo.full_name) || typeof pr.head.ref !== 'string' || !pr.head.ref || typeof pr.head.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(pr.head.sha)) return undefined;
      return { repository: `${link.owner}/${link.repository}`, headRepository: pr.head.repo.full_name.toLowerCase(), headBranch: pr.head.ref, sha: pr.head.sha };
    } catch { return undefined; }
  }

  async ci(repository: string, sha: string, localSha?: string, dirty?: boolean): Promise<GitHubCiResult> {
    const fetchedAt = new Date().toISOString();
    const unavailable = (message: string): GitHubCiResult => ({ state: 'unavailable', repository, sha, localSha, dirty, fetchedAt, checks: [], message, retryAt: githubRetryAt > Date.now() ? new Date(githubRetryAt).toISOString() : undefined });
    if (!/^[a-z0-9-]+\/[a-z0-9_.-]+$/i.test(repository) || !/^[0-9a-f]{40}$/i.test(sha) || (localSha !== undefined && !/^[0-9a-f]{40}$/i.test(localSha))) return unavailable('Invalid repository or commit');
    try {
      const [checkPages, statusPages] = await Promise.all([
        this.api(`repos/${repository}/commits/${sha}/check-runs?per_page=100&filter=latest`),
        this.api(`repos/${repository}/commits/${sha}/statuses?per_page=100`),
      ]);
      if (!Array.isArray(checkPages) || !Array.isArray(statusPages)) throw new Error();
      const checks: GitHubCheck[] = [];
      const expected = checkPages[0]?.total_count;
      if (!Number.isInteger(expected) || checkPages.reduce((count: number, page: any) => count + (Array.isArray(page.check_runs) ? page.check_runs.length : 0), 0) < expected) throw new Error();
      for (const page of checkPages) {
        if (!Array.isArray(page.check_runs)) throw new Error();
        for (const check of page.check_runs) {
          const states: Record<string, GitHubCheck['state']> = { queued: 'queued', in_progress: 'running', waiting: 'queued', pending: 'queued', requested: 'queued', success: 'successful', failure: 'failed', timed_out: 'failed', action_required: 'failed', cancelled: 'cancelled', skipped: 'skipped', neutral: 'skipped', stale: 'skipped', startup_failure: 'failed' };
          const state = states[check.status === 'completed' ? check.conclusion : check.status];
          const observedAt = check.started_at ?? check.created_at ?? (Number.isSafeInteger(check.id) && check.id > 0 ? new Date(check.id).toISOString() : undefined);
          if (!state || typeof check.name !== 'string' || !check.app?.id || !observedAt) throw new Error();
          checks.push({ key: `check:${check.app.id}:${check.name}:${check.check_suite?.id ?? 'unknown'}`, name: check.name, state, observedAt, url: check.html_url ?? undefined });
        }
      }
      for (const page of statusPages) {
        if (!Array.isArray(page)) throw new Error();
        for (const status of page) {
          const states: Record<string, GitHubCheck['state']> = { pending: 'queued', success: 'successful', failure: 'failed', error: 'failed' };
          if (!states[status.state] || typeof status.context !== 'string' || !status.created_at) throw new Error();
          checks.push({ key: `status:${status.context}`, name: status.context, state: states[status.state], observedAt: status.created_at, url: status.target_url ?? undefined });
        }
      }
      const state = aggregateCi(checks, true);
      const latest = new Map<string, GitHubCheck>();
      for (const check of checks) {
        const current = latest.get(check.key);
        if (!current || Date.parse(check.observedAt) > Date.parse(current.observedAt)) latest.set(check.key, check);
      }
      return { state, repository, sha, localSha, dirty, fetchedAt, checks: [...latest.values()] };
    } catch {
      return unavailable('GitHub checks are unavailable; authentication, network or rate limits may prevent refresh.');
    }
  }
}
