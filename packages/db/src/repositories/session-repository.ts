import { eq } from 'drizzle-orm';
import type { Session, SessionRepository, SessionStatus, Logger } from '@spawnea/domain';
import { createLogger } from '@spawnea/domain';
import type { DbClient } from '../connection.js';
import { sessions } from '../schema.js';
import { toSession } from '../mappers.js';

export class SqliteSessionRepository implements SessionRepository {
  private readonly db: DbClient;
  private readonly logger: Logger;

  constructor(db: DbClient, logger?: Logger) {
    this.db = db;
    this.logger = logger ? logger.child('session-repo') : createLogger('db:session-repo');
  }

  async findById(id: string): Promise<Session | null> {
    this.logger.debug('Finding session by ID', { id });
    const row = await this.db.query.sessions.findFirst({
      where: eq(sessions.id, id),
    });

    if (!row) {
      this.logger.debug('Session not found', { id });
      return null;
    }

    return toSession(row);
  }

  async findAll(): Promise<Session[]> {
    this.logger.debug('Listing all sessions');
    const rows = await this.db.select().from(sessions);
    return rows.map(toSession);
  }

  async findByServerId(serverId: string): Promise<Session[]> {
    this.logger.debug('Finding sessions by server ID', { serverId });
    const rows = await this.db.select().from(sessions).where(eq(sessions.serverId, serverId));
    return rows.map(toSession);
  }

  async findByProjectId(projectId: string): Promise<Session[]> {
    this.logger.debug('Finding sessions by project ID', { projectId });
    const rows = await this.db.select().from(sessions).where(eq(sessions.projectId, projectId));
    return rows.map(toSession);
  }

  async findByAgentId(agentId: string): Promise<Session[]> {
    this.logger.debug('Finding sessions by agent ID', { agentId });
    const rows = await this.db.select().from(sessions).where(eq(sessions.agentId, agentId));
    return rows.map(toSession);
  }

  async findByStatus(status: SessionStatus): Promise<Session[]> {
    this.logger.debug('Finding sessions by status', { status });
    const rows = await this.db.select().from(sessions).where(eq(sessions.status, status));
    return rows.map(toSession);
  }

  async save(
    session: Omit<Session, 'createdAt' | 'lastActivityAt'> & {
      createdAt?: Date;
      lastActivityAt?: Date;
    },
  ): Promise<Session> {
    this.logger.info('Saving session', {
      id: session.id,
      name: session.name,
      serverId: session.serverId,
      projectId: session.projectId,
      agentId: session.agentId,
      task: session.task,
      status: session.status,
    });

    const existing = await this.findById(session.id);
    const now = new Date();

    if (existing) {
      const updatedValues = {
        name: session.name,
        serverId: session.serverId,
        projectId: session.projectId,
        agentId: session.agentId,
        task: session.task,
        worktreePath: session.worktreePath,
        branch: session.branch,
        baseBranch: session.baseBranch ?? null,
        baseCommit: session.baseCommit ?? null,
        managedWorktree: session.managedWorktree ?? false,
        tmuxSessionName: session.tmuxSessionName,
        tmuxWindowName: session.tmuxWindowName ?? null,
        status: session.status,
        creationSource: session.creationSource ?? existing.creationSource ?? 'ui',
        isExternal: session.isExternal ?? existing.isExternal ?? false,
        lastActivityAt: session.lastActivityAt ?? now,
      };

      try {
        await this.db.update(sessions).set(updatedValues).where(eq(sessions.id, session.id));
      } catch (error) {
        this.logger.error('Failed to update session in database', error, { id: session.id });
        throw error;
      }

      const updated = await this.findById(session.id);
      if (!updated) {
        throw new Error(`Failed to retrieve session after update: ${session.id}`);
      }
      return updated;
    }

    const newSession = {
      id: session.id,
      name: session.name,
      serverId: session.serverId,
      projectId: session.projectId,
      agentId: session.agentId,
      task: session.task,
      worktreePath: session.worktreePath,
      branch: session.branch,
      baseBranch: session.baseBranch ?? null,
      baseCommit: session.baseCommit ?? null,
      managedWorktree: session.managedWorktree ?? false,
      tmuxSessionName: session.tmuxSessionName,
      tmuxWindowName: session.tmuxWindowName ?? null,
      status: session.status,
      creationSource: session.creationSource ?? 'ui',
      isExternal: session.isExternal ?? false,
      createdAt: session.createdAt ?? now,
      lastActivityAt: session.lastActivityAt ?? now,
    };

    try {
      await this.db.insert(sessions).values(newSession);
    } catch (error) {
      this.logger.error('Failed to insert session into database', error, { id: session.id });
      throw error;
    }

    const created = await this.findById(session.id);
    if (!created) {
      throw new Error(`Failed to retrieve session after insert: ${session.id}`);
    }
    return created;
  }

  async update(
    id: string,
    updates: Partial<Omit<Session, 'id' | 'createdAt'>>,
  ): Promise<Session> {
    this.logger.info('Updating session', { id, updates });

    const existing = await this.findById(id);
    if (!existing) {
      const err = new Error(`Session with id '${id}' not found`);
      this.logger.error('Failed to update session: not found', err, { id });
      throw err;
    }

    const setValues: Partial<typeof sessions.$inferInsert> = {};
    if (updates.name !== undefined) setValues.name = updates.name;
    if (updates.serverId !== undefined) setValues.serverId = updates.serverId;
    if (updates.projectId !== undefined) setValues.projectId = updates.projectId;
    if (updates.agentId !== undefined) setValues.agentId = updates.agentId;
    if (updates.task !== undefined) setValues.task = updates.task;
    if (updates.worktreePath !== undefined) setValues.worktreePath = updates.worktreePath;
    if (updates.branch !== undefined) setValues.branch = updates.branch;
    if (updates.baseBranch !== undefined) setValues.baseBranch = updates.baseBranch;
    if (updates.baseCommit !== undefined) setValues.baseCommit = updates.baseCommit;
    if (updates.managedWorktree !== undefined) setValues.managedWorktree = updates.managedWorktree;
    if (updates.tmuxSessionName !== undefined) setValues.tmuxSessionName = updates.tmuxSessionName;
    if (updates.tmuxWindowName !== undefined) setValues.tmuxWindowName = updates.tmuxWindowName;
    if (updates.status !== undefined) setValues.status = updates.status;
    if (updates.creationSource !== undefined) setValues.creationSource = updates.creationSource;
    if (updates.isExternal !== undefined) setValues.isExternal = updates.isExternal;
    if (updates.lastActivityAt !== undefined) setValues.lastActivityAt = updates.lastActivityAt;

    if (Object.keys(setValues).length > 0) {
      try {
        await this.db.update(sessions).set(setValues).where(eq(sessions.id, id));
      } catch (error) {
        this.logger.error('Failed to apply session updates to database', error, { id });
        throw error;
      }
    }

    const updated = await this.findById(id);
    if (!updated) {
      throw new Error(`Session '${id}' vanished during update`);
    }
    return updated;
  }

  async updateStatus(
    id: string,
    status: SessionStatus,
    lastActivityAt?: Date,
  ): Promise<Session> {
    const timestamp = lastActivityAt ?? new Date();
    this.logger.info('Updating session status', { id, status, lastActivityAt: timestamp });

    return this.update(id, { status, lastActivityAt: timestamp });
  }

  async delete(id: string): Promise<boolean> {
    this.logger.info('Deleting session', { id });
    try {
      const result = await this.db.delete(sessions).where(eq(sessions.id, id));
      const deleted = result.changes > 0;
      this.logger.debug('Session delete result', { id, deleted });
      return deleted;
    } catch (error) {
      this.logger.error('Failed to delete session', error, { id });
      throw error;
    }
  }
}
