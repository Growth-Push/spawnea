export * from './schemas.js';
export * from './catalog.js';
export * from './session-context.js';
export * from './hosts.js';
export * from './ipc.js';
export * from './logger.js';
export * from './repositories.js';
export * from './secret-reference.js';
export * from './control.js';
export * from './path-security.js';
export type SessionStatus =
  | 'starting'
  | 'working'
  | 'needs_input'
  | 'idle'
  | 'done'
  | 'error'
  | 'disconnected';

export type StatusSource =
  | 'tmux'
  | 'process'
  | 'pty_activity'
  | 'terminal_prompt'
  | 'process_exit';

export interface SessionSignals {
  sessionId: string;
  hostReachable: boolean;
  tmuxSessionExists: boolean;
  paneExists: boolean;
  paneDead: boolean;
  paneCurrentCommand?: string;
  panePid?: number;
  isPtyAttached: boolean;
  lastOutputAt?: Date;
  lastInputAt?: Date;
  recentOutputBytes?: number;
  tailLines?: string[];
  matchedPrompt?: string;
  detectedPromptKind?: 'confirmation' | 'choice' | 'text_input' | 'shell_prompt' | 'none';
  exitCode?: number;
}

export interface SessionStatusResult {
  status: SessionStatus;
  confidence: number;
  source: StatusSource;
  detectedPrompt?: string;
  reason: string;
  updatedAt: Date;
}

export interface StateFeedbackSnapshot {
  sessionId: string;
  sessionName: string;
  harness?: string;
  worktreePath?: string;
  branch?: string;
  detectedStatus: SessionStatus;
  confidence: number;
  source: StatusSource;
  reason: string;
  detectedPrompt?: string;
  tailLines: string[];
  capturedAt: string;
}

export interface StateFeedbackReport {
  sessionId: string;
  sessionName: string;
  harness?: string;
  worktreePath?: string;
  branch?: string;
  detectedStatus: SessionStatus;
  detectedSource: StatusSource;
  detectedConfidence: number;
  detectedPrompt?: string;
  detectionReason: string;
  expectedStatus: SessionStatus;
  userNotes?: string;
  tailLines: string[];
  timestamp: string;
}

export interface StateFeedbackResult {
  success: boolean;
  filePath: string;
  fixtureJson: string;
}

export type ArtifactDirection = 'input' | 'output';

export type SessionCreationSource = 'ui' | 'mcp';

export interface Server {
  id: string;
  name: string;
  host: string;
  sshUser?: string;
  sshPort: number;
  sshConfigAlias?: string;
  enabled: boolean;
  createdAt: Date;
}

export interface Project {
  id: string;
  serverId: string;
  name: string;
  rootPath: string;
  repoUrl?: string;
  baseBranch?: string;
  createdAt: Date;
}

export interface Agent {
  id: string;
  name: string;
  harness: string; // e.g. 'claude', 'codex', 'hermes', 'opencode', 'shell'
  command: string; // e.g. 'claude', 'hermes'
  argsTemplate?: string[]; // e.g. ['agent', 'example-agent-profile']
  envVars?: Record<string, string>;
  createdAt: Date;
}

export interface DiscoveredTmuxSession {
  sessionName: string;
  windowsCount: number;
  createdAt?: Date;
  panePid?: number;
  currentCommand?: string;
  currentPath?: string;
}

export interface AdoptSessionInput {
  serverId: string;
  tmuxSessionName: string;
  sessionName?: string;
  projectId?: string;
  projectPath?: string;
  agentId?: string;
  harnessCommand?: string;
  task?: string;
}

export interface Session {
  id: string;
  name: string;
  serverId: string;
  projectId: string;
  agentId: string;
  task: string;
  worktreePath: string;
  branch: string;
  baseBranch?: string;
  baseCommit?: string;
  managedWorktree?: boolean;
  tmuxSessionName: string;
  tmuxWindowName?: string;
  status: SessionStatus;
  /** Explicit origin of the session creation request. Legacy records may omit this. */
  creationSource?: SessionCreationSource;
  isExternal?: boolean;
  createdAt: Date;
  lastActivityAt: Date;
}

export interface Artifact {
  id: string;
  sessionId: string;
  direction: ArtifactDirection;
  remotePath: string;
  cachedLocalPath?: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
}

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  modifiedAt: Date;
}

export interface FileStat {
  size: number;
  isDirectory: boolean;
  isFile: boolean;
  modifiedAt: Date;
}

export type GitFileStatusCode =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'copied'
  | 'typechanged';

export interface GitFileStatus {
  path: string;
  oldPath?: string;
  status: GitFileStatusCode;
  staged: boolean;
  statusCode: string;
}

export interface GitStatusResult {
  isGitRepo: boolean;
  branch: string;
  trackingBranch?: string;
  ahead: number;
  behind: number;
  isClean: boolean;
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
  untracked: GitFileStatus[];
  totalChanges: number;
  rawStatus?: string;
}

export interface GitDiffOptions {
  filePath?: string;
  staged?: boolean;
  cached?: boolean;
  maxLines?: number;
}

export interface GitDiffHunkLine {
  type: 'add' | 'delete' | 'context' | 'header';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface GitDiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: GitDiffHunkLine[];
}

export interface GitDiffFile {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  isBinary: boolean;
  isNew: boolean;
  isDeleted: boolean;
  isRenamed: boolean;
  hunks: GitDiffHunk[];
}

export interface GitDiffResult {
  rawDiff: string;
  files: GitDiffFile[];
  totalAdditions: number;
  totalDeletions: number;
  totalFilesChanged: number;
}
