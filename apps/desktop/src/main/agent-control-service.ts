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
  type ControlCreateChildSessionRequest,
  type ControlCreateChildSessionResult,
  type ControlListSessionsResult,
  type ControlSendPromptRequest,
  type ControlSendPromptResult,
  type ControlGetTurnRequest,
  type ControlGetTurnResult,
  type ControlTurnStatus,
  type ControlAgentContextCall,
  type ControlAgentContextSnapshot,
  type FinishSessionOrigin,
  type FileEntry,
  type FileContentResult,
  type GitStatusResult,
  type GitDiffResult,
  type Artifact,
  type Logger,
  type Session,
} from '@spawnea/domain';
import type { SessionManager } from './session-manager.js';
import { resolveHarnessOutputAdapter } from '@spawnea/state';

interface CachedBatchResult {
  fingerprint: string;
  result: ControlCreateSessionsResult;
}

interface CachedChildResult {
  fingerprint: string;
  result: ControlCreateChildSessionResult;
}

interface FinalizationInput {
  clientRequestId: string;
  sessionId: string;
  action: ControlFinalizationAction;
  dirtyChanges?: ControlDirtyChangesPolicy;
  confirmation?: ControlFinalizationConfirmation;
  force?: boolean;
}

interface TrackedTurn {
  id: string;
  sessionId: string;
  harness: string;
  requestIds: Map<string, { fingerprint: string; result: ControlSendPromptResult }>;
  initialSnapshot: string;
  lastSnapshot: string;
  output: string;
  baseOffset: number;
  version: number;
  status: Exclude<ControlTurnStatus, 'unchanged'>;
  changedAt: string;
  cursorExpired: boolean;
  observedWorking: boolean;
  outputChanges: number;
  promptDelimiterPairs: number;
}

const MAX_RETAINED_TURN_BYTES = 262_144;
const DEFAULT_TURN_READ_BYTES = 32_768;
const MAX_TURN_READ_BYTES = 131_072;
const MAX_TURN_WAIT_MS = 30_000;

export interface AgentControlServiceOptions {
  repositories: Repositories;
  sessionManager: SessionManager;
  logger: Logger;
  notifyNavigate?: (state: ControlUiState) => boolean;
  notifyFinalizationRequested?: (request: ControlFinalizationRequest) => boolean;
  notifyDataChanged?: () => boolean;
}

export interface ScopedAgentControlService {
  getState(): Promise<ControlStateSnapshot>;
  createSessions(request: ControlCreateSessionsRequest): Promise<ControlCreateSessionsResult>;
  inspectWorktree(sessionId: string): Promise<ControlWorktreeInspectionResult>;
  renameSession(request: ControlRenameSessionRequest): Promise<ControlRenameSessionResult>;
  createChildSession(request: ControlCreateChildSessionRequest): Promise<ControlCreateChildSessionResult>;
  listSessions(): Promise<ControlListSessionsResult>;
  sendPrompt(request: ControlSendPromptRequest): Promise<ControlSendPromptResult>;
  getTurn(request: ControlGetTurnRequest): Promise<ControlGetTurnResult>;
  listChildFiles(sessionId: string, subPath?: string): Promise<{ apiVersion: 'v1'; sessionId: string; entries: FileEntry[]; truncated: boolean }>;
  readChildFile(sessionId: string, path: string, maxBytes?: number): Promise<{ apiVersion: 'v1'; sessionId: string; file: FileContentResult }>;
  getChildGitStatus(sessionId: string): Promise<{ apiVersion: 'v1'; sessionId: string; status: GitStatusResult }>;
  getChildGitDiff(sessionId: string, filePath?: string, maxLines?: number): Promise<{ apiVersion: 'v1'; sessionId: string; diff: GitDiffResult }>;
  listChildArtifacts(sessionId: string): Promise<{ apiVersion: 'v1'; sessionId: string; artifacts: Artifact[]; truncated: boolean }>;
  navigate(request: ControlNavigationRequest): Promise<ControlNavigationResult>;
  requestFinalization(input: FinalizationInput): Promise<ControlFinalizationRequest>;
  getFinalizationRequest(requestId: string): ControlFinalizationRequest | Promise<ControlFinalizationRequest>;
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
  private readonly childResults = new Map<string, CachedChildResult>();
  private readonly childRequestsInFlight = new Map<string, { fingerprint: string; promise: Promise<ControlCreateChildSessionResult> }>();
  private readonly turns = new Map<string, TrackedTurn>();
  private readonly promptRequestIds = new Map<string, string>();
  private readonly openTurnBySession = new Map<string, string>();
  private readonly promptLocks = new Map<string, Promise<void>>();
  private readonly contextCalls = new Map<string, ControlAgentContextCall[]>();
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

  async createScopedControl(rootSessionId: string): Promise<ScopedAgentControlService> {
    const resolveInScope = async (sessionId: string, allowRoot = false): Promise<Session> => {
      const root = await this.repos.sessions.findById(rootSessionId);
      if (!root || root.parentSessionId) throw new Error('MCP session identity is not an active local root');
      const session = await this.repos.sessions.findById(sessionId);
      if (!session || (session.id !== root.id && session.parentSessionId !== root.id) || (!allowRoot && session.id === root.id)) {
        throw new Error('Session is outside the authenticated MCP scope');
      }
      return session;
    };

    const root = await this.repos.sessions.findById(rootSessionId);
    const rootServer = root ? await this.repos.servers.findById(root.serverId) : null;
    const localHost = rootServer && ['localhost', '127.0.0.1', '::1'].includes(rootServer.host);
    const active = root && !['done', 'error', 'disconnected'].includes(root.status);
    if (!root || root.parentSessionId || !rootServer?.enabled || !localHost || !active) {
      throw new Error('MCP session identity is not an active local root');
    }

    const scoped: ScopedAgentControlService = {
      getState: async () => {
        const state = await this.getState();
        const sessions = state.sessions.filter((item) => item.id === rootSessionId || item.parentSessionId === rootSessionId);
        const hostIds = new Set(sessions.map((item) => item.host?.id));
        const projectIds = new Set(sessions.map((item) => item.project?.id));
        const harnessIds = new Set(sessions.map((item) => item.harness?.id));
        return {
          ...state,
          ui: state.ui.activeSessionId && sessions.some((item) => item.id === state.ui.activeSessionId) ? state.ui : { ...state.ui, activeSessionId: null },
          sessions,
          hosts: state.hosts.filter((item) => hostIds.has(item.id)),
          projects: state.projects.filter((item) => projectIds.has(item.id)),
          harnesses: state.harnesses.filter((item) => harnessIds.has(item.id)),
          recentErrors: [],
        };
      },
      createSessions: async () => {
        throw new Error('Batch session creation is not available through scoped MCP');
      },
      inspectWorktree: async (sessionId) => {
        await resolveInScope(sessionId, true);
        return this.inspectWorktree(sessionId);
      },
      renameSession: async (request) => {
        await resolveInScope(request.sessionId, true);
        return this.renameSession(request);
      },
      createChildSession: async (request) => {
        await resolveInScope(request.parentSession, true);
        return this.createChildSession(request);
      },
      listSessions: async () => {
        const state = await this.getState();
        return { apiVersion: state.apiVersion, sessions: state.sessions.filter((item) => item.id === rootSessionId || item.parentSessionId === rootSessionId) };
      },
      sendPrompt: async (request) => {
        let target = await this.repos.sessions.findById(request.target);
        if (!target && request.parentSession) target = await this.repos.sessions.findByParentAndAlias(request.parentSession, request.target);
        if (!target) throw new Error('Session is outside the authenticated MCP scope');
        await resolveInScope(target.id, true);
        return this.sendPrompt({ ...request, target: target.id });
      },
      getTurn: async (request) => {
        const turn = this.turns.get(request.turnId);
        if (!turn) throw new Error(`Turn '${request.turnId}' not found`);
        await resolveInScope(turn.sessionId, true);
        return this.getTurn(request);
      },
      listChildFiles: async (sessionId, subPath) => {
        await resolveInScope(sessionId);
        return this.listChildFiles(sessionId, subPath);
      },
      readChildFile: async (sessionId, path, maxBytes) => {
        await resolveInScope(sessionId);
        return this.readChildFile(sessionId, path, maxBytes);
      },
      getChildGitStatus: async (sessionId) => {
        await resolveInScope(sessionId);
        return this.getChildGitStatus(sessionId);
      },
      getChildGitDiff: async (sessionId, filePath, maxLines) => {
        await resolveInScope(sessionId);
        return this.getChildGitDiff(sessionId, filePath, maxLines);
      },
      listChildArtifacts: async (sessionId) => {
        await resolveInScope(sessionId);
        return this.listChildArtifacts(sessionId);
      },
      navigate: async (request) => {
        let target = await this.repos.sessions.findById(request.sessionId);
        if (!target && request.parentSessionId) target = await this.repos.sessions.findByParentAndAlias(request.parentSessionId, request.sessionId);
        if (!target) throw new Error('Session is outside the authenticated MCP scope');
        await resolveInScope(target.id, true);
        return this.navigate({ ...request, sessionId: target.id });
      },
      requestFinalization: async (input) => {
        await resolveInScope(input.sessionId);
        return this.requestFinalization(input);
      },
      getFinalizationRequest: async (requestId) => {
        const request = this.getFinalizationRequest(requestId);
        await resolveInScope(request.sessionId);
        return request;
      },
    };
    return this.withCallRecording(rootSessionId, scoped);
  }

  private boundedContextValue(value: unknown): unknown {
    const secretKey = /(token|password|secret|credential|private.?key|authorization)/i;
    const secretValue = /(-----BEGIN (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b)/g;
    const redact = (input: unknown, depth: number): unknown => {
      if (depth > 8) return '[TRUNCATED]';
      if (Array.isArray(input)) return input.slice(0, 100).map((item) => redact(item, depth + 1));
      if (input && typeof input === 'object') {
        return Object.fromEntries(Object.entries(input as Record<string, unknown>).slice(0, 100).map(([key, item]) => [
          key,
          secretKey.test(key) ? '[REDACTED]' : redact(item, depth + 1),
        ]));
      }
      if (typeof input === 'string') {
        const redacted = input.replace(secretValue, '[REDACTED]');
        return redacted.length > 32_768 ? `${redacted.slice(0, 32_768)}\n[TRUNCATED]` : redacted;
      }
      return input;
    };
    return redact(value, 0);
  }

  private withCallRecording(rootSessionId: string, control: ScopedAgentControlService): ScopedAgentControlService {
    return new Proxy(control, {
      get: (target, property, receiver) => {
        const original = Reflect.get(target, property, receiver);
        if (typeof original !== 'function') return original;
        return async (...args: unknown[]) => {
          const startedAt = new Date().toISOString();
          try {
            const response = await original(...args);
            this.recordContextCall(rootSessionId, String(property), args, response, startedAt);
            return response;
          } catch (error) {
            this.recordContextCall(rootSessionId, String(property), args, undefined, startedAt, errorMessage(error));
            throw error;
          }
        };
      },
    });
  }

  private recordContextCall(rootSessionId: string, operation: string, request: unknown, response: unknown, startedAt: string, error?: string): void {
    const calls = this.contextCalls.get(rootSessionId) ?? [];
    const unchanged = operation === 'getTurn' && (response as { status?: string } | undefined)?.status === 'unchanged';
    const prior = calls.at(-1);
    if (unchanged && prior?.operation === operation && prior.status === 'unchanged') {
      prior.repeatCount += 1;
      prior.completedAt = new Date().toISOString();
      prior.response = this.boundedContextValue(response);
    } else {
      calls.push({
        id: randomUUID(),
        operation,
        status: error ? 'failed' : unchanged ? 'unchanged' : 'completed',
        startedAt,
        completedAt: new Date().toISOString(),
        repeatCount: 1,
        request: this.boundedContextValue(request),
        response: error ? undefined : this.boundedContextValue(response),
        error: error ? String(this.boundedContextValue(error)) : undefined,
      });
    }
    if (calls.length > 200) calls.splice(0, calls.length - 200);
    this.contextCalls.set(rootSessionId, calls);
    this.notifyDataChanged?.();
  }

  async getAgentContext(sessionId: string): Promise<ControlAgentContextSnapshot> {
    const session = await this.repos.sessions.findById(sessionId);
    if (!session) throw new Error(`Session '${sessionId}' not found`);
    const rootSessionId = session.parentSessionId ?? session.id;
    const calls = this.contextCalls.get(rootSessionId);
    return {
      apiVersion: SPAWNEA_CONTROL_API_VERSION,
      rootSessionId,
      available: Boolean(calls),
      volatileNotice: calls
        ? 'Context is volatile and remains available only until Spawnea restarts.'
        : 'Prior volatile MCP context is unavailable. Spawnea does not persist orchestration transcripts.',
      calls: calls?.map((call) => ({ ...call })) ?? [],
    };
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
      parentSessionId: session.parentSessionId ?? undefined,
      childAlias: session.childAlias ?? undefined,
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

  async listSessions(): Promise<ControlListSessionsResult> {
    const snapshot = await this.getState();
    return {
      apiVersion: SPAWNEA_CONTROL_API_VERSION,
      sessions: snapshot.sessions,
    };
  }

  async createChildSession(request: ControlCreateChildSessionRequest): Promise<ControlCreateChildSessionResult> {
    const requestId = request.clientRequestId ?? randomUUID();
    const inflightKey = `${request.parentSession}:${requestId}`;
    const fingerprint = JSON.stringify({ ...request, clientRequestId: undefined });
    const inflight = this.childRequestsInFlight.get(inflightKey);
    if (inflight) {
      if (inflight.fingerprint !== fingerprint) throw new Error(`Client request ID '${requestId}' was already used with a different child request`);
      return { ...(await inflight.promise), replayed: true };
    }
    const operation = this.createChildSessionInternal(request, requestId);
    this.childRequestsInFlight.set(inflightKey, { fingerprint, promise: operation });
    try {
      return await operation;
    } finally {
      this.childRequestsInFlight.delete(inflightKey);
    }
  }

  private async createChildSessionInternal(request: ControlCreateChildSessionRequest, requestId: string): Promise<ControlCreateChildSessionResult> {
    try {
      const fingerprint = JSON.stringify({ ...request, clientRequestId: undefined });
      const cacheKey = `${request.parentSession}:${requestId}`;
      const cached = this.childResults.get(cacheKey);
      if (cached) {
        if (cached.fingerprint !== fingerprint) {
          throw new Error(`Client request ID '${requestId}' was already used with a different child request`);
        }
        return { ...cached.result, replayed: true };
      }
      const parent = await this.repos.sessions.findById(request.parentSession);
      if (!parent) {
        throw new Error(`Parent session '${request.parentSession}' not found`);
      }
      if (parent.parentSessionId) {
        throw new Error('A child session cannot be used as a parent session');
      }
      const parentStatus = await this.sessionManager.getGitStatus(parent.id).catch(() => undefined);

      const child = await this.sessionManager.createChildSession(
        {
          parentSessionId: parent.id,
          name: request.name,
          task: request.task,
          workspace: request.workspace,
          agentId: request.agentId,
          serverId: request.serverId,
          projectId: request.projectId,
          model: request.model,
        },
        'mcp',
      );

      this.notifyDataChanged?.();

      let promptStatus: ControlCreateChildSessionResult['promptStatus'] = 'not_requested';
      let turnId: string | undefined;
      let promptError: string | undefined;
      if (request.initialPrompt) {
        promptStatus = 'queued';
        try {
          const sent = await this.sendPrompt({
            target: child.id,
            parentSession: parent.id,
            clientRequestId: `${requestId}:initial-prompt`,
            prompt: request.initialPrompt,
          });
          promptStatus = 'delivered';
          turnId = sent.turnId;
        } catch (error) {
          promptStatus = 'failed';
          promptError = errorMessage(error);
        }
      }
      const currentChild = await this.repos.sessions.findById(child.id);
      const reportedChild = currentChild ?? child;
      const result: ControlCreateChildSessionResult = {
        apiVersion: SPAWNEA_CONTROL_API_VERSION,
        sessionCreated: true,
        parentSessionId: parent.id,
        childAlias: child.childAlias || '',
        sessionId: child.id,
        childSessionId: child.id,
        name: child.name,
        displayName: child.name,
        workspace: request.workspace,
        workspaceMode: request.workspace,
        status: reportedChild.status,
        initialStatus: reportedChild.status,
        startupStatus: reportedChild.status === 'starting'
          ? 'starting'
          : reportedChild.status === 'error' || reportedChild.status === 'disconnected' || reportedChild.status === 'done'
            ? 'failed'
            : reportedChild.status === 'needs_input'
              ? 'needs_human'
              : reportedChild.status === 'working' || reportedChild.status === 'idle'
                ? 'ready'
                : 'unknown',
        promptStatus,
        turnId,
        replayed: false,
        promptError,
        baseCommit: child.baseCommit,
        parentBranch: parentStatus?.branch || parent.branch,
        parentWasDirty: parentStatus ? !parentStatus.isClean : false,
        excludedParentChanges: request.workspace === 'new-worktree' && Boolean(parentStatus && !parentStatus.isClean),
      };
      this.childResults.set(cacheKey, { fingerprint, result });
      if (this.childResults.size > 200) {
        const oldest = this.childResults.keys().next().value;
        if (oldest) this.childResults.delete(oldest);
      }
      return result;
    } catch (error) {
      this.rememberError('create_child_session', error);
      throw error;
    }
  }

  async sendPrompt(request: ControlSendPromptRequest): Promise<ControlSendPromptResult> {
    const lockKey = `${request.parentSession ?? ''}:${request.target}`;
    const previous = this.promptLocks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.promptLocks.set(lockKey, queued);
    await previous;
    try {
      return await this.sendPromptUnlocked(request);
    } finally {
      release();
      if (this.promptLocks.get(lockKey) === queued) this.promptLocks.delete(lockKey);
    }
  }

  private async sendPromptUnlocked(request: ControlSendPromptRequest): Promise<ControlSendPromptResult> {
    try {
      let targetSession = await this.repos.sessions.findById(request.target);
      if (!targetSession) {
        if (request.parentSession) {
          targetSession = await this.repos.sessions.findByParentAndAlias(
            request.parentSession,
            request.target,
          );
        } else if (request.target.startsWith('child-')) {
          const all = await this.repos.sessions.findAll();
          const matches = all.filter((s) => s.childAlias === request.target);
          if (matches.length === 1) {
            targetSession = matches[0];
          } else if (matches.length > 1) {
            throw new Error(
              `Multiple sessions match alias '${request.target}'. Specify parentSession to disambiguate.`,
            );
          }
        }
      }

      if (!targetSession) {
        throw new Error(`Session '${request.target}' not found`);
      }

      const requestId = request.clientRequestId ?? randomUUID();
      const fingerprint = JSON.stringify({ sessionId: targetSession.id, prompt: request.prompt });
      const promptCacheKey = `${targetSession.id}:${requestId}`;
      const cachedTurnId = this.promptRequestIds.get(promptCacheKey);
      if (cachedTurnId) {
        const cachedTurn = this.turns.get(cachedTurnId);
        const replay = cachedTurn?.requestIds.get(requestId);
        if (replay) {
          if (replay.fingerprint !== fingerprint) throw new Error(`Client request ID '${requestId}' was already used with a different prompt`);
          return { ...replay.result, replayed: true };
        }
      }
      targetSession = await this.waitForPromptReady(targetSession.id);
      const existingTurnId = this.openTurnBySession.get(targetSession.id);
      let turn = existingTurnId ? this.turns.get(existingTurnId) : undefined;
      let createdTurn = false;
      if (turn) {
        await this.refreshTurn(turn);
        const replay = turn.requestIds.get(requestId);
        if (replay) {
          if (replay.fingerprint !== fingerprint) {
            throw new Error(`Client request ID '${requestId}' was already used with a different prompt`);
          }
          return { ...replay.result, replayed: true };
        }
        if (turn.status === 'completed' || turn.status === 'failed') {
          this.openTurnBySession.delete(targetSession.id);
          turn = undefined;
        } else if (turn.status !== 'needs_input') {
          throw new Error(`Session '${targetSession.id}' already has an open turn`);
        }
      }
      if (!turn) {
        const now = new Date().toISOString();
        const agent = await this.repos.agents.findById(targetSession.agentId);
        turn = {
          id: randomUUID(),
          sessionId: targetSession.id,
          harness: agent?.harness ?? agent?.command ?? 'generic',
          requestIds: new Map(),
          initialSnapshot: await this.sessionManager.captureSessionTerminal(targetSession.id),
          lastSnapshot: '',
          output: '',
          baseOffset: 0,
          version: 1,
          status: 'working',
          changedAt: now,
          cursorExpired: false,
          observedWorking: false,
          outputChanges: 0,
          promptDelimiterPairs: (request.prompt.match(/<<<SPAWNEA_RESPONSE_BEGIN>>>[\s\S]*?<<<SPAWNEA_RESPONSE_END>>>/g) ?? []).length,
        };
        turn.lastSnapshot = turn.initialSnapshot;
        this.turns.set(turn.id, turn);
        this.openTurnBySession.set(targetSession.id, turn.id);
        createdTurn = true;
      }

      if (!turn) throw new Error(`Failed to create a turn for session '${targetSession.id}'`);

      let result: Awaited<ReturnType<SessionManager['sendPrompt']>>;
      try {
        result = await this.sessionManager.sendPrompt(targetSession.id, request.prompt);
      } catch (error) {
        if (createdTurn) {
          this.turns.delete(turn.id);
          this.openTurnBySession.delete(targetSession.id);
        }
        throw error;
      }
      if (!result.delivered && createdTurn) {
        this.turns.delete(turn.id);
        this.openTurnBySession.delete(targetSession.id);
        throw new Error(`Prompt was not delivered to session '${targetSession.id}'`);
      }
      turn.status = 'working';
      turn.version += 1;
      turn.changedAt = new Date().toISOString();
      const response: ControlSendPromptResult = {
        apiVersion: SPAWNEA_CONTROL_API_VERSION,
        sessionId: targetSession.id,
        delivered: result.delivered,
        deliveryMethod: result.deliveryMethod,
        acceptedAt: new Date().toISOString(),
        turnId: turn.id,
        version: turn.version,
        status: turn.status,
        replayed: false,
        message: 'Prompt submitted. Use spawnea_get_turn to read or wait for the response.',
      };
      turn.requestIds.set(requestId, { fingerprint, result: response });
      this.promptRequestIds.set(promptCacheKey, turn.id);
      if (this.promptRequestIds.size > 500) {
        const oldest = this.promptRequestIds.keys().next().value;
        if (oldest) this.promptRequestIds.delete(oldest);
      }
      if (this.turns.size > 200) {
        const evictable = Array.from(this.turns.values()).find((candidate) => !this.openTurnBySession.has(candidate.sessionId));
        if (evictable) this.turns.delete(evictable.id);
      }
      return response;
    } catch (error) {
      this.rememberError('send_prompt', error);
      throw error;
    }
  }

  private async waitForPromptReady(sessionId: string, waitMs = 20_000): Promise<Session> {
    const deadline = Date.now() + waitMs;
    while (true) {
      const session = await this.repos.sessions.findById(sessionId);
      if (!session) throw new Error(`Session '${sessionId}' not found`);
      if (session.status !== 'starting') {
        if (session.status === 'error' || session.status === 'disconnected' || session.status === 'done') {
          throw new Error(`Session '${sessionId}' is not available for prompt delivery (${session.status})`);
        }
        return session;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Session '${sessionId}' did not become ready before prompt delivery timeout`);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
    }
  }

  private terminalOutputSince(initial: string, current: string): string {
    if (current.startsWith(initial)) return current.slice(initial.length);
    let prefix = 0;
    const limit = Math.min(initial.length, current.length);
    while (prefix < limit && initial.charCodeAt(prefix) === current.charCodeAt(prefix)) prefix += 1;
    // A redraw can replace a line in the middle. Returning the bounded suffix
    // after the stable prefix avoids quadratic diffing on the main thread.
    return current.slice(prefix);
  }

  private async refreshTurn(turn: TrackedTurn): Promise<void> {
    const [snapshot, session] = await Promise.all([
      this.sessionManager.captureSessionTerminal(turn.sessionId),
      this.repos.sessions.findById(turn.sessionId),
    ]);
    if (!session) throw new Error(`Session '${turn.sessionId}' not found`);
    const nextOutput = this.terminalOutputSince(turn.initialSnapshot, snapshot);
    if (session.status === 'working' || session.status === 'starting') turn.observedWorking = true;
    const delimiterPairs = (nextOutput.match(/<<<SPAWNEA_RESPONSE_BEGIN>>>[\s\S]*?<<<SPAWNEA_RESPONSE_END>>>/g) ?? []).length;
    const hasResponseDelimiter = delimiterPairs > turn.promptDelimiterPairs;
    const nextStatus: Exclude<ControlTurnStatus, 'unchanged'> = session.status === 'needs_input'
      ? 'needs_input'
      : session.status === 'done' || ((session.status === 'idle') && (turn.observedWorking || turn.outputChanges > 0 || hasResponseDelimiter))
        ? 'completed'
        : session.status === 'error' || session.status === 'disconnected'
          ? 'failed'
          : session.status === 'starting' || session.status === 'working'
            ? 'working'
            : 'unknown';
    const outputChanged = nextOutput !== turn.output;
    if (outputChanged || nextStatus !== turn.status) {
      if (outputChanged) {
        const oldOutput = turn.output;
        if (oldOutput && !nextOutput.startsWith(oldOutput)) {
          turn.baseOffset += Buffer.byteLength(oldOutput, 'utf8');
          turn.cursorExpired = true;
        }
        turn.output = nextOutput;
        turn.outputChanges += 1;
      }
      const byteLength = Buffer.byteLength(turn.output, 'utf8');
      if (byteLength > MAX_RETAINED_TURN_BYTES) {
        const excess = byteLength - MAX_RETAINED_TURN_BYTES;
        turn.output = Buffer.from(turn.output, 'utf8').subarray(excess).toString('utf8');
        turn.baseOffset += excess;
        turn.cursorExpired = true;
      }
      turn.status = nextStatus;
      turn.version += 1;
      turn.changedAt = new Date().toISOString();
      if (nextStatus === 'completed' || nextStatus === 'failed') {
        this.openTurnBySession.delete(turn.sessionId);
      }
    }
    turn.lastSnapshot = snapshot;
  }

  private cursorOffset(turn: TrackedTurn, cursor?: string): { offset: number; expired: boolean } {
    if (!cursor) return { offset: turn.baseOffset, expired: turn.cursorExpired };
    const [turnId, rawOffset] = cursor.split(':');
    const offset = Number(rawOffset);
    if (turnId !== turn.id || !Number.isSafeInteger(offset) || offset < turn.baseOffset) {
      return { offset: turn.baseOffset, expired: true };
    }
    return { offset, expired: turn.cursorExpired };
  }

  async getTurn(request: ControlGetTurnRequest): Promise<ControlGetTurnResult> {
    const turn = this.turns.get(request.turnId);
    if (!turn) throw new Error(`Turn '${request.turnId}' not found`);
    const waitMs = Math.min(Math.max(request.waitMs ?? 0, 0), MAX_TURN_WAIT_MS);
    const deadline = Date.now() + waitMs;
    do {
      await this.refreshTurn(turn);
      if (request.afterVersion === undefined || turn.version > request.afterVersion || turn.status === 'needs_input' || turn.status === 'completed' || turn.status === 'failed') break;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(750, deadline - Date.now())));
    } while (Date.now() <= deadline);

      const cursor = this.cursorOffset(turn, request.cursor);
    const retainedEnd = turn.baseOffset + Buffer.byteLength(turn.output, 'utf8');
    if (cursor.offset > retainedEnd) {
      cursor.offset = retainedEnd;
      cursor.expired = true;
    }
    const relativeOffset = Math.max(0, cursor.offset - turn.baseOffset);
    const available = Buffer.from(turn.output, 'utf8').subarray(relativeOffset);
    const unchanged = request.afterVersion !== undefined && turn.version <= request.afterVersion && available.length === 0;
    const maxBytes = Math.min(request.maxBytes ?? DEFAULT_TURN_READ_BYTES, MAX_TURN_READ_BYTES);
    let chunkLength = Math.min(available.length, maxBytes);
    while (chunkLength > 0 && chunkLength < available.length && (available[chunkLength] & 0xc0) === 0x80) chunkLength -= 1;
    const chunk = available.subarray(0, chunkLength);
    const nextOffset = cursor.offset + chunk.length;
    const rawOutput = chunk.toString('utf8');
    const outputMode = request.outputMode ?? 'compact';
    const compacted = outputMode === 'compact'
      ? resolveHarnessOutputAdapter(turn.harness).compact(rawOutput)
      : { output: rawOutput, omitted: [] };
    const delimiterMatches = rawOutput.match(/<<<SPAWNEA_RESPONSE_BEGIN>>>[\s\S]*?<<<SPAWNEA_RESPONSE_END>>>/g) ?? [];
    const delimited = request.cursor ? delimiterMatches.length > 0 : delimiterMatches.length > turn.promptDelimiterPairs;
    const selectedDelimiter = request.cursor ? delimiterMatches.at(-1) : delimiterMatches[turn.promptDelimiterPairs];
    const delimitedOutput = delimited
      ? selectedDelimiter
        ?.replace(/^<<<SPAWNEA_RESPONSE_BEGIN>>>\s*/, '')
        .replace(/\s*<<<SPAWNEA_RESPONSE_END>>>$/, '')
      : undefined;
    const extracted = delimitedOutput ?? compacted.output;
    const extractedBytes = Buffer.byteLength(extracted, 'utf8');
    const output = outputMode === 'compact' ? Buffer.from(extracted, 'utf8').subarray(0, maxBytes).toString('utf8') : compacted.output;
    return {
      apiVersion: SPAWNEA_CONTROL_API_VERSION,
      turnId: turn.id,
      sessionId: turn.sessionId,
      status: unchanged ? 'unchanged' : turn.status,
      version: turn.version,
      cursor: `${turn.id}:${nextOffset}`,
      output: unchanged ? '' : output,
      outputMode,
      truncated: available.length > maxBytes || extractedBytes > maxBytes,
      cursorExpired: cursor.expired,
      extraction: delimited ? 'delimited' : turn.status === 'completed' ? 'best_effort' : 'none',
      confidence: delimited ? 'high' : turn.status === 'completed' ? 'medium' : 'low',
      omitted: compacted.omitted,
      changedAt: turn.changedAt,
    };
  }

  async listChildFiles(sessionId: string, subPath?: string) {
    const entries = await this.sessionManager.listFiles(sessionId, subPath);
    return { apiVersion: SPAWNEA_CONTROL_API_VERSION, sessionId, entries: entries.slice(0, 500), truncated: entries.length > 500 };
  }

  async readChildFile(sessionId: string, path: string, maxBytes = 65_536) {
    const file = await this.sessionManager.readFile(sessionId, path, Math.min(Math.max(maxBytes, 1), 131_072));
    return { apiVersion: SPAWNEA_CONTROL_API_VERSION, sessionId, file };
  }

  async getChildGitStatus(sessionId: string) {
    return { apiVersion: SPAWNEA_CONTROL_API_VERSION, sessionId, status: await this.sessionManager.getGitStatus(sessionId) };
  }

  async getChildGitDiff(sessionId: string, filePath?: string, maxLines = 2_000) {
    const session = await this.repos.sessions.findById(sessionId);
    if (!session) throw new Error(`Session '${sessionId}' not found`);
    const diff = await this.sessionManager.getGitDiff(sessionId, {
      filePath,
      baseCommit: session.managedWorktree ? session.baseCommit : undefined,
      maxLines: Math.min(Math.max(maxLines, 1), 10_000),
    });
    return { apiVersion: SPAWNEA_CONTROL_API_VERSION, sessionId, diff };
  }

  async listChildArtifacts(sessionId: string) {
    const artifacts = await this.repos.artifacts.findBySessionId(sessionId);
    return { apiVersion: SPAWNEA_CONTROL_API_VERSION, sessionId, artifacts: artifacts.slice(0, 200), truncated: artifacts.length > 200 };
  }

  async navigate(request: ControlNavigationRequest): Promise<ControlNavigationResult> {
    let session = await this.repos.sessions.findById(request.sessionId);
    if (!session) {
      if (request.parentSessionId) {
        session = await this.repos.sessions.findByParentAndAlias(
          request.parentSessionId,
          request.sessionId
        );
      } else if (request.sessionId.startsWith('child-')) {
        const all = await this.repos.sessions.findAll();
        const matches = all.filter((s) => s.childAlias === request.sessionId);
        if (matches.length === 1) {
          session = matches[0];
        } else if (matches.length > 1) {
          throw new Error(
            `Multiple sessions match alias '${request.sessionId}'. Specify the session ID or parentSessionId to disambiguate.`
          );
        }
      }
    }
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
      force: input.force,
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
    if (input.action === 'integrate' && session.parentSessionId) {
      const server = await this.repos.servers.findById(session.serverId);
      const parent = session.parentSessionId ? await this.repos.sessions.findById(session.parentSessionId) : undefined;
      if (!server || !['localhost', '127.0.0.1', '::1'].includes(server.host) || !parent || parent.serverId !== session.serverId) {
        throw new Error('Remote child integration is unsupported; inspect evidence or close the child instead');
      }
    }
    if (input.action === 'close' && session.parentSessionId && (session.status === 'working' || session.status === 'starting') && !input.force) {
      throw new Error("Closing a working child requires force=true");
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
      force: input.force,
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
