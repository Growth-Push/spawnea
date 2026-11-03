import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { createLogger, MAX_GITHUB_LINK_LENGTH, normalizeRetainedGitHubLinks, parseGitHubLink, type GitHubLinkSource } from '@spawnea/domain';
import type { DbClient } from '../connection.js';
import { sessionLinks } from '../schema.js';

export type LinkSource = GitHubLinkSource;
export interface StoredSessionLink { sessionId: string; url: string; kind: 'repository' | 'issue' | 'pull'; source: LinkSource; createdAt: Date }

const MAX_LEGACY_LINK_ROWS = 4096;
const linkKey = (link: { source: LinkSource; url: string }) => `${link.source}\0${link.url}`;

function firstCanonicalRows(rows: readonly StoredSessionLink[], wanted?: Set<string>): Map<string, StoredSessionLink> {
  const first = new Map<string, StoredSessionLink>();
  for (const row of rows) {
    const parsed = parseGitHubLink(row.url);
    if (!parsed || parsed.kind !== row.kind) continue;
    const key = linkKey({ source: row.source, url: parsed.url });
    if ((!wanted || wanted.has(key)) && !first.has(key)) first.set(key, row);
  }
  return first;
}

export class SqliteGitHubRepository {
  private readonly logger = createLogger('db:github');
  constructor(private readonly db: DbClient) {}

  /** Admit and normalize in one transaction, including calls from recovery. */
  async admitLinks(sessionId: string, input: readonly StoredSessionLink[]): Promise<StoredSessionLink[]> {
    return this.db.transaction((tx) => {
      const overflow = tx.get(sql`select 1 as present from session_links where session_id = ${sessionId} limit 1 offset ${MAX_LEGACY_LINK_ROWS}`);
      if (overflow) {
        const message = 'Session link metadata exceeds the 4096-row automatic recovery limit';
        this.logger.warn(message, { sessionId });
        throw new Error(message);
      }
      if (input.some((item) => item.sessionId !== sessionId)) throw new Error('Link session does not match admission target');
      const count = tx.select({ value: sql<number>`count(*)` }).from(sessionLinks).where(eq(sessionLinks.sessionId, sessionId)).get()?.value ?? 0;
      let selected: StoredSessionLink[] = [];
      const original: StoredSessionLink[] = [];
      let offset = 0;
      while (true) {
        const rows = tx.select().from(sessionLinks).where(and(eq(sessionLinks.sessionId, sessionId), lte(sql<number>`length(cast(${sessionLinks.url} as blob))`, MAX_GITHUB_LINK_LENGTH * 4), inArray(sessionLinks.source, ['task', 'prompt', 'output']), inArray(sessionLinks.kind, ['repository', 'issue', 'pull']), sql`typeof(${sessionLinks.createdAt}) = 'integer' and ${sessionLinks.createdAt} between -8640000000000000 and 8640000000000000`))
          .orderBy(sql`case ${sessionLinks.source} when 'task' then 0 when 'prompt' then 1 when 'output' then 2 else 3 end`, asc(sessionLinks.createdAt), sql`rowid`)
          .limit(256).offset(offset).all() as StoredSessionLink[];
        if (!rows.length) break;
        if (count <= 384) original.push(...rows);
        const combined = [...selected, ...rows];
        const first = firstCanonicalRows(combined);
        const normalized = normalizeRetainedGitHubLinks(combined);
        selected = normalized.map((link) => {
          return { sessionId, ...link, createdAt: first.get(linkKey(link))!.createdAt };
        });
        offset += rows.length;
      }
      const combined = [...selected, ...input];
      const normalized = normalizeRetainedGitHubLinks(combined);
      const first = firstCanonicalRows(combined, new Set(normalized.map(linkKey)));
      selected = normalized.map((link) => {
        return { sessionId, ...link, createdAt: first.get(linkKey(link))!.createdAt };
      });
      const key = (link: StoredSessionLink) => `${link.source}\0${link.kind}\0${link.url}`;
      const retained = new Set(selected.map(key));
      const unchanged = count === selected.length && original.length === count && original.every((row) => retained.has(key(row)));
      if (!unchanged) {
        tx.delete(sessionLinks).where(eq(sessionLinks.sessionId, sessionId)).run();
        for (const link of selected) tx.insert(sessionLinks).values(link).run();
      }
      return selected;
    });
  }

  async links(sessionId: string): Promise<StoredSessionLink[]> {
    return this.admitLinks(sessionId, []);
  }

  async addLink(link: StoredSessionLink): Promise<void> {
    await this.admitLinks(link.sessionId, [link]);
  }
}
