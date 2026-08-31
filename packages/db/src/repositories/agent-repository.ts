import { eq } from 'drizzle-orm';
import type { Agent, AgentRepository, Logger } from '@spawnea/domain';
import { createLogger } from '@spawnea/domain';
import type { DbClient } from '../connection.js';
import { agents } from '../schema.js';
import { toAgent } from '../mappers.js';

export class SqliteAgentRepository implements AgentRepository {
  private readonly db: DbClient;
  private readonly logger: Logger;

  constructor(db: DbClient, logger?: Logger) {
    this.db = db;
    this.logger = logger ? logger.child('agent-repo') : createLogger('db:agent-repo');
  }

  async findById(id: string): Promise<Agent | null> {
    this.logger.debug('Finding agent by ID', { id });
    const row = await this.db.query.agents.findFirst({
      where: eq(agents.id, id),
    });

    if (!row) {
      this.logger.debug('Agent not found', { id });
      return null;
    }

    return toAgent(row);
  }

  async findAll(): Promise<Agent[]> {
    this.logger.debug('Listing all agents');
    const rows = await this.db.select().from(agents);
    return rows.map(toAgent);
  }

  async save(agent: Omit<Agent, 'createdAt'> & { createdAt?: Date }): Promise<Agent> {
    this.logger.info('Saving agent', {
      id: agent.id,
      name: agent.name,
      harness: agent.harness,
      command: agent.command,
      argsTemplate: agent.argsTemplate,
      envVars: agent.envVars,
    });

    const existing = await this.findById(agent.id);
    const now = new Date();

    if (existing) {
      const updatedValues = {
        name: agent.name,
        harness: agent.harness,
        command: agent.command,
        argsTemplate: agent.argsTemplate ?? null,
        envVars: agent.envVars ?? null,
      };

      try {
        await this.db.update(agents).set(updatedValues).where(eq(agents.id, agent.id));
      } catch (error) {
        this.logger.error('Failed to update agent in database', error, { id: agent.id });
        throw error;
      }

      const updated = await this.findById(agent.id);
      if (!updated) {
        throw new Error(`Failed to retrieve agent after update: ${agent.id}`);
      }
      return updated;
    }

    const newAgent = {
      id: agent.id,
      name: agent.name,
      harness: agent.harness,
      command: agent.command,
      argsTemplate: agent.argsTemplate ?? null,
      envVars: agent.envVars ?? null,
      createdAt: agent.createdAt ?? now,
    };

    try {
      await this.db.insert(agents).values(newAgent);
    } catch (error) {
      this.logger.error('Failed to insert agent into database', error, { id: agent.id });
      throw error;
    }

    const created = await this.findById(agent.id);
    if (!created) {
      throw new Error(`Failed to retrieve agent after insert: ${agent.id}`);
    }
    return created;
  }

  async update(
    id: string,
    updates: Partial<Omit<Agent, 'id' | 'createdAt'>>,
  ): Promise<Agent> {
    this.logger.info('Updating agent', { id, updates });

    const existing = await this.findById(id);
    if (!existing) {
      const err = new Error(`Agent with id '${id}' not found`);
      this.logger.error('Failed to update agent: not found', err, { id });
      throw err;
    }

    const setValues: Partial<typeof agents.$inferInsert> = {};
    if (updates.name !== undefined) setValues.name = updates.name;
    if (updates.harness !== undefined) setValues.harness = updates.harness;
    if (updates.command !== undefined) setValues.command = updates.command;
    if (updates.argsTemplate !== undefined) setValues.argsTemplate = updates.argsTemplate ?? null;
    if (updates.envVars !== undefined) setValues.envVars = updates.envVars ?? null;

    if (Object.keys(setValues).length > 0) {
      try {
        await this.db.update(agents).set(setValues).where(eq(agents.id, id));
      } catch (error) {
        this.logger.error('Failed to apply agent updates to database', error, { id });
        throw error;
      }
    }

    const updated = await this.findById(id);
    if (!updated) {
      throw new Error(`Agent '${id}' vanished during update`);
    }
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    this.logger.info('Deleting agent', { id });
    try {
      const result = await this.db.delete(agents).where(eq(agents.id, id));
      const deleted = result.changes > 0;
      this.logger.debug('Agent delete result', { id, deleted });
      return deleted;
    } catch (error) {
      this.logger.error('Failed to delete agent', error, { id });
      throw error;
    }
  }
}
