import type {
  ServerRepository,
  ProjectRepository,
  AgentRepository,
  SessionRepository,
  ArtifactRepository,
  Logger,
} from '@spawnea/domain';
import type { DbClient } from '../connection.js';
import { SqliteServerRepository } from './server-repository.js';
import { SqliteProjectRepository } from './project-repository.js';
import { SqliteAgentRepository } from './agent-repository.js';
import { SqliteSessionRepository } from './session-repository.js';
import { SqliteArtifactRepository } from './artifact-repository.js';

export * from './server-repository.js';
export * from './project-repository.js';
export * from './agent-repository.js';
export * from './session-repository.js';
export * from './artifact-repository.js';

export interface Repositories {
  servers: ServerRepository;
  projects: ProjectRepository;
  agents: AgentRepository;
  sessions: SessionRepository;
  artifacts: ArtifactRepository;
}

export interface RepositoryOptions {
  logger?: Logger;
}

export function createRepositories(db: DbClient, options: RepositoryOptions = {}): Repositories {
  return {
    servers: new SqliteServerRepository(db, options.logger),
    projects: new SqliteProjectRepository(db, options.logger),
    agents: new SqliteAgentRepository(db, options.logger),
    sessions: new SqliteSessionRepository(db, options.logger),
    artifacts: new SqliteArtifactRepository(db, options.logger),
  };
}
