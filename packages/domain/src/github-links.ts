/** A complete, canonical GitHub repository, issue or pull request reference. */
export type GitHubLink = {
  url: string;
  owner: string;
  repository: string;
} & ({ kind: 'repository' } | { kind: 'issue' | 'pull'; number: string });

// These root namespaces identify GitHub site pages, not repository owners.
const GITHUB_SITE_NAMESPACES = new Set([
  'account', 'apps', 'codespaces', 'collections', 'explore', 'features',
  'login', 'marketplace', 'notifications', 'organizations', 'orgs', 'pricing', 'pulls',
  'search', 'settings', 'signup', 'sponsors', 'topics', 'users',
]);

/** Accept only a complete github.com resource URL, never a shorthand reference. */
export function parseGitHubLink(input: string): GitHubLink | undefined {
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
  // Remove CSI and OSC control sequences before matching terminal captures.
  // Terminal control characters are deliberately matched here.
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const matches = plain.matchAll(/https:\/\/github\.com\/[^\s<>"']+/gi);
  const links = new Map<string, GitHubLink>();
  for (const match of matches) {
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
