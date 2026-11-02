import { findGitHubLinks, MAX_GITHUB_LINK_SCAN_LENGTH } from '@spawnea/domain';
import type { Repositories, LinkSource } from '@spawnea/db';
import type { SessionContextStore } from './session-context-store.js';

/** Persist only canonical identities and provenance, never the input text. */
export async function retainSessionLinks(repos: Repositories, sessionId: string, source: LinkSource, text: string, contextStore?: SessionContextStore): Promise<void> {
  if (!repos.github) return;
  let input = text;
  if (source === 'output' && text.length > MAX_GITHUB_LINK_SCAN_LENGTH) {
    const start = text.length - MAX_GITHUB_LINK_SCAN_LENGTH;
    input = text.slice(start);
    if (!/[\s<>"']/.test(text[start - 1]) && !/[\s<>"']/.test(input[0])) {
      const boundary = input.search(/[\s<>"']/);
      input = boundary < 0 ? '' : input.slice(boundary);
    }
  }
  const links = findGitHubLinks(input);
  if (!links.length) return;
  const admit = async () => (await repos.github!.admitLinks(sessionId, links.map((link) => ({ sessionId, url: link.url, kind: link.kind, source, createdAt: new Date() }))))
    .map(({ url, kind, source }) => ({ url, kind, source }));
  if (contextStore) await contextStore.syncRetainedLinks(sessionId, admit);
  else await admit();
}
