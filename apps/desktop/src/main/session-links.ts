import { findGitHubLinks } from '@spawnea/domain';
import type { Repositories, LinkSource } from '@spawnea/db';
import type { SessionContextStore } from './session-context-store.js';

/** Persist only canonical identities and provenance, never the input text. */
export async function retainSessionLinks(repos: Repositories, sessionId: string, source: LinkSource, text: string, contextStore?: SessionContextStore): Promise<void> {
  if (!repos.github) return;
  const links = findGitHubLinks(text);
  for (const link of links) {
    await repos.github.addLink({ sessionId, url: link.url, kind: link.kind, source, createdAt: new Date() });
  }
  if (links.length) await contextStore?.retainLinks(sessionId, links.map((link) => ({ url: link.url, kind: link.kind, source })));
}
