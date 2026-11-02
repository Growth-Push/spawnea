import { eq } from 'drizzle-orm';
import type { DbClient } from '../connection.js';
import { sessionLinks } from '../schema.js';

export type LinkSource = 'task' | 'prompt' | 'output';
export interface StoredSessionLink { sessionId: string; url: string; kind: 'repository' | 'issue' | 'pull'; source: LinkSource; createdAt: Date }

export class SqliteGitHubRepository {
  constructor(private readonly db: DbClient) {}

  async links(sessionId: string): Promise<StoredSessionLink[]> {
    const rows = await this.db.select().from(sessionLinks).where(eq(sessionLinks.sessionId, sessionId));
    return rows.map((row) => ({ ...row, kind: row.kind as StoredSessionLink['kind'], source: row.source as LinkSource }));
  }

  async addLink(link: StoredSessionLink): Promise<void> {
    await this.db.insert(sessionLinks).values(link).onConflictDoNothing();
  }
}
