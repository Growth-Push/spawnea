import { randomUUID } from 'node:crypto';
import type { Repositories } from '@spawnea/db';
import {
  SPAWNEA_CONTROL_API_VERSION,
  type ControlCreateSessionsRequest,
  type ControlCreateSessionsResult,
  type ControlErrorRecord,
  type ControlFinalizationAction,
  type ControlFinalizationConfirmation,
  type ControlFinalizationMode,
  type ControlFinalizationRequest,
  type ControlDirtyChangesPolicy,
  type ControlNavigationRequest,
  type ControlNavigationResult,
  type ControlRenameSessionRequest,
  type ControlRenameSessionResult,
  type ControlSessionView,
  type ControlStateSnapshot,
  type ControlUiState,
  type ControlWorktreeInspectionResult,
  type FinishSessionOrigin,
  type Logger,
  type Session,
} from '@spawnea/domain';
import type { SessionManager } from './session-manager.js';

interface CachedBatchResult {
  fingerprint: string;
  result: ControlCreateSessionsResult;
}

interface FinalizationInput {
  clientRequestId: string;
  sessionId: string;
  action: ControlFinalizationAction;
  dirtyChanges?: ControlDirtyChangesPolicy;
  confirmation?: ControlFinalizationConfirmation;
}

export interface AgentControlServiceOptions {
  repositories: Repositories;
  sessionManager: SessionManager;
  logger: Logger;
  notifyNavigate?: (state: ControlUiState) => boolean;
  notifyFinalizationRequested?: (request: ControlFinalizationRequest) => boolean;
  notifyDataChanged?: () => boolean;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  const message = errorMessage(error).toLowerCase();
  if (message.includes('not found')) return 'not_found';
  if (message.includes('already') || message.includes('in progress')) return 'conflict';
  if (message.includes('required') || message.includes('invalid')) return 'invalid_request';
  return 'operation_failed';
}

export class AgentControlService {
  private readonly repos: Repositories;
  private readonly sessionManager: SessionManager;
  private readonly logger: Logger;
  private readonly notifyNavigate?: (state: ControlUiState) => boolean;
  private readonly notifyFinalizationRequested?: (request: ControlFinalizationRequest) => boolean;
  private readonly notifyDataChanged?: () => boolean;
  private readonly batchResults = new Map<string, CachedBatchResult>();
  private readonly finalizationRequests = new Map<string, ControlFinalizationRequest>();
  private readonly finalizationRequestIds = new Map<string, { fingerprint: string; requestId: string }>();
  private readonly recentErrors: ControlErrorRecord[] = [];
  private uiState: ControlUiState = { activeSessionId: null, activeTab: 'terminal' };

  constructor(options: AgentControlServiceOptions) {
    this.repos = options.repositories;
    this.sessionManager = options.sessionManager;
    this.logger = options.logger;
    this.notifyNavigate = options.notifyNavigate;
    this.notifyFinalizationRequested = options.notifyFinalizationRequested;
    this.notifyDataChanged = options.notifyDataChanged;
  }

  setUiState(state: ControlUiState): void {
    this.uiState = { ...state };
  }

  private rememberError(operation: string, error: unknown): void {
    const record: ControlErrorRecord = {
      id: randomUUID(),
      operation,
      message: errorMessage(error),
      occurredAt: new Date().toISOString(),
    };
    this.recentErrors.unshift(record);
    this.recentErrors.splice(20);
    this.logger.warn('Agent control operation failed', { operation, error: record.message });
  }

  private async toSessionView(
    session: Session,
    related?: {
      hosts: Map<string, Awaited<ReturnType<Repositories['servers']['findAll']>>[number]>;
      projects: Map<string, Awaited<ReturnType<Repositories['projects']['findAll']>>[number]>;
      harnesses: Map<string, Awaited<ReturnType<Repositories['agents']['findAll']>>[number]>;
    }
  ): Promise<ControlSessionView> {
    const host = related?.hosts.get(session.serverId) ?? await this.repos.servers.findById(session.serverId);
    const project = related?.projects.get(session.projectId) ?? await this.repos.projects.findById(session.projectId);
    const harness = related?.harnesses.get(session.agentId) ?? await this.repos.agents.findById(session.agentId);
    const active = session.id === this.uiState.activeSessionId;

    return {
      id: session.id,
      name: session.name,
      task: session.task,
      host: { id: session.serverId, name: host?.name ?? session.serverId },
      project: { id: session.projectId, name: project?.name ?? session.projectId },
      harness: {
        id: session.agentId,
        name: harness?.name ?? session.agentId,
        command: harness?.command ?? 'unknown',
      },
      worktree: {
        managed: session.managedWorktree ?? false,
        path: session.worktreePath,
        branch: session.branch,
        baseBranch: session.baseBranch ?? project?.baseBranch ?? 'main',
      },
      tmuxSessionName: session.tmuxSessionName,
      status: session.status,
      creationSource: session.creationSource ?? 'ui',
      active,
      activeTab: active ? this.uiState.activeTab : undefined,
      createdAt: toIso(session.createdAt),
      lastActivityAt: toIso(session.lastActivityAt),
    };
  }

  async getState(): Promise<ControlStateSnapshot> {
    const [sessions, hosts, projects, harnesses] = await Promise.all([
      this.repos.sessions.findAll(),
      this.repos.servers.findAll(),
      this.repos.projects.findAll(),
      this.repos.agents.findAll(),
    ]);
    const related = {
      hosts: new Map(hosts.map((item) => [item.id, item])),
      projects: new Map(projects.map((item) => [item.id, item])),
      harnesses: new Map(harnesses.map((item) => [item.id, item])),
    };

    return {
      apiVersion: SPAWNEA_CONTROL_API_VERSION,
      ui: { ...this.uiState },
      sessions: await Promise.all(sessions.map((session) => this.toSessionView(session, related))),
      hosts: hosts.map((host) => ({ id: host.id, name: host.name, enabled: host.enabled })),
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        hostId: project.serverId,
        rootPath: project.rootPath,
        baseBranch: project.baseBranch,
      })),
      harnesses: harnesses.map((harness) => ({
        id: harness.id,
        name: harness.name,
        command: harness.command,
      })),
      recentErrors: this.recentErrors.map((item) => ({ ...item })),
    };
  }

  async inspectWorktree(sessionId: string): Promise<ControlWorktreeInspectionResult> {
    try {
      return {
        apiVersion: SPAWNEA_CONTROL_API_VERSION,
        sessionId,
        inspection: await this.sessionManager.inspectManagedWorktree(sessionId),
      };
    } catch (error) {
      this.rememberError('inspect_worktree', error);
      throw error;
    }
  }

  async renameSession(request: ControlRenameSessionRequest): Promise<ControlRenameSessionResult> {
    try {
      const session = await this.sessionManager.renameSession(request.sessionId, request.title);
      const sessionView = await this.toSessionView(session);
      const deliveredToRenderer = this.notifyDataChanged?.() ?? false;
      return {
        apiVersion: SPAWNEA_CONTROL_API_VERSION,
        session: sessionView,
        deliveredToRenderer,
      };
    } catch (error) {
      this.rememberError('rename_session', error);
      throw error;
    }
  }

  async createSessions(request: ControlCreateSessionsRequest): Promise<ControlCreateSessionsResult> {
    const fingerprint = JSON.stringify(request.sessions);
    const cached = this.batchResults.get(request.correlationId);
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        throw new Error(`Correlation ID '${request.correlationId}' was already used with a different payload`);
      }
      return { ...cached.result, replayed: true };
    }

    const results: ControlCreateSessionsResult['results'] = [];
    for (const item of request.sessions) {
      try {
        const session = await this.sessionManager.createSession({
          serverId: item.serverId,
          projectId: item.projectId,
          agentId: item.agentId,
          task: item.task,
          baseBranch: item.baseBranch,
          useWorktree: item.useWorktree,
        }, 'mcp');
        results.push({
          clientRequestId: item.clientRequestId,
          success: true,
          session: await this.toSessionView(session),
        });
      } catch (error) {
        this.rememberError(`create_session:${item.clientRequestId}`, error);
        results.push({
          clientRequestId: item.clientRequestId,
          success: false,
          error: { code: errorCode(error), message: errorMessage(error) },
        });
      }
    }

    const result: ControlCreateSessionsResult = {
      apiVersion: SPAWNEA_CONTROL_API_VERSION,
      correlationId: request.correlationId,
      replayed: false,
      results,
    };
    this.batchResults.set(request.correlationId, { fingerprint, result });
    if (this.batchResults.size > 100) {
      const oldestKey = this.batchResults.keys().next().value;
      if (oldestKey) this.batchResults.delete(oldestKey);
    }
    if (results.some((item) => item.success)) this.notifyDataChanged?.();
    return result;
  }

  async navigate(request: ControlNavigationRequest): Promise<ControlNavigationResult> {
    const session = await this.repos.sessions.findById(request.sessionId);
    if (!session) throw new Error(`Session '${request.sessionId}' not found`);
    const nextState: ControlUiState = {
      activeSessionId: session.id,
      activeTab: request.tab ?? this.uiState.activeTab,
    };
    this.uiState = nextState;
    const deliveredToRenderer = this.notifyNavigate?.(nextState) ?? false;
    return { apiVersion: SPAWNEA_CONTROL_API_VERSION, ...nextState, deliveredToRenderer };
  }

  private async executeFinalizationRequest(
    request: ControlFinalizationRequest,
    origin: FinishSessionOrigin
  ): Promise<void> {
    request.status = 'executing';
    try {
      const options = request.action === 'close'
        ? { stashChanges: request.dirtyChanges === 'stash' }
        : undefined;
      request.result = origin === 'mcp-validated'
        ? await this.sessionManager.finishSession(request.sessionId, request.action, options, origin)
        : await this.sessionManager.finishSession(request.sessionId, request.action, options);
      request.status = 'completed';
      request.resolvedAt = new Date().toISOString();
      this.notifyDataChanged?.();
    } catch (error) {
      request.status = 'failed';
      request.error = errorMessage(error);
      request.resolvedAt = new Date().toISOString();
      this.rememberError(`finalize_session:${request.id}`, error);
    }
  }

  async requestFinalization(input: FinalizationInput): Promise<ControlFinalizationRequest> {
    if (input.action === 'close' && !input.dirtyChanges) {
      throw new Error("Close requests must explicitly choose dirtyChanges 'stash' or 'discard'");
    }
    if (input.action === 'integrate' && input.dirtyChanges) {
      throw new Error('Integrate requests cannot specify a dirty-changes policy');
    }
    if (input.action === 'integrate' && input.confirmation) {
      throw new Error("The 'llm-validated' confirmation is only valid for close requests");
    }

    const mode: ControlFinalizationMode = input.confirmation === 'llm-validated'
      ? 'mcp-validated'
      : 'ui-confirmation';

    const fingerprint = JSON.stringify({
      sessionId: input.sessionId,
      action: input.action,
      dirtyChanges: input.dirtyChanges,
      confirmation: input.confirmation,
    });
    const existing = this.finalizationRequestIds.get(input.clientRequestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new Error(`Client request ID '${input.clientRequestId}' was already used with a different finalization request`);
      }
      return { ...this.finalizationRequests.get(existing.requestId)! };
    }

    const session = await this.repos.sessions.findById(input.sessionId);
    if (!session) throw new Error(`Session '${input.sessionId}' not found`);
    if (!session.managedWorktree) {
      throw new Error(`Session '${input.sessionId}' is not a managed worktree session`);
    }

    const request: ControlFinalizationRequest = {
      id: randomUUID(),
      clientRequestId: input.clientRequestId,
      sessionId: session.id,
      sessionName: session.name,
      branch: session.branch,
      baseBranch: session.baseBranch ?? 'main',
      worktreePath: session.worktreePath,
      action: input.action,
      dirtyChanges: input.dirtyChanges,
      mode,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.finalizationRequests.set(request.id, request);
    this.finalizationRequestIds.set(input.clientRequestId, { fingerprint, requestId: request.id });
    if (mode === 'mcp-validated') {
      await this.executeFinalizationRequest(request, 'mcp-validated');
    } else {
      this.notifyFinalizationRequested?.({ ...request });
    }
    return { ...request };
  }

  getFinalizationRequest(requestId: string): ControlFinalizationRequest {
    const request = this.finalizationRequests.get(requestId);
    if (!request) throw new Error(`Finalization request '${requestId}' not found`);
    return { ...request };
  }

  listFinalizationRequests(includeResolved = false): ControlFinalizationRequest[] {
    return Array.from(this.finalizationRequests.values())
      .filter((request) => includeResolved || request.status === 'pending' || request.status === 'executing')
      .map((request) => ({ ...request }));
  }

  async resolveFinalizationRequest(
    requestId: string,
    decision: 'approve' | 'reject'
  ): Promise<ControlFinalizationRequest> {
    const request = this.finalizationRequests.get(requestId);
    if (!request) throw new Error(`Finalization request '${requestId}' not found`);
    if (request.status !== 'pending') {
      throw new Error(`Finalization request '${requestId}' is already ${request.status}`);
    }

    request.resolvedAt = new Date().toISOString();
    if (decision === 'reject') {
      request.status = 'rejected';
      return { ...request };
    }

    await this.executeFinalizationRequest(request, 'ui');
    return { ...request };
  }
}
