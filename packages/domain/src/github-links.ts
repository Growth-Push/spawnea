/** A complete, canonical GitHub repository, issue or pull request reference. */
export type GitHubLink = {
  url: string;
  owner: string;
  repository: string;
} & ({ kind: 'repository' } | { kind: 'issue' | 'pull'; number: string });

export const MAX_GITHUB_LINK_LENGTH = 2048;
export const MAX_GITHUB_LINK_SCAN_LENGTH = 32768;
export const MAX_GITHUB_LINK_IDENTITIES = 128;
export type GitHubLinkSource = 'task' | 'prompt' | 'output';
export type RetainedGitHubLink = { url: string; kind: GitHubLink['kind']; source: GitHubLinkSource };

/** Normalize bounded metadata, keeping the earliest identities at each source priority. */
export function normalizeRetainedGitHubLinks(values: readonly RetainedGitHubLink[]): RetainedGitHubLink[] {
  const byUrl = new Map<string, { order: number; priority: number; links: Map<GitHubLinkSource, RetainedGitHubLink> }>();
  const priority: Record<GitHubLinkSource, number> = { task: 0, prompt: 1, output: 2 };
  let order = 0;
  for (const value of values) {
    if (!value || typeof value.source !== 'string' || !Object.hasOwn(priority, value.source) || typeof value.url !== 'string') continue;
    const parsed = parseGitHubLink(value.url);
    if (!parsed || parsed.kind !== value.kind) continue;
    let entry = byUrl.get(parsed.url);
    if (!entry) {
      if (byUrl.size >= MAX_GITHUB_LINK_IDENTITIES) {
        let victim: string | undefined;
        let lastPriority = priority[value.source];
        let lastOrder = -1;
        for (const [url, candidate] of byUrl) {
          if (candidate.priority > lastPriority || (candidate.priority === lastPriority && candidate.priority > priority[value.source] && candidate.order > lastOrder)) {
            victim = url; lastPriority = candidate.priority; lastOrder = candidate.order;
          }
        }
        if (!victim) continue;
        byUrl.delete(victim);
      }
      entry = { order: order++, priority: priority[value.source], links: new Map() };
      byUrl.set(parsed.url, entry);
    }
    entry.priority = Math.min(entry.priority, priority[value.source]);
    if (!entry.links.has(value.source)) entry.links.set(value.source, { url: parsed.url, kind: parsed.kind, source: value.source });
  }
  for (const entry of byUrl.values()) entry.links.clear();
  for (const value of values) {
    if (!value || typeof value.source !== 'string' || !Object.hasOwn(priority, value.source) || typeof value.url !== 'string') continue;
    const parsed = parseGitHubLink(value.url);
    const entry = parsed && byUrl.get(parsed.url);
    if (entry && parsed.kind === value.kind && !entry.links.has(value.source)) entry.links.set(value.source, { url: parsed.url, kind: parsed.kind, source: value.source });
  }
  return [...byUrl.values()].sort((a, b) => a.priority - b.priority || a.order - b.order)
    .flatMap((entry) => [...entry.links.values()]);
}

// These root namespaces identify GitHub site pages, not repository owners.
const GITHUB_SITE_NAMESPACES = new Set([
  'account', 'apps', 'codespaces', 'collections', 'explore', 'features',
  'login', 'marketplace', 'notifications', 'organizations', 'orgs', 'pricing', 'pulls',
  'search', 'settings', 'signup', 'sponsors', 'topics', 'users',
]);

/** Accept only a complete github.com resource URL, never a shorthand reference. */
export function parseGitHubLink(input: string): GitHubLink | undefined {
  if (input.length > MAX_GITHUB_LINK_LENGTH) return undefined;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || !/^https:\/\/github\.com\//i.test(input)) return undefined;
  const path = input.slice(input.indexOf('/', 8)).split(/[?#]/, 1)[0];
  const match = /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]+)(?:\/(issues|pull)\/([1-9][0-9]*))?\/?$/.exec(path);
  if (!match || match[2] === '.' || match[2] === '..') return undefined;
  const [, owner, repository, resource, number] = match;
  const base = {
    owner: owner.toLowerCase(),
    repository: repository.toLowerCase(),
  };
  if (!resource) {
    if (GITHUB_SITE_NAMESPACES.has(base.owner)) return undefined;
    return { ...base, url: `https://github.com/${base.owner}/${base.repository}`, kind: 'repository' };
  }
  return {
    url: `https://github.com/${owner.toLowerCase()}/${repository.toLowerCase()}/${resource}/${number}`,
    ...base,
    kind: resource === 'issues' ? 'issue' : 'pull',
    number,
  };
}

/** Extract references from bounded text. The text itself must not be persisted. */
export function findGitHubLinks(text: string): GitHubLink[] {
  let bounded = text.slice(0, MAX_GITHUB_LINK_SCAN_LENGTH);
  if (text.length > MAX_GITHUB_LINK_SCAN_LENGTH && !/[\s<>"']/.test(text[MAX_GITHUB_LINK_SCAN_LENGTH])) {
    const boundary = Math.max(bounded.lastIndexOf(' '), bounded.lastIndexOf('\n'), bounded.lastIndexOf('\r'), bounded.lastIndexOf('\t'), bounded.lastIndexOf('<'), bounded.lastIndexOf('>'), bounded.lastIndexOf('"'), bounded.lastIndexOf("'"));
    bounded = bounded.slice(0, boundary + 1);
  }
  // Remove CSI and OSC control sequences before matching terminal captures.
  // eslint-disable-next-line no-control-regex
  const plain = bounded.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const matches = plain.matchAll(/https:\/\/github\.com\/[^\s<>"']+/gi);
  const links = new Map<string, GitHubLink>();
  for (const match of matches) {
    if (match[0].length > MAX_GITHUB_LINK_LENGTH) continue;
    let cleaned = match[0].replace(/[.,;:!?\])}]+$/, '');
    const opening = /[`*]+$/.exec(plain.slice(0, match.index))?.[0];
    const closing = opening?.split('').reverse().join('');
    if (closing && cleaned.endsWith(closing)) {
      cleaned = cleaned.slice(0, -closing.length).replace(/[.,;:!?\])}]+$/, '');
    }
    const link = parseGitHubLink(cleaned);
    if (link) links.set(link.url, link);
  }
  return [...links.values()];
}
