import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { GitHubLinkRecoveryRequiredError, type Repositories } from '@spawnea/db';
import { parseGitHubLink, type GitHubLink, type GitHubCiState, type GitHubLinkStatus, type GitHubLinkStatuses } from '@spawnea/domain';
import { z } from 'zod';

type StatusValue = Pick<GitHubLinkStatus, 'state' | 'ci'>;
type ReadResult = { value?: StatusValue; retryAfterMs?: number };
type Command = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

const exec = promisify(execFile);
const runGh: Command = (args) => exec('gh', args, {
  cwd: homedir(),
  env: {
    ...process.env,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_DEBUG: '',
    GH_TELEMETRY: 'false',
    CLICOLOR_FORCE: '0',
    GH_FORCE_TTY: '',
    NO_COLOR: '1',
  },
  encoding: 'utf8',
  timeout: 5_000,
  maxBuffer: 128 * 1024,
  windowsHide: true,
});

const variables = '($owner:String!,$name:String!,$number:Int!)';
const repository = 'repository(owner:$owner,name:$name)';
const issueQuery = `query${variables}{${repository}{issue(number:$number){state}}}`;
const pullQuery = `query${variables}{${repository}{pullRequest(number:$number){
  state isDraft headRefOid
  commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){
    pageInfo{hasNextPage}
    nodes{__typename ... on CheckRun{status conclusion} ... on StatusContext{state}}
  }}}}}
}}}`;

const envelopeSchema = z.object({
  data: z.object({ repository: z.object({ issue: z.unknown().optional(), pullRequest: z.unknown().optional() }).nullish() }).nullish(),
  errors: z.array(z.object({ message: z.string(), type: z.string().optional() })).optional(),
});
const issueSchema = z.object({ state: z.enum(['OPEN', 'CLOSED']) });
const pullSchema = z.object({
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  headRefOid: z.string().regex(/^[a-f0-9]{40}$/i),
  commits: z.unknown().optional(),
});
const commitsSchema = z.object({
  nodes: z.tuple([z.object({
    commit: z.object({
      oid: z.string(),
      statusCheckRollup: z.object({
        contexts: z.object({
          pageInfo: z.object({ hasNextPage: z.boolean() }),
          nodes: z.array(z.object({
            __typename: z.string(),
            status: z.string().optional(),
            conclusion: z.string().nullish(),
            state: z.string().optional(),
          })),
        }),
      }).nullable(),
    }),
  })]),
});

const conclusions: Readonly<Record<string, GitHubCiState>> = {
  FAILURE: 'failed', TIMED_OUT: 'failed', ACTION_REQUIRED: 'failed', STARTUP_FAILURE: 'failed',
  STALE: 'failed', ERROR: 'failed', SUCCESS: 'passed', CANCELLED: 'cancelled',
  SKIPPED: 'skipped', NEUTRAL: 'skipped', PENDING: 'pending', EXPECTED: 'pending',
};
const running = new Set(['QUEUED', 'IN_PROGRESS', 'REQUESTED', 'WAITING', 'PENDING']);
const precedence: GitHubCiState[] = ['failed', 'unavailable', 'pending', 'cancelled', 'skipped', 'passed'];

function pullCi(payload: unknown, head: string): GitHubCiState {
  const parsed = commitsSchema.safeParse(payload);
  if (!parsed.success) return 'unavailable';
  const { oid, statusCheckRollup } = parsed.data.nodes[0].commit;
  if (oid !== head || statusCheckRollup?.contexts.pageInfo.hasNextPage) return 'unavailable';
  const states = new Set(statusCheckRollup?.contexts.nodes.map((check): GitHubCiState => {
    if (check.__typename === 'CheckRun' && check.status && running.has(check.status)) return 'pending';
    const outcome = check.__typename === 'StatusContext' ? check.state
      : check.__typename === 'CheckRun' && check.status === 'COMPLETED' ? check.conclusion : undefined;
    return outcome && Object.hasOwn(conclusions, outcome) ? conclusions[outcome] : 'unavailable';
  }));
  return precedence.find((state) => states.has(state)) ?? 'none';
}

const retryMs = 60_000;

export async function readGitHubLinkStatus(link: GitHubLink, run = runGh, now = Date.now): Promise<ReadResult> {
  if (link.kind === 'repository' || Number(link.number) > 2_147_483_647) return {};
  let stdout = '';
  let stderr = '';
  try {
    ({ stdout, stderr } = await run([
      'api', '--hostname', 'github.com', '--include', 'graphql',
      '-f', `query=${link.kind === 'issue' ? issueQuery : pullQuery}`,
      '-f', `owner=${link.owner}`, '-f', `name=${link.repository}`, '-F', `number=${link.number}`,
    ]));
  } catch (error) {
    const failure = error as { code?: string; stdout?: string; stderr?: string };
    if (failure.code === 'ENOENT') return { retryAfterMs: retryMs };
    ({ stdout = '', stderr = '' } = failure);
  }

  const [headers, body] = stdout.split(/\r?\n\r?\n/, 2);
  const httpCode = /^HTTP\/\S+ (\d+)/.exec(headers)?.[1];
  const retryAfter = /^retry-after:\s*(\d+)/im.exec(headers)?.[1];
  const reset = /^x-ratelimit-reset:\s*(\d+)/im.exec(headers)?.[1];
  const remaining = /^x-ratelimit-remaining:\s*0\s*$/im.test(headers);
  const rateLimited = httpCode === '429' || remaining || retryAfter || /rate limit/i.test(stderr);
  const untilReset = remaining && reset ? Number(reset) * 1_000 - now() : 0;
  const retryAfterMs = rateLimited ? Math.max(retryMs, Number(retryAfter ?? 0) * 1_000, untilReset) : undefined;
  const backoff = retryAfterMs === undefined ? {} : { retryAfterMs };
  if (httpCode === '401' || /gh auth login/i.test(stderr)) return { retryAfterMs: retryAfterMs ?? retryMs };
  if (httpCode !== '200' || !body) return backoff;

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return backoff;
  }
  const result = envelopeSchema.safeParse(json);
  if (!result.success) return backoff;
  const { data, errors } = result.data;
  if (errors?.some(({ message, type }) => type === 'RATE_LIMITED' || /rate limit/i.test(message))) {
    return { retryAfterMs: retryAfterMs ?? retryMs };
  }
  if (link.kind === 'issue') {
    const issue = issueSchema.safeParse(data?.repository?.issue);
    return issue.success ? { ...backoff, value: { state: issue.data.state === 'OPEN' ? 'open' : 'closed' } } : backoff;
  }
  const pull = pullSchema.safeParse(data?.repository?.pullRequest);
  if (!pull.success) return backoff;
  const { state, isDraft, headRefOid, commits } = pull.data;
  return {
    ...backoff,
    value: {
      state: state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : isDraft ? 'draft' : 'open',
      ci: errors?.length ? 'unavailable' : pullCi(commits, headRefOid),
    },
  };
}

const batchIntervalMs = 10_000;
const freshMs = 60_000;
const cacheLimit = 512;
const batchLimit = 4;

export class GitHubLinkStatusProvider {
  private readonly cache = new Map<string, { attemptedAt: number; value?: StatusValue; failed: boolean }>();
  private nextBatchAt = 0;
  private running = false;

  constructor(private readonly run = runGh, private readonly now = Date.now) {}

  async refresh(urls: readonly string[], signal?: AbortSignal): Promise<GitHubLinkStatuses> {
    if (signal?.aborted) return {};
    const links = [...new Set(urls)].flatMap((url) => {
      const link = parseGitHubLink(url);
      return link && link.kind !== 'repository' ? [link] : [];
    });
    const attemptedAt = (url: string) => this.cache.get(url)?.attemptedAt ?? -Infinity;
    const now = this.now();
    if (!this.running && now >= this.nextBatchAt) {
      const batch = links.filter(({ url }) => now - attemptedAt(url) >= freshMs)
        .sort((a, b) => attemptedAt(a.url) - attemptedAt(b.url)).slice(0, batchLimit);
      if (batch.length) {
        this.running = true;
        this.nextBatchAt = now + batchIntervalMs;
        try {
          for (const link of batch) {
            if (signal?.aborted) break;
            const { value, retryAfterMs } = await readGitHubLinkStatus(link, this.run, this.now);
            const previous = this.cache.get(link.url)?.value;
            this.cache.delete(link.url);
            this.cache.set(link.url, { attemptedAt: this.now(), value: value ?? previous, failed: !value });
            if (this.cache.size > cacheLimit) this.cache.delete(this.cache.keys().next().value!);
            if (retryAfterMs) {
              this.nextBatchAt = this.now() + retryAfterMs;
              break;
            }
          }
        } finally {
          this.running = false;
        }
      }
    }
    if (signal?.aborted) return {};
    const at = this.now();
    return Object.fromEntries(links.map(({ url }): [string, GitHubLinkStatus] => {
      const cached = this.cache.get(url);
      if (!cached?.value) return [url, { freshness: 'unavailable' }];
      const expiresAt = cached.attemptedAt + freshMs;
      if (cached.failed || at >= expiresAt) return [url, { ...cached.value, freshness: 'stale' }];
      return [url, { ...cached.value, freshness: 'fresh', expiresAt }];
    }));
  }
}

export class SessionGitHubStatusRequests {
  private active?: { sessionId: string; requestId: number; controller: AbortController };

  constructor(
    private readonly repos: Pick<Repositories, 'sessions' | 'github'>,
    private readonly provider = new GitHubLinkStatusProvider(),
  ) {}

  cancel(sessionId: unknown, requestId: unknown): void {
    const request = this.active;
    if (request && request.sessionId === sessionId && request.requestId === requestId) {
      request.controller.abort();
    }
  }

  async refresh(sessionId: string, requestId: number): Promise<GitHubLinkStatuses> {
    this.active?.controller.abort();
    const request = { sessionId, requestId, controller: new AbortController() };
    this.active = request;
    const { signal } = request.controller;
    try {
      const session = await this.repos.sessions.findById(sessionId);
      if (!session || signal.aborted) return {};
      const origin = session.originIssueUrl ? parseGitHubLink(session.originIssueUrl) : undefined;
      const urls = origin?.kind === 'issue' ? [origin.url] : [];
      try {
        const links = await this.repos.github?.links(sessionId) ?? [];
        urls.push(...links.map(({ url }) => url));
      } catch (error) {
        // The repository already reports the recovery requirement. Its retained
        // links are unavailable, but the separately stored origin is usable.
        if (!(error instanceof GitHubLinkRecoveryRequiredError)) throw error;
      }
      return await this.provider.refresh(urls, signal);
    } finally {
      if (this.active === request) this.active = undefined;
    }
  }
}
