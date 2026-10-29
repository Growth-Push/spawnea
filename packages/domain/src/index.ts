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
export * from './model-selection.js';
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

/** Which state-rules file supplied a rule. */
export type StateRuleFile = 'factory' | 'user';

/**
 * Identifies a configured state rule by file, harness, and 1-based position in
 * that file's ordered rule list for the harness.
 */
export interface StateRuleReference {
  file: StateRuleFile;
  harness: string;
  position: number;
}

/** Which state-rules configuration is active for this application run. */
export type StateRulesConfigSource = 'factory' | 'merged' | 'user_invalid';

export interface StateRulesError {
  /** File name of the invalid state-rules file. */
  file: string;
  harness?: string;
  /** 1-based rule position within the harness. */
  position?: number;
  /** 1-based YAML line when the error has a source location. */
  line?: number;
  message: string;
}

export interface StateRulesStatus {
  source: StateRulesConfigSource;
  userFilePath: string;
  error?: StateRulesError;
}

export interface SessionStatusResult {
  status: SessionStatus;
  confidence: number;
  source: StatusSource;
  detectedPrompt?: string;
  reason: string;
  updatedAt: Date;
  /** The state rule that decided the status, when one matched. */
  matchedRule?: StateRuleReference;
  /** True when no rule matched and the activity fallback decided the status. */
  fallback?: boolean;
  /** Opaque digest of the evaluated terminal window; never the text itself. */
  windowFingerprint?: string;
}

/**
 * What decided a detected status: a configured rule, the activity fallback, or
 * the connection and process step, which uses no rules.
 */
export type StateFeedbackDecision =
  | { kind: 'rule'; rule: StateRuleReference }
  | { kind: 'fallback' }
  | { kind: 'connection' };

/**
 * State-rules configuration in use when a report was captured. Only the error
 * location is kept: no file path, message, or pattern text.
 */
export interface StateFeedbackRulesConfig {
  source: StateRulesConfigSource;
  error?: {
    file: string;
    harness?: string;
    position?: number;
    line?: number;
  };
}

/**
 * Whether the terminal snapshot was captured. When it failed, the report has
 * no detected status, source, confidence, or decision instead of guessed ones.
 */
export type StateFeedbackCapture =
  | { status: 'captured' }
  | { status: 'failed'; reason: string };

export interface StateFeedbackSnapshot {
  sessionId: string;
  sessionName: string;
  harness?: string;
  worktreePath?: string;
  branch?: string;
  capture: StateFeedbackCapture;
  /** Detection fields are absent when the capture failed. */
  detectedStatus?: SessionStatus;
  confidence?: number;
  source?: StatusSource;
  reason?: string;
  detectedPrompt?: string;
  decision?: StateFeedbackDecision;
  rulesConfig: StateFeedbackRulesConfig;
  tailLines: string[];
  capturedAt: string;
}

export interface StateFeedbackReport {
  sessionId: string;
  sessionName: string;
  harness?: string;
  worktreePath?: string;
  branch?: string;
  /** Status Spawnea displayed when the user opened the report. */
  observedStatus: SessionStatus;
  capture: StateFeedbackCapture;
  /** Detection fields are absent when the capture failed. */
  detectedStatus?: SessionStatus;
  detectedSource?: StatusSource;
  detectedConfidence?: number;
  detectedPrompt?: string;
  detectionReason?: string;
  decision?: StateFeedbackDecision;
  /** Filled in by the main process when the report is saved. */
  rulesConfig?: StateFeedbackRulesConfig;
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

export type SessionCreationSource = 'ui' | 'control';

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

export interface TmuxPaneSnapshot {
  windowIndex: number;
  paneIndex: number;
  cwd: string;
  title?: string;
  active: boolean;
}

export interface TmuxWindowSnapshot {
  index: number;
  name: string;
  active: boolean;
  layout?: string;
  panes: TmuxPaneSnapshot[];
}

export interface SessionTopologySnapshot {
  savedAt: Date;
  sessionName: string;
  windows: TmuxWindowSnapshot[];
  agentSessionId?: string;
}

export interface Session {
  id: string;
  name: string;
  parentSessionId?: string;
  childAlias?: string;
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
  /** Requested model only; this is not effective-model telemetry. */
  requestedModel?: string;
  isExternal?: boolean;
  savedTopology?: SessionTopologySnapshot;
  agentSessionId?: string;
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

/** Outcome of opening an artifact in the OS default app. */
export interface ArtifactOpenResult {
  opened: boolean;
  /** True when the app opened a temporary copy because the original is on a remote host. */
  temporaryCopy: boolean;
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
  unavailable?: boolean;
  missing?: boolean;
  error?: string;
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
  /** Immutable managed-worktree baseline, when supplied by orchestration. */
  baseCommit?: string;
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

export * from './skill-prompt.js';
export * from './shell-commands.js';
