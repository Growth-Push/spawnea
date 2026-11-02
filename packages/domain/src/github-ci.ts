export type CiState = 'queued' | 'running' | 'successful' | 'failed' | 'cancelled' | 'skipped' | 'no-checks' | 'unavailable';

export interface CiObservation {
  /** Stable provider identity, including the source application for check runs. */
  key: string;
  /** Provider timestamp, used to retain the latest attempt or status for this key. */
  observedAt: string;
  state: Exclude<CiState, 'no-checks' | 'unavailable'>;
}

export interface GitHubCheck extends CiObservation {
  name: string;
  url?: string;
}

export interface GitHubCiResult {
  state: CiState;
  repository?: string;
  sha?: string;
  localSha?: string;
  dirty?: boolean;
  fetchedAt: string;
  checks: GitHubCheck[];
  message?: string;
  retryAt?: string;
}

export interface GitHubIssueMetadata {
  state: 'open' | 'closed' | 'unavailable';
  title?: string;
  fetchedAt: string;
}

export interface TrackerProvider {
  issue(url: string): Promise<GitHubIssueMetadata>;
}

export interface PullHead {
  repository: string;
  headRepository: string;
  headBranch: string;
  sha: string;
}

export interface CiProvider {
  getRetryAt(): string | undefined;
  pull(url: string): Promise<PullHead | undefined>;
  ci(repository: string, sha: string, localSha?: string, dirty?: boolean): Promise<GitHubCiResult>;
}

/**
 * Reduce a complete provider response. A failed or incomplete request is always
 * unavailable; only a nonempty set of entirely successful results passes.
 */
export function aggregateCi(observations: CiObservation[], complete: boolean): CiState {
  if (!complete) return 'unavailable';
  const latest = new Map<string, CiObservation>();
  for (const observation of observations) {
    const timestamp = Date.parse(observation.observedAt);
    if (!observation.key || !Number.isFinite(timestamp)) return 'unavailable';
    const current = latest.get(observation.key);
    if (current && Date.parse(current.observedAt) === timestamp && current.state !== observation.state) return 'unavailable';
    if (!current || timestamp > Date.parse(current.observedAt)) latest.set(observation.key, observation);
  }
  if (latest.size === 0) return 'no-checks';
  const states = [...latest.values()].map((observation) => observation.state);
  for (const state of ['failed', 'running', 'queued', 'cancelled', 'skipped'] as const) {
    if (states.includes(state)) return state;
  }
  return states.every((state) => state === 'successful') ? 'successful' : 'unavailable';
}
