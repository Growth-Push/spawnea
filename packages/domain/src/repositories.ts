import type { Server, Project, Agent, Session, Artifact, SessionStatus } from './index.js';
import type { ControlTurnStatus } from './control.js';
import type { SessionHistoryItem, SessionHistorySource } from './history.js';

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
  releaseChildAlias(parentId: string, alias: string): Promise<boolean>;
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
  delete(id: string, options?: { countAsClosed?: boolean }): Promise<boolean>;
}

export interface ArtifactRepository {
  findById(id: string): Promise<Artifact | null>;
  findBySessionId(sessionId: string): Promise<Artifact[]>;
  save(artifact: Omit<Artifact, 'createdAt'> & { createdAt?: Date }): Promise<Artifact>;
  delete(id: string): Promise<boolean>;
}

export interface PersistedSessionSnapshot {
  sessionId: string;
  output: string;
  truncated: boolean;
  snapshotGeneration: string;
  version: number;
  source: SessionHistorySource;
  items: SessionHistoryItem[];
  historyTruncated: boolean;
  payloadBytes: number;
  capturedAt: number;
  updatedAt: number;
}

export interface SaveSessionSnapshotInput {
  sessionId: string;
  output: string;
  source?: SessionHistorySource;
  items?: SessionHistoryItem[];
  historyTruncated?: boolean;
  capturedAt?: number;
  updatedAt?: number;
}

export type PersistedControlTurnStatus = Exclude<ControlTurnStatus, 'unchanged'>;

export interface PersistedControlTurn {
  id: string;
  sessionId: string;
  harness: string;
  prompt: string;
  output: string;
  outputGeneration: number;
  baseOffset: number;
  version: number;
  status: PersistedControlTurnStatus;
  observedWorking: boolean;
  outputChanges: number;
  promptDelimiterPairs: number;
  submissionUncertain: boolean;
  interrupted: boolean;
  truncated: boolean;
  payloadBytes: number;
  createdAt: number;
  changedAt: number;
}

export interface SaveControlTurnInput {
  id: string;
  sessionId: string;
  harness: string;
  prompt: string;
  output: string;
  outputGeneration: number;
  baseOffset: number;
  version: number;
  status: PersistedControlTurnStatus;
  observedWorking: boolean;
  outputChanges: number;
  promptDelimiterPairs: number;
  submissionUncertain?: boolean;
  interrupted?: boolean;
  truncated?: boolean;
  createdAt?: number;
  changedAt?: number;
}

export type TurnRequestDeliveryStatus = 'delivered' | 'uncertain' | 'failed';

export interface PersistedTurnRequestRecord {
  sessionId: string;
  clientRequestId: string;
  turnId: string;
  fingerprintHash: string;
  delivered: boolean;
  deliveryMethod: 'pty' | 'tmux';
  deliveryStatus: TurnRequestDeliveryStatus;
  acceptedAt: number;
  payloadBytes: number;
}

export interface SaveTurnRequestInput {
  sessionId: string;
  clientRequestId: string;
  turnId: string;
  fingerprintHash: string;
  delivered: boolean;
  deliveryMethod: 'pty' | 'tmux';
  deliveryStatus: TurnRequestDeliveryStatus;
  acceptedAt?: number;
}

export interface SessionHistoryRetentionPruneResult {
  deletedSnapshots: number;
  deletedTurns: number;
  deletedRequests: number;
  totalPayloadBytes: number;
}

export interface SessionHistoryRepository {
  upsertSnapshot(input: SaveSessionSnapshotInput): Promise<PersistedSessionSnapshot>;
  findSnapshotBySessionId(sessionId: string, nowMs?: number): Promise<PersistedSessionSnapshot | null>;
  saveTurn(input: SaveControlTurnInput): Promise<PersistedControlTurn>;
  findTurnById(turnId: string, nowMs?: number): Promise<PersistedControlTurn | null>;
  findTurnsBySessionId(sessionId: string, limit?: number, nowMs?: number): Promise<PersistedControlTurn[]>;
  markActiveTurnsInterrupted(nowMs?: number): Promise<number>;
  saveTurnRequest(input: SaveTurnRequestInput): Promise<PersistedTurnRequestRecord>;
  findTurnRequest(sessionId: string, clientRequestId: string, nowMs?: number): Promise<PersistedTurnRequestRecord | null>;
  findTurnRequestsByTurnId(turnId: string, nowMs?: number): Promise<PersistedTurnRequestRecord[]>;
  pruneExpiredAndExcess(nowMs?: number): Promise<SessionHistoryRetentionPruneResult>;
  getTotalPayloadBytes(): Promise<number>;
}
