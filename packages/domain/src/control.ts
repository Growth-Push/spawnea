import type { CreateSessionInput, FinishSessionResult, ManagedWorktreeInspection } from './ipc.js';
import type { SessionStatus } from './index.js';

export const SPAWNEA_CONTROL_API_VERSION = 'v1' as const;

export type SpawneaControlApiVersion = typeof SPAWNEA_CONTROL_API_VERSION;
export type ControlWorkspaceTab = 'terminal' | 'files' | 'diff' | 'artifacts' | 'details';

export interface ControlUiState {
  activeSessionId: string | null;
  activeTab: ControlWorkspaceTab;
}

export interface ControlSessionView {
  id: string;
  name: string;
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
