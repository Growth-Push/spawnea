import type {
  Server,
  Project,
  Agent,
  Session,
  Artifact,
  FileEntry,
  SessionStatus,
  CatalogState,
  CatalogReloadResult,
  GitBranchDiscoveryResult,
  HostTestResult,
  HostSystemInfo,
  HostConnectionEndpoint,
  DiscoveredTmuxSession,
  AdoptSessionInput,
  StateFeedbackSnapshot,
  StateFeedbackReport,
  StateFeedbackResult,
  ControlFinalizationRequest,
} from './index.js';

export interface CreateSessionInput {
  serverId: string;
  projectId: string;
  agentId: string;
  task: string;
  baseBranch?: string;
  useWorktree?: boolean;
}

export interface AddProjectToCatalogInput {
  serverId: string;
  projectId: string;
  name: string;
  path: string;
  gitUrl?: string;
  baseBranch?: string;
}

export interface LocalHostDiscoverySuggestion {
  key: string;
  alias: string;
  address: string;
  suggestedHostId: string;
  suggestedName: string;
}

export type LocalHarnessCandidateId = 'claude' | 'codex' | 'hermes' | 'opencode' | 'shell';

export interface LocalHarnessDiscoverySuggestion {
  candidateId: LocalHarnessCandidateId;
  name: string;
  command: string;
  found: boolean;
  resolvedPath?: string;
}

export interface LocalDiscoveryScanResult {
  scanId: string;
  hosts: LocalHostDiscoverySuggestion[];
  harnesses: LocalHarnessDiscoverySuggestion[];
  localHosts: Array<{ id: string; name: string }>;
  warnings: string[];
}

export interface LocalDiscoverySelection {
  scanId: string;
  hosts: Array<{
    suggestionKey: string;
    hostId: string;
    name: string;
    user?: string;
    port?: number;
    mode: 'add' | 'update';
  }>;
  harnesses: Array<{
    candidateId: LocalHarnessCandidateId;
    hostId: string;
    harnessId: string;
    name: string;
    mode: 'add' | 'update';
  }>;
}

export interface LocalDiscoveryPreviewChange {
  operation: 'add' | 'update';
  path: string;
  before?: unknown;
  after: unknown;
}

export interface LocalDiscoveryPreviewResult {
  success: boolean;
  previewId?: string;
  changes: LocalDiscoveryPreviewChange[];
  errors: string[];
}

export interface LocalDiscoveryApplyResult extends CatalogReloadResult {
  conflict?: boolean;
}

export type FinishSessionAction = 'integrate' | 'ignore' | 'close';

/** Identifies who authorized the finalization invocation inside Main. */
export type FinishSessionOrigin = 'ui' | 'mcp-validated';

export interface FinishSessionOptions {
  /** Preserve dirty worktree contents in a named Git stash before closing. */
  stashChanges?: boolean;
}

export type ManagedWorktreeInspectionState = 'active' | 'integrated' | 'mismatch' | 'missing' | 'unavailable';

export interface ManagedWorktreeInspection {
  state: ManagedWorktreeInspectionState;
  currentBranch?: string;
  /** Normal Git cleanliness; ignored-only files do not make this false. */
  isClean?: boolean;
  message: string;
}

export interface FinishSessionResult {
  action: FinishSessionAction;
  removed: boolean;
}

export interface IpcChannels {
  // Operational Catalog
  'catalog:get': () => Promise<CatalogState>;
  'catalog:reload': () => Promise<CatalogReloadResult>;
  'catalog:addProject': (input: AddProjectToCatalogInput) => Promise<CatalogReloadResult>;

  // Explicit, local-only discovery. No scan runs until the renderer invokes it.
  'localDiscovery:scan': () => Promise<LocalDiscoveryScanResult>;
  'localDiscovery:preview': (input: LocalDiscoverySelection) => Promise<LocalDiscoveryPreviewResult>;
  'localDiscovery:apply': (previewId: string) => Promise<LocalDiscoveryApplyResult>;

  // Server Management
  'servers:list': () => Promise<Server[]>;
  'servers:save': (server: Omit<Server, 'createdAt'>) => Promise<Server>;
  'servers:delete': (id: string) => Promise<void>;
  'servers:test': (id: string) => Promise<HostTestResult>;
  'hosts:getSystemInfo': (serverId: string) => Promise<HostSystemInfo | null>;
  'hosts:getConnectionEndpoint': (serverId: string) => Promise<HostConnectionEndpoint | null>;
  'hosts:discoverExternalSessions': (serverId: string) => Promise<DiscoveredTmuxSession[]>;

  // Project Management
  'projects:list': (serverId?: string) => Promise<Project[]>;
  'projects:save': (project: Omit<Project, 'createdAt'>) => Promise<Project>;
  'projects:delete': (id: string) => Promise<void>;
  'projects:discoverBranches': (
    serverId: string,
    projectPath: string,
    preferredBranch?: string
  ) => Promise<GitBranchDiscoveryResult>;
  'projects:choosePath': (
    serverId: string,
    currentPath?: string
  ) => Promise<{ path?: string; canceled: boolean; error?: string }>;

  // Agent Launch Configs
  'agents:list': () => Promise<Agent[]>;
  'agents:save': (agent: Omit<Agent, 'createdAt'>) => Promise<Agent>;
  'agents:delete': (id: string) => Promise<void>;

  // Session Lifecycle
  'sessions:list': () => Promise<Session[]>;
  'sessions:create': (input: CreateSessionInput) => Promise<Session>;
  'sessions:rename': (sessionId: string, name: string) => Promise<Session>;
  'sessions:adopt': (input: AdoptSessionInput) => Promise<Session>;
  'sessions:unadopt': (sessionId: string) => Promise<boolean>;
  'sessions:reconcile': () => Promise<Session[]>;
  'sessions:attach': (sessionId: string) => Promise<{ ptyChannelId: string }>;
  'sessions:detach': (sessionId: string) => Promise<void>;
  'sessions:stop': (sessionId: string) => Promise<void>;
  'sessions:finish': (
    sessionId: string,
    action: FinishSessionAction,
    options?: FinishSessionOptions
  ) => Promise<FinishSessionResult>;
  'sessions:inspectWorktree': (sessionId: string) => Promise<ManagedWorktreeInspection>;
  'sessions:delete': (sessionId: string) => Promise<boolean>;

  // Local MCP control requests. Pending destructive actions are resolved here
  // from the trusted renderer after an explicit user decision. An explicitly
  // LLM-validated MCP close is executed in Main through its separate mode.
  'control:listFinalizationRequests': (includeResolved?: boolean) => Promise<ControlFinalizationRequest[]>;
  'control:resolveFinalizationRequest': (
    requestId: string,
    decision: 'approve' | 'reject'
  ) => Promise<ControlFinalizationRequest>;

  // External navigation
  'shell:openExternalUrl': (url: string) => Promise<boolean>;
  'shell:openConfig': () => Promise<{ success: boolean; error?: string }>;

  // Session Context Data (Files & Git)
  'session:getFiles': (sessionId: string, subPath?: string) => Promise<FileEntry[]>;
  'session:listFiles': (sessionId: string, subPath?: string) => Promise<FileEntry[]>;
  'session:readFile': (
    sessionId: string,
    relativePath: string,
    maxBytes?: number
  ) => Promise<import('./index.js').FileContentResult>;
  'session:getDiff': (sessionId: string) => Promise<string>;
  'session:getGitStatus': (sessionId: string) => Promise<import('./index.js').GitStatusResult>;
  'session:getGitDiff': (
    sessionId: string,
    options?: import('./index.js').GitDiffOptions
  ) => Promise<import('./index.js').GitDiffResult>;
  // Session Artifacts
  'session:getArtifacts': (sessionId: string) => Promise<Artifact[]>;
  'session:uploadArtifact': (sessionId: string, localFilePath: string) => Promise<Artifact>;
  'session:uploadArtifactFile': (
    sessionId: string,
    localFilePath: string,
    direction?: import('./index.js').ArtifactDirection,
    customFilename?: string
  ) => Promise<Artifact>;
  'session:uploadArtifactData': (
    sessionId: string,
    buffer: Uint8Array,
    filename: string,
    mimeType: string,
    direction?: import('./index.js').ArtifactDirection
  ) => Promise<Artifact>;
  'session:pasteImage': (sessionId: string, imageBuffer: Uint8Array) => Promise<Artifact>;
  'session:promoteToArtifact': (sessionId: string, filePath: string) => Promise<Artifact>;
  'session:getArtifactContent': (
    sessionId: string,
    artifactId: string,
    maxBytes?: number
  ) => Promise<import('./index.js').FileContentResult>;
  'session:deleteArtifact': (sessionId: string, artifactId: string) => Promise<boolean>;
  'session:clearArtifacts': (sessionId: string) => Promise<number>;
  'session:saveArtifactAs': (sessionId: string, artifactId: string) => Promise<boolean>;
  'session:openArtifactInOs': (sessionId: string, artifactId: string) => Promise<boolean>;

  // PTY Streaming Events
  'pty:write': (channelId: string, data: string) => void;
  'pty:resize': (channelId: string, cols: number, rows: number) => void;
  'pty:data': (callback: (channelId: string, data: string) => void) => () => void;
  'pty:exit': (callback: (channelId: string, exitCode: number) => void) => () => void;

  // Attention & Status Events
  'session:statusChanged': (callback: (sessionId: string, status: SessionStatus) => void) => () => void;
  'session:artifactCreated': (callback: (sessionId: string, artifact: Artifact) => void) => () => void;
  'session:getStateSnapshot': (sessionId: string) => Promise<StateFeedbackSnapshot>;
  'session:submitStateFeedback': (report: StateFeedbackReport) => Promise<StateFeedbackResult>;
}
