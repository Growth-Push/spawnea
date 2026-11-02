/** A complete, canonical GitHub issue or pull request reference. */
export interface GitHubLink {
  url: string;
  owner: string;
  repository: string;
  kind: 'issue' | 'pull';
  number: string;
}

/** Accept only a complete github.com resource URL, never a shorthand reference. */
export function parseGitHubLink(input: string): GitHubLink | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password) return undefined;
  const match = /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]+)\/(issues|pull)\/([1-9][0-9]*)\/?$/.exec(url.pathname);
  if (!match || match[2] === '.' || match[2] === '..') return undefined;
  const [, owner, repository, resource, number] = match;
  return {
    url: `https://github.com/${owner.toLowerCase()}/${repository.toLowerCase()}/${resource}/${number}`,
    owner: owner.toLowerCase(),
    repository: repository.toLowerCase(),
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
