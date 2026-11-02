import { eq } from 'drizzle-orm';
import type { DbClient } from '../connection.js';
import { githubProjectSettings, sessionLinks } from '../schema.js';

export type LinkSource = 'task' | 'prompt' | 'output';
export interface StoredSessionLink { sessionId: string; url: string; kind: 'issue' | 'pull'; source: LinkSource; createdAt: Date }
export interface GitHubSettings { trackerEnabled: boolean; ciEnabled: boolean }

export class SqliteGitHubRepository {
  constructor(private readonly db: DbClient) {}

  async settings(projectId: string): Promise<GitHubSettings> {
    const row = await this.db.select().from(githubProjectSettings).where(eq(githubProjectSettings.projectId, projectId)).get();
    return row ? { trackerEnabled: row.trackerEnabled, ciEnabled: row.ciEnabled } : { trackerEnabled: false, ciEnabled: false };
  }

  async setSettings(projectId: string, settings: GitHubSettings): Promise<void> {
    await this.db.insert(githubProjectSettings).values({ projectId, ...settings })
      .onConflictDoUpdate({ target: githubProjectSettings.projectId, set: settings });
  }

  async links(sessionId: string): Promise<StoredSessionLink[]> {
    const rows = await this.db.select().from(sessionLinks).where(eq(sessionLinks.sessionId, sessionId));
    return rows.map((row) => ({ ...row, kind: row.kind as StoredSessionLink['kind'], source: row.source as LinkSource }));
  }

  async addLink(link: StoredSessionLink): Promise<void> {
    await this.db.insert(sessionLinks).values(link).onConflictDoNothing();
  }
}
