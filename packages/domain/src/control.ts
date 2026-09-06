import type {
  CreateSessionInput,
  FinishSessionResult,
  ManagedWorktreeInspection,
  ChildSessionWorkspaceMode,
} from './ipc.js';
import type { SessionStatus } from './index.js';

export const SPAWNEA_CONTROL_API_VERSION = 'v1' as const;

export type SpawneaControlApiVersion = typeof SPAWNEA_CONTROL_API_VERSION;
export type ControlWorkspaceTab = 'terminal' | 'files' | 'diff' | 'artifacts' | 'details' | 'agent-context';

export interface ControlUiState {
  activeSessionId: string | null;
  activeTab: ControlWorkspaceTab;
}

export interface ControlSessionView {
  id: string;
  name: string;
  parentSessionId?: string;
  childAlias?: string;
  task: string;
  host: { id: string; name: string };
  project: { id: string; name: string };
  harness: { id: string; name: string; command: string };
  worktree: {
    managed: boolean;
    path: string;
    branch: string;
    baseBranch: string;
  };
  tmuxSessionName: string;
  status: SessionStatus;
  creationSource: 'ui' | 'mcp';
  active: boolean;
  activeTab?: ControlWorkspaceTab;
  createdAt: string;
  lastActivityAt: string;
}

export interface ControlErrorRecord {
  id: string;
  operation: string;
  message: string;
  occurredAt: string;
}

export interface ControlStateSnapshot {
  apiVersion: SpawneaControlApiVersion;
  ui: ControlUiState;
  sessions: ControlSessionView[];
  hosts: Array<{ id: string; name: string; enabled: boolean }>;
  projects: Array<{ id: string; name: string; hostId: string; rootPath: string; baseBranch?: string }>;
  harnesses: Array<{ id: string; name: string; command: string }>;
  recentErrors: ControlErrorRecord[];
}

export interface ControlCreateSessionItem extends CreateSessionInput {
  clientRequestId: string;
}

export interface ControlCreateSessionsRequest {
  correlationId: string;
  sessions: ControlCreateSessionItem[];
}

export type ControlCreateSessionItemResult = {
  clientRequestId: string;
  success: true;
  session: ControlSessionView;
} | {
  clientRequestId: string;
  success: false;
  error: { code: string; message: string };
};

export interface ControlCreateSessionsResult {
  apiVersion: SpawneaControlApiVersion;
  correlationId: string;
  replayed: boolean;
  results: ControlCreateSessionItemResult[];
}

export type ControlFinalizationAction = 'integrate' | 'close';
export type ControlDirtyChangesPolicy = 'stash' | 'discard';
export type ControlFinalizationStatus = 'pending' | 'executing' | 'completed' | 'rejected' | 'failed';
export type ControlFinalizationMode = 'ui-confirmation' | 'mcp-validated';
export type ControlFinalizationConfirmation = 'llm-validated';

export interface ControlFinalizationRequest {
  id: string;
  clientRequestId: string;
  sessionId: string;
  sessionName: string;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  action: ControlFinalizationAction;
  dirtyChanges?: ControlDirtyChangesPolicy;
  force?: boolean;
  /** Explicit protocol signal for a close already approved by the MCP caller's LLM. */
  mode: ControlFinalizationMode;
  status: ControlFinalizationStatus;
  createdAt: string;
  resolvedAt?: string;
  result?: FinishSessionResult;
  error?: string;
}

export interface ControlNavigationRequest {
  sessionId: string;
  parentSessionId?: string;
  tab?: ControlWorkspaceTab;
}

export interface ControlNavigationResult extends ControlUiState {
  apiVersion: SpawneaControlApiVersion;
  deliveredToRenderer: boolean;
}

export interface ControlWorktreeInspectionResult {
  apiVersion: SpawneaControlApiVersion;
  sessionId: string;
  inspection: ManagedWorktreeInspection;
}

export interface ControlRenameSessionRequest {
  sessionId: string;
  title: string;
}

export interface ControlRenameSessionResult {
  apiVersion: SpawneaControlApiVersion;
  session: ControlSessionView;
  deliveredToRenderer: boolean;
}

export interface ControlRuntimeDescriptor {
  apiVersion: SpawneaControlApiVersion;
  socketPath: string;
  token: string;
  pid: number;
  createdAt: string;
}

export interface ControlNavigateEvent extends ControlUiState {}

export interface ControlCreateChildSessionRequest {
  clientRequestId?: string;
  parentSession: string;
  name?: string;
  task: string;
  workspace: ChildSessionWorkspaceMode;
  agentId?: string;
  serverId?: string;
  projectId?: string;
  model?: string;
  initialPrompt?: string;
}

export interface ControlCreateChildSessionResult {
  apiVersion: SpawneaControlApiVersion;
  sessionCreated: true;
  parentSessionId: string;
  childAlias: string;
  sessionId: string;
  childSessionId: string;
  name: string;
  displayName: string;
  workspace: ChildSessionWorkspaceMode;
  workspaceMode: ChildSessionWorkspaceMode;
  status: SessionStatus;
  initialStatus: SessionStatus;
  startupStatus: 'starting' | 'ready' | 'needs_human' | 'failed' | 'unknown';
  promptStatus: 'not_requested' | 'launch_injected' | 'queued' | 'delivered' | 'failed';
  turnId?: string;
  replayed: boolean;
  promptError?: string;
  baseCommit?: string;
  parentBranch: string;
  parentWasDirty: boolean;
  excludedParentChanges: boolean;
}

export interface ControlAgentContextCall {
  id: string;
  operation: string;
  status: 'completed' | 'failed' | 'unchanged';
  startedAt: string;
  completedAt: string;
  repeatCount: number;
  request: unknown;
  response?: unknown;
  error?: string;
}

export interface ControlAgentContextSnapshot {
  apiVersion: SpawneaControlApiVersion;
  rootSessionId: string;
  available: boolean;
  volatileNotice: string;
  calls: ControlAgentContextCall[];
}

export interface ControlListSessionsResult {
  apiVersion: SpawneaControlApiVersion;
  sessions: ControlSessionView[];
}

export interface ControlSendPromptRequest {
  target: string;
  parentSession?: string;
  clientRequestId?: string;
  prompt: string;
}

export interface ControlSendPromptResult {
  apiVersion: SpawneaControlApiVersion;
  sessionId: string;
  delivered: boolean;
  deliveryMethod: 'pty' | 'tmux';
  acceptedAt: string;
  turnId: string;
  version: number;
  status: ControlTurnStatus;
  replayed: boolean;
  message: string;
}

export type ControlTurnStatus =
  | 'working'
  | 'needs_input'
  | 'completed'
  | 'failed'
  | 'unknown'
  | 'unchanged';

export type ControlTurnOutputMode = 'compact' | 'raw';

export interface ControlGetTurnRequest {
  turnId: string;
  cursor?: string;
  afterVersion?: number;
  waitMs?: number;
  outputMode?: ControlTurnOutputMode;
  maxBytes?: number;
}

export interface ControlGetTurnResult {
  apiVersion: SpawneaControlApiVersion;
  turnId: string;
  sessionId: string;
  status: ControlTurnStatus;
  version: number;
  cursor: string;
  output: string;
  outputMode: ControlTurnOutputMode;
  truncated: boolean;
  cursorExpired: boolean;
  extraction: 'none' | 'delimited' | 'best_effort';
  confidence: 'high' | 'medium' | 'low';
  omitted: Array<{
    adapter: string;
    rule: string;
    category: 'chrome' | 'progress' | 'tool_activity';
    lineCount: number;
  }>;
  changedAt: string;
}
