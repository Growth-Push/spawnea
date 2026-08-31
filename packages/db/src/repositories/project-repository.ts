import { eq } from 'drizzle-orm';
import type { Project, ProjectRepository, Logger } from '@spawnea/domain';
import { createLogger } from '@spawnea/domain';
import type { DbClient } from '../connection.js';
import { projects } from '../schema.js';
import { toProject } from '../mappers.js';

export class SqliteProjectRepository implements ProjectRepository {
  private readonly db: DbClient;
  private readonly logger: Logger;

  constructor(db: DbClient, logger?: Logger) {
    this.db = db;
    this.logger = logger ? logger.child('project-repo') : createLogger('db:project-repo');
  }

  async findById(id: string): Promise<Project | null> {
    this.logger.debug('Finding project by ID', { id });
    const row = await this.db.query.projects.findFirst({
      where: eq(projects.id, id),
    });

    if (!row) {
      this.logger.debug('Project not found', { id });
      return null;
    }

    return toProject(row);
  }

  async findAll(): Promise<Project[]> {
    this.logger.debug('Listing all projects');
    const rows = await this.db.select().from(projects);
    return rows.map(toProject);
  }

  async findByServerId(serverId: string): Promise<Project[]> {
    this.logger.debug('Finding projects by server ID', { serverId });
    const rows = await this.db.select().from(projects).where(eq(projects.serverId, serverId));
    return rows.map(toProject);
  }

  async save(project: Omit<Project, 'createdAt'> & { createdAt?: Date }): Promise<Project> {
    this.logger.info('Saving project', {
      id: project.id,
      serverId: project.serverId,
      name: project.name,
      rootPath: project.rootPath,
    });

    const existing = await this.findById(project.id);
    const now = new Date();

    if (existing) {
      const updatedValues = {
        serverId: project.serverId,
        name: project.name,
        rootPath: project.rootPath,
        repoUrl: project.repoUrl ?? null,
        baseBranch: project.baseBranch ?? null,
      };

      try {
        await this.db.update(projects).set(updatedValues).where(eq(projects.id, project.id));
      } catch (error) {
        this.logger.error('Failed to update project in database', error, { id: project.id });
        throw error;
      }

      const updated = await this.findById(project.id);
      if (!updated) {
        throw new Error(`Failed to retrieve project after update: ${project.id}`);
      }
      return updated;
    }

    const newProject = {
      id: project.id,
      serverId: project.serverId,
      name: project.name,
      rootPath: project.rootPath,
      repoUrl: project.repoUrl ?? null,
      baseBranch: project.baseBranch ?? null,
      createdAt: project.createdAt ?? now,
    };

    try {
      await this.db.insert(projects).values(newProject);
    } catch (error) {
      this.logger.error('Failed to insert project into database', error, { id: project.id });
      throw error;
    }

    const created = await this.findById(project.id);
    if (!created) {
      throw new Error(`Failed to retrieve project after insert: ${project.id}`);
    }
    return created;
  }

  async update(
    id: string,
    updates: Partial<Omit<Project, 'id' | 'serverId' | 'createdAt'>>,
  ): Promise<Project> {
    this.logger.info('Updating project', { id, updates });

    const existing = await this.findById(id);
    if (!existing) {
      const err = new Error(`Project with id '${id}' not found`);
      this.logger.error('Failed to update project: not found', err, { id });
      throw err;
    }

    const setValues: Partial<typeof projects.$inferInsert> = {};
    if (updates.name !== undefined) setValues.name = updates.name;
    if (updates.rootPath !== undefined) setValues.rootPath = updates.rootPath;
    if (updates.repoUrl !== undefined) setValues.repoUrl = updates.repoUrl;
    if (updates.baseBranch !== undefined) setValues.baseBranch = updates.baseBranch;

    if (Object.keys(setValues).length > 0) {
      try {
        await this.db.update(projects).set(setValues).where(eq(projects.id, id));
      } catch (error) {
        this.logger.error('Failed to apply project updates to database', error, { id });
        throw error;
      }
    }

    const updated = await this.findById(id);
    if (!updated) {
      throw new Error(`Project '${id}' vanished during update`);
    }
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    this.logger.info('Deleting project', { id });
    try {
      const result = await this.db.delete(projects).where(eq(projects.id, id));
      const deleted = result.changes > 0;
      this.logger.debug('Project delete result', { id, deleted });
      return deleted;
    } catch (error) {
      this.logger.error('Failed to delete project', error, { id });
      throw error;
    }
  }
}
