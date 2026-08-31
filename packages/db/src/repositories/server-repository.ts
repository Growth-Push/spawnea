import { eq } from 'drizzle-orm';
import type { Server, ServerRepository, Logger } from '@spawnea/domain';
import { createLogger } from '@spawnea/domain';
import type { DbClient } from '../connection.js';
import { servers } from '../schema.js';
import { toServer } from '../mappers.js';

export class SqliteServerRepository implements ServerRepository {
  private readonly db: DbClient;
  private readonly logger: Logger;

  constructor(db: DbClient, logger?: Logger) {
    this.db = db;
    this.logger = logger ? logger.child('server-repo') : createLogger('db:server-repo');
  }

  async findById(id: string): Promise<Server | null> {
    this.logger.debug('Finding server by ID', { id });
    const row = await this.db.query.servers.findFirst({
      where: eq(servers.id, id),
    });

    if (!row) {
      this.logger.debug('Server not found', { id });
      return null;
    }

    return toServer(row);
  }

  async findAll(): Promise<Server[]> {
    this.logger.debug('Listing all servers');
    const rows = await this.db.select().from(servers);
    return rows.map(toServer);
  }

  async save(server: Omit<Server, 'createdAt'> & { createdAt?: Date }): Promise<Server> {
    this.logger.info('Saving server', { id: server.id, name: server.name, host: server.host });

    const existing = await this.findById(server.id);
    const now = new Date();

    if (existing) {
      const updatedValues = {
        name: server.name,
        host: server.host,
        sshUser: server.sshUser ?? null,
        sshPort: server.sshPort,
        sshConfigAlias: server.sshConfigAlias ?? null,
        enabled: server.enabled,
      };

      await this.db.update(servers).set(updatedValues).where(eq(servers.id, server.id));
      const updated = await this.findById(server.id);
      if (!updated) {
        throw new Error(`Failed to retrieve server after update: ${server.id}`);
      }
      return updated;
    }

    const newServer = {
      id: server.id,
      name: server.name,
      host: server.host,
      sshUser: server.sshUser ?? null,
      sshPort: server.sshPort,
      sshConfigAlias: server.sshConfigAlias ?? null,
      enabled: server.enabled,
      createdAt: server.createdAt ?? now,
    };

    await this.db.insert(servers).values(newServer);
    const created = await this.findById(server.id);
    if (!created) {
      throw new Error(`Failed to retrieve server after insert: ${server.id}`);
    }
    return created;
  }

  async update(
    id: string,
    updates: Partial<Omit<Server, 'id' | 'createdAt'>>,
  ): Promise<Server> {
    this.logger.info('Updating server', { id, updates });

    const existing = await this.findById(id);
    if (!existing) {
      const err = new Error(`Server with id '${id}' not found`);
      this.logger.error('Failed to update server: not found', err, { id });
      throw err;
    }

    const setValues: Partial<typeof servers.$inferInsert> = {};
    if (updates.name !== undefined) setValues.name = updates.name;
    if (updates.host !== undefined) setValues.host = updates.host;
    if (updates.sshUser !== undefined) setValues.sshUser = updates.sshUser;
    if (updates.sshPort !== undefined) setValues.sshPort = updates.sshPort;
    if (updates.sshConfigAlias !== undefined) setValues.sshConfigAlias = updates.sshConfigAlias;
    if (updates.enabled !== undefined) setValues.enabled = updates.enabled;

    if (Object.keys(setValues).length > 0) {
      await this.db.update(servers).set(setValues).where(eq(servers.id, id));
    }

    const updated = await this.findById(id);
    if (!updated) {
      throw new Error(`Server '${id}' vanished during update`);
    }
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    this.logger.info('Deleting server', { id });
    try {
      const result = await this.db.delete(servers).where(eq(servers.id, id));
      const deleted = result.changes > 0;
      this.logger.debug('Server delete result', { id, deleted });
      return deleted;
    } catch (error) {
      this.logger.error('Failed to delete server', error, { id });
      throw error;
    }
  }
}
