import { eq } from 'drizzle-orm';
import type { Artifact, ArtifactRepository, Logger } from '@spawnea/domain';
import { createLogger } from '@spawnea/domain';
import type { DbClient } from '../connection.js';
import { artifacts } from '../schema.js';
import { toArtifact } from '../mappers.js';

export class SqliteArtifactRepository implements ArtifactRepository {
  private readonly db: DbClient;
  private readonly logger: Logger;

  constructor(db: DbClient, logger?: Logger) {
    this.db = db;
    this.logger = logger ? logger.child('artifact-repo') : createLogger('db:artifact-repo');
  }

  async findById(id: string): Promise<Artifact | null> {
    this.logger.debug('Finding artifact by ID', { id });
    const row = await this.db.query.artifacts.findFirst({
      where: eq(artifacts.id, id),
    });

    if (!row) {
      this.logger.debug('Artifact not found', { id });
      return null;
    }

    return toArtifact(row);
  }

  async findBySessionId(sessionId: string): Promise<Artifact[]> {
    this.logger.debug('Finding artifacts by session ID', { sessionId });
    const rows = await this.db.select().from(artifacts).where(eq(artifacts.sessionId, sessionId));
    return rows.map(toArtifact);
  }

  async save(artifact: Omit<Artifact, 'createdAt'> & { createdAt?: Date }): Promise<Artifact> {
    this.logger.info('Saving artifact', {
      id: artifact.id,
      sessionId: artifact.sessionId,
      filename: artifact.filename,
      direction: artifact.direction,
    });

    const existing = await this.findById(artifact.id);
    const now = new Date();

    if (existing) {
      const updatedValues = {
        sessionId: artifact.sessionId,
        direction: artifact.direction,
        remotePath: artifact.remotePath,
        cachedLocalPath: artifact.cachedLocalPath ?? null,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
      };

      try {
        await this.db.update(artifacts).set(updatedValues).where(eq(artifacts.id, artifact.id));
      } catch (error) {
        this.logger.error('Failed to update artifact in database', error, { id: artifact.id });
        throw error;
      }

      const updated = await this.findById(artifact.id);
      if (!updated) {
        throw new Error(`Failed to retrieve artifact after update: ${artifact.id}`);
      }
      return updated;
    }

    const newArtifact = {
      id: artifact.id,
      sessionId: artifact.sessionId,
      direction: artifact.direction,
      remotePath: artifact.remotePath,
      cachedLocalPath: artifact.cachedLocalPath ?? null,
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
      createdAt: artifact.createdAt ?? now,
    };

    try {
      await this.db.insert(artifacts).values(newArtifact);
    } catch (error) {
      this.logger.error('Failed to insert artifact into database', error, { id: artifact.id });
      throw error;
    }

    const created = await this.findById(artifact.id);
    if (!created) {
      throw new Error(`Failed to retrieve artifact after insert: ${artifact.id}`);
    }
    return created;
  }

  async delete(id: string): Promise<boolean> {
    this.logger.info('Deleting artifact', { id });
    try {
      const result = await this.db.delete(artifacts).where(eq(artifacts.id, id));
      const deleted = result.changes > 0;
      this.logger.debug('Artifact delete result', { id, deleted });
      return deleted;
    } catch (error) {
      this.logger.error('Failed to delete artifact', error, { id });
      throw error;
    }
  }
}
