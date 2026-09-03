import type { Server, Project, Agent, Session, Artifact, SessionStatus } from './index.js';

export interface ServerRepository {
  findById(id: string): Promise<Server | null>;
  findAll(): Promise<Server[]>;
  save(server: Omit<Server, 'createdAt'> & { createdAt?: Date }): Promise<Server>;
  update(id: string, updates: Partial<Omit<Server, 'id' | 'createdAt'>>): Promise<Server>;
  delete(id: string): Promise<boolean>;
}

export interface ProjectRepository {
  findById(id: string): Promise<Project | null>;
  findAll(): Promise<Project[]>;
  findByServerId(serverId: string): Promise<Project[]>;
  save(project: Omit<Project, 'createdAt'> & { createdAt?: Date }): Promise<Project>;
  update(id: string, updates: Partial<Omit<Project, 'id' | 'serverId' | 'createdAt'>>): Promise<Project>;
  delete(id: string): Promise<boolean>;
}

export interface AgentRepository {
  findById(id: string): Promise<Agent | null>;
  findAll(): Promise<Agent[]>;
  save(agent: Omit<Agent, 'createdAt'> & { createdAt?: Date }): Promise<Agent>;
  update(id: string, updates: Partial<Omit<Agent, 'id' | 'createdAt'>>): Promise<Agent>;
  delete(id: string): Promise<boolean>;
}

export interface SessionRepository {
  findById(id: string): Promise<Session | null>;
  findAll(): Promise<Session[]>;
  findByServerId(serverId: string): Promise<Session[]>;
  findByProjectId(projectId: string): Promise<Session[]>;
  findByAgentId(agentId: string): Promise<Session[]>;
  findByStatus(status: SessionStatus): Promise<Session[]>;
  findByParentId(parentId: string): Promise<Session[]>;
  findByParentAndAlias(parentId: string, childAlias: string): Promise<Session | null>;
  allocateChildAlias(parentId: string): Promise<string>;
  promoteChildrenToRoot(parentId: string): Promise<number>;
  clearParentReferences(parentId: string): Promise<number>;
  save(
    session: Omit<Session, 'createdAt' | 'lastActivityAt'> & {
      createdAt?: Date;
      lastActivityAt?: Date;
    },
  ): Promise<Session>;
  update(id: string, updates: Partial<Omit<Session, 'id' | 'createdAt'>>): Promise<Session>;
  updateStatus(id: string, status: SessionStatus, lastActivityAt?: Date): Promise<Session>;
  delete(id: string): Promise<boolean>;
}

export interface ArtifactRepository {
  findById(id: string): Promise<Artifact | null>;
  findBySessionId(sessionId: string): Promise<Artifact[]>;
  save(artifact: Omit<Artifact, 'createdAt'> & { createdAt?: Date }): Promise<Artifact>;
  delete(id: string): Promise<boolean>;
}
