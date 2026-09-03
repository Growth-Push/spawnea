import { and, eq } from 'drizzle-orm';
import type { Session, SessionRepository, SessionStatus, Logger } from '@spawnea/domain';
import { createLogger } from '@spawnea/domain';
import type { DbClient } from '../connection.js';
import { sessions, sessionChildAliasCounters } from '../schema.js';
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

  async findByParentId(parentId: string): Promise<Session[]> {
    this.logger.debug('Finding child sessions by parent ID', { parentId });
    const rows = await this.db.select().from(sessions).where(eq(sessions.parentSessionId, parentId));
    return rows.map(toSession);
  }

  async findByParentAndAlias(parentId: string, childAlias: string): Promise<Session | null> {
    this.logger.debug('Finding child session by parent ID and alias', { parentId, childAlias });
    const rows = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.parentSessionId, parentId), eq(sessions.childAlias, childAlias)));
    return rows.length > 0 ? toSession(rows[0]) : null;
  }

  async allocateChildAlias(parentId: string): Promise<string> {
    this.logger.debug('Allocating next child alias for parent', { parentId });
    return this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(sessionChildAliasCounters)
        .where(eq(sessionChildAliasCounters.parentSessionId, parentId))
        .all();

      let nextIndex = 1;
      if (existing.length > 0) {
        nextIndex = existing[0].nextAliasIndex;
      }

      const existingChildren = tx
        .select()
        .from(sessions)
        .where(eq(sessions.parentSessionId, parentId))
        .all();

      let maxExisting = 0;
      for (const child of existingChildren) {
        const match = child.childAlias?.match(/^child-(\d+)$/);
        if (match) {
          maxExisting = Math.max(maxExisting, parseInt(match[1], 10));
        }
      }
      if (nextIndex <= maxExisting) {
        nextIndex = maxExisting + 1;
      }

      const assignedAlias = `child-${nextIndex}`;
      const nextCounterValue = nextIndex + 1;

      if (existing.length > 0) {
        tx.update(sessionChildAliasCounters)
          .set({ nextAliasIndex: nextCounterValue })
          .where(eq(sessionChildAliasCounters.parentSessionId, parentId))
          .run();
      } else {
        tx.insert(sessionChildAliasCounters)
          .values({
            parentSessionId: parentId,
            nextAliasIndex: nextCounterValue,
          })
          .run();
      }

      return assignedAlias;
    });
  }

  async releaseChildAlias(parentId: string, alias: string): Promise<boolean> {
    const match = alias.match(/^child-(\d+)$/);
    if (!match) return false;
    const index = Number(match[1]);
    return this.db.transaction((tx) => {
      const children = tx.select().from(sessions).where(eq(sessions.parentSessionId, parentId)).all();
      if (children.some((child) => child.childAlias === alias)) return false;
      const counter = tx.select().from(sessionChildAliasCounters)
        .where(eq(sessionChildAliasCounters.parentSessionId, parentId)).all();
      if (counter.length === 0 || counter[0].nextAliasIndex !== index + 1) return false;
      tx.update(sessionChildAliasCounters)
        .set({ nextAliasIndex: index })
        .where(eq(sessionChildAliasCounters.parentSessionId, parentId))
        .run();
      return true;
    });
  }

  async promoteChildrenToRoot(parentId: string): Promise<number> {
    this.logger.info('Promoting child sessions of parent to root', { parentId });
    const result = await this.db
      .update(sessions)
      .set({ parentSessionId: null, childAlias: null })
      .where(eq(sessions.parentSessionId, parentId));
    return result.changes;
  }

  async clearParentReferences(parentId: string): Promise<number> {
    return this.promoteChildrenToRoot(parentId);
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
        parentSessionId: session.parentSessionId ?? null,
        childAlias: session.childAlias ?? null,
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
      parentSessionId: session.parentSessionId ?? null,
      childAlias: session.childAlias ?? null,
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
    if (updates.parentSessionId !== undefined) setValues.parentSessionId = updates.parentSessionId ?? null;
    if (updates.childAlias !== undefined) setValues.childAlias = updates.childAlias ?? null;
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
      // Atomically resolve child references before parent deletion so no orphaned foreign keys remain
      const deleted = this.db.transaction((tx) => {
        tx.update(sessions)
          .set({ parentSessionId: null, childAlias: null })
          .where(eq(sessions.parentSessionId, id))
          .run();

        return tx.delete(sessions).where(eq(sessions.id, id)).run().changes > 0;
      });
      this.logger.debug('Session delete result', { id, deleted });
      return deleted;
    } catch (error) {
      this.logger.error('Failed to delete session', error, { id });
      throw error;
    }
  }
}
