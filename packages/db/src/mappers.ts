import type { Server, Project, Agent, Session, Artifact } from '@spawnea/domain';
import type { ServerRow, ProjectRow, AgentRow, SessionRow, ArtifactRow } from './schema.js';

export function toServer(row: ServerRow): Server {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    sshUser: row.sshUser ?? undefined,
    sshPort: row.sshPort,
    sshConfigAlias: row.sshConfigAlias ?? undefined,
    enabled: row.enabled,
    createdAt: row.createdAt,
  };
}

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    rootPath: row.rootPath,
    repoUrl: row.repoUrl ?? undefined,
    baseBranch: row.baseBranch ?? undefined,
    createdAt: row.createdAt,
  };
}

export function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    harness: row.harness,
    command: row.command,
    argsTemplate: row.argsTemplate ?? undefined,
    envVars: row.envVars ?? undefined,
    createdAt: row.createdAt,
  };
}

export function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    name: row.name,
    serverId: row.serverId,
    projectId: row.projectId,
    agentId: row.agentId,
    task: row.task,
    worktreePath: row.worktreePath,
    branch: row.branch,
    baseBranch: row.baseBranch ?? undefined,
    baseCommit: row.baseCommit ?? undefined,
    managedWorktree: row.managedWorktree,
    tmuxSessionName: row.tmuxSessionName,
    tmuxWindowName: row.tmuxWindowName ?? undefined,
    status: row.status,
    creationSource: row.creationSource,
    isExternal: row.isExternal ?? false,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
  };
}

export function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    sessionId: row.sessionId,
    direction: row.direction,
    remotePath: row.remotePath,
    cachedLocalPath: row.cachedLocalPath ?? undefined,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
  };
}
