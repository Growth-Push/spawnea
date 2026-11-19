import { describe, expect, it, vi } from 'vitest';
import { createDatabase, createRepositories, GitHubLinkRecoveryRequiredError } from '@spawnea/db';
import { parseGitHubLink, type Session } from '@spawnea/domain';
import { GitHubLinkStatusProvider, readGitHubLinkStatus, SessionGitHubStatusRequests } from './github-link-status';

const pull = parseGitHubLink('https://github.com/example/upstream/pull/4')!;
const origin = 'https://github.com/example/upstream/issues/7';
const issue = parseGitHubLink(origin)!;
const sha = 'a'.repeat(40);
const nextSha = 'b'.repeat(40);

function response(item: object, kind = 'pullRequest', headers = 'Content-Type: application/json\r\n') {
  return {
    stdout: `HTTP/2.0 200 OK\n${headers}\r\n${JSON.stringify({ data: { repository: { [kind]: item } } })}`,
    stderr: '',
  };
}

function pr(state: string, oid: string, nodes: object[], headRefOid = oid, hasNextPage = false) {
  return response({
    state, isDraft: state === 'OPEN', headRefOid,
    commits: { nodes: [{ commit: { oid, statusCheckRollup: { contexts: { nodes, pageInfo: { hasNextPage } } } } }] },
  });
}

const check = (conclusion: string) => ({ __typename: 'CheckRun', status: 'COMPLETED', conclusion });
const status = (state: string) => ({ __typename: 'StatusContext', state });

describe('GitHub link provider', () => {
  it.each(['OPEN', 'CLOSED'])('reads issue %s independently of CI', async (state) => {
    const run = vi.fn().mockResolvedValue(response({ state }, 'issue'));
    expect((await readGitHubLinkStatus(issue, run)).value).toEqual({ state: state.toLowerCase() });
    expect(run.mock.calls[0][0]).toContain('number=7');
  });

  it('asks the PR repository for its head rollup and keeps merged and failed independent', async () => {
    const run = vi.fn().mockResolvedValue(pr('MERGED', sha, [check('FAILURE'), status('PENDING')]));
    expect((await readGitHubLinkStatus(pull, run)).value).toEqual({ state: 'merged', ci: 'failed' });
    const [args] = run.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining(['owner=example', 'name=upstream', 'number=4']));
    expect(args.find((arg: string) => arg.startsWith('query='))).toContain('commits(last:1)');
  });

  it.each([
    [[], 'none'],
    [[check('SUCCESS')], 'passed'],
    [[check('SUCCESS'), check('CANCELLED')], 'cancelled'],
    [[check('SUCCESS'), check('SKIPPED'), check('NEUTRAL')], 'skipped'],
    [[check('SUCCESS'), status('EXPECTED')], 'pending'],
  ])('aggregates contexts %j as %s', async (checks, ci) => {
    const run = vi.fn().mockResolvedValue(pr('OPEN', sha, checks));
    expect((await readGitHubLinkStatus(pull, run)).value).toEqual({ state: 'draft', ci });
  });

  it('discards CI when head identity changes or the result is truncated', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(pr('CLOSED', sha, [check('SUCCESS')], nextSha))
      .mockResolvedValueOnce(pr('CLOSED', sha, [check('SUCCESS')], sha, true));
    for (let i = 0; i < 2; i++) {
      expect((await readGitHubLinkStatus(pull, run)).value).toEqual({ state: 'closed', ci: 'unavailable' });
    }
  });

  it('replaces the old CI result when a fresh head is observed', async () => {
    let now = 100_000;
    const run = vi.fn()
      .mockResolvedValueOnce(pr('OPEN', sha, [check('SUCCESS')]))
      .mockResolvedValueOnce(pr('OPEN', nextSha, [status('PENDING')]));
    const provider = new GitHubLinkStatusProvider(run, () => now);
    expect((await provider.refresh([pull.url]))[pull.url].ci).toBe('passed');
    now += 60_000;
    expect((await provider.refresh([pull.url]))[pull.url]).toEqual({ state: 'draft', ci: 'pending', freshness: 'fresh', expiresAt: now + 60_000 });
  });

  it('preserves known PR state when only the checks field is inaccessible', async () => {
    const partial = pr('MERGED', sha, []);
    const run = vi.fn().mockRejectedValue({
      ...partial, stdout: partial.stdout.replace('{"data":', '{"errors":[{"message":"Resource not accessible"}],"data":'),
    });
    expect((await readGitHubLinkStatus(pull, run)).value).toEqual({ state: 'merged', ci: 'unavailable' });
  });

  it('retains stale data on failure and observes a provider-wide retry delay', async () => {
    let now = 100_000;
    const run = vi.fn()
      .mockResolvedValueOnce(response({ state: 'OPEN' }, 'issue'))
      .mockRejectedValueOnce({ stdout: 'HTTP/2.0 429 Too Many Requests\r\nRetry-After: 120\r\n\r\n{}', stderr: '' });
    const provider = new GitHubLinkStatusProvider(run, () => now);
    expect((await provider.refresh([origin]))[origin]).toEqual({ state: 'open', freshness: 'fresh', expiresAt: now + 60_000 });
    now += 60_000;
    expect((await provider.refresh([origin, pull.url]))[origin]).toEqual({ state: 'open', freshness: 'stale' });
    now += 119_000;
    expect((await provider.refresh([pull.url]))[pull.url]).toEqual({ freshness: 'unavailable' });
    expect(run).toHaveBeenCalledTimes(2);
    now += 1_000;
    await provider.refresh([pull.url]);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('keeps the successful result that exhausts the budget and pauses the batch until reset', async () => {
    let now = 100_000;
    const headers = 'X-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 230\r\n';
    const run = vi.fn().mockResolvedValueOnce(response({ state: 'CLOSED' }, 'issue', headers))
      .mockResolvedValueOnce(pr('MERGED', sha, [check('SUCCESS')]));
    const provider = new GitHubLinkStatusProvider(run, () => now);
    const first = await provider.refresh([origin, pull.url]);
    expect(first[origin]).toEqual({ state: 'closed', freshness: 'fresh', expiresAt: 160_000 });
    expect(run).toHaveBeenCalledTimes(1);

    now = 229_999;
    expect((await provider.refresh([origin, pull.url]))[origin]).toEqual({ state: 'closed', freshness: 'stale' });
    expect(run).toHaveBeenCalledTimes(1);
    now = 230_000;
    expect((await provider.refresh([pull.url]))[pull.url]?.ci).toBe('passed');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('bounds a refresh batch and serves unqueried links on the next pass', async () => {
    let now = 100_000;
    const run = vi.fn().mockResolvedValue(response({ state: 'OPEN' }, 'issue'));
    const provider = new GitHubLinkStatusProvider(run, () => now);
    const links = Array.from({ length: 5 }, (_, i) => origin.replace('/7', `/${i + 1}`));
    const first = provider.refresh(links);
    await provider.refresh(links);
    const initial = await first;
    expect(run).toHaveBeenCalledTimes(4);
    expect(initial[links[4]]).toEqual({ freshness: 'unavailable' });
    now += 10_000;
    expect((await provider.refresh(links))[links[4]].freshness).toBe('fresh');
    expect(run).toHaveBeenCalledTimes(5);
  });
});


describe('session GitHub status requests', () => {
  it.each([110_000, 230_000])('stops the old batch and respects the next permitted lookup at %i', async (nextLookupAt) => {
    const db = createDatabase();
    const repos = createRepositories(db.db);
    const betaOrigin = 'https://github.com/example/beta/issues/8';
    vi.spyOn(repos.sessions, 'findById').mockImplementation(async (id) => ({
      id, originIssueUrl: id === 'alpha' ? origin : betaOrigin,
    }) as Session);
    vi.spyOn(repos.github!, 'links').mockImplementation(async (id) => id === 'alpha' ? [
      { sessionId: id, url: pull.url, kind: 'pull', source: 'task', createdAt: new Date(0) },
    ] : []);

    let now = 100_000;
    let completeAlpha!: (value: ReturnType<typeof response>) => void;
    const run = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { completeAlpha = resolve; }))
      .mockResolvedValueOnce(response({ state: 'OPEN' }, 'issue'));
    const requests = new SessionGitHubStatusRequests(repos, new GitHubLinkStatusProvider(run, () => now));
    try {
      const old = requests.refresh('alpha', 1);
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

      requests.cancel('alpha', 1);
      const headers = nextLookupAt === 230_000 ? 'X-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 230\r\n' : undefined;
      completeAlpha(response({ state: 'CLOSED' }, 'issue', headers));
      expect(await old).toEqual({});
      expect(run).toHaveBeenCalledTimes(1);

      now = nextLookupAt - 1;
      expect(await requests.refresh('beta', 3)).toEqual({ [betaOrigin]: { freshness: 'unavailable' } });
      expect(run).toHaveBeenCalledTimes(1);
      now = nextLookupAt;
      const current = requests.refresh('beta', 4);
      requests.cancel('beta', 3);
      requests.cancel('alpha', 4);
      expect(await current).toEqual({ [betaOrigin]: { state: 'open', freshness: 'fresh', expiresAt: nextLookupAt + 60_000 } });
      expect(run.mock.calls.map(([args]) => args.filter((arg: string) => arg.startsWith('number=')))).toEqual([
        ['number=7'], ['number=8'],
      ]);
    } finally {
      db.close();
    }
  });

  it('refreshes only the independent origin when the actual retained-link recovery check refuses oversize data', async () => {
    const db = createDatabase();
    db.sqlite.pragma('foreign_keys = OFF');
    try {
      const repos = createRepositories(db.db);
      vi.spyOn(repos.sessions, 'findById').mockResolvedValue({ id: 'legacy', originIssueUrl: origin } as Session);
      const insert = db.sqlite.prepare('INSERT INTO session_links VALUES (?, ?, ?, ?, ?)');
      db.sqlite.transaction(() => {
        for (let i = 1; i <= 4097; i++) {
          insert.run('legacy', `https://github.com/example/legacy/issues/${i}`, 'issue', 'output', i);
        }
      })();

      const run = vi.fn().mockResolvedValue(response({ state: 'OPEN' }, 'issue'));
      const requests = new SessionGitHubStatusRequests(repos, new GitHubLinkStatusProvider(run, () => 100_000));
      expect(await requests.refresh('legacy', 1)).toEqual({ [origin]: { state: 'open', freshness: 'fresh', expiresAt: 160_000 } });
      expect(run).toHaveBeenCalledExactlyOnceWith(expect.arrayContaining(['name=upstream', 'number=7']));
      await expect(repos.github!.links('legacy')).rejects.toThrow(GitHubLinkRecoveryRequiredError);
      expect(db.sqlite.prepare('SELECT count(*) AS count FROM session_links').get()).toEqual({ count: 4097 });
    } finally {
      db.close();
    }
  });
});
