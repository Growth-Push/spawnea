export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface PtyOptions {
  cols: number;
  rows: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface PtyStream {
  id: string;
  onData(callback: (data: string) => void): () => void;
  onExit(callback: (exitCode: number) => void): () => void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface HostTestResult {
  success: boolean;
  hostId: string;
  target: string;
  latencyMs?: number;
  error?: string;
  details?: string;
}

export type HostHealthStatus = 'healthy' | 'degraded' | 'unreachable' | 'checking';

export interface HostHealthResult {
  hostId: string;
  target: string;
  status: HostHealthStatus;
  latencyMs?: number;
  lastCheckedAt: string;
  error?: string;
  details?: string;
}

export interface ProjectPrepResult {
  success: boolean;
  path: string;
  action: 'reused' | 'cloned' | 'created';
  error?: string;
}

export interface GitBranchDiscoveryResult {
  isGitRepo: boolean;
  currentBranch?: string;
  branches: string[];
  suggestedBranches: string[];
  error?: string;
}

export interface HostSystemInfo {
  serverId: string;
  osName?: string;
  kernel?: string;
  arch?: string;
  cpuModel?: string;
  totalMemory?: string;
  uptime?: string;
  shell?: string;
  fetchedAt: string;
}

export interface FileContentResult {
  path: string;
  content: string;
  isBinary: boolean;
  isTruncated: boolean;
  sizeBytes: number;
  mimeType?: string;
}

export type HostConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

export interface HostConnectionState {
  serverId: string;
  status: HostConnectionStatus;
  attempt: number;
  maxAttempts: number;
  nextRetryDelayMs?: number;
  error?: string;
  lastConnectedAt?: string;
}

export type HostConnectionTransport = 'local' | 'ssh';

export interface HostConnectionEndpoint {
  transport: HostConnectionTransport;
  hostname: string;
  port: number;
}

export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export interface HostAdapter {
  readonly serverId: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  testConnection(): Promise<HostTestResult>;
  execute(command: string, options?: ExecOptions): Promise<ExecResult>;
  openPty(command: string, options: PtyOptions): Promise<PtyStream>;
  listFiles(dirPath: string): Promise<import('./index.js').FileEntry[]>;
  readFile(filePath: string, maxBytes?: number): Promise<FileContentResult>;
  stat(filePath: string): Promise<import('./index.js').FileStat>;
  uploadFile(localPath: string, remotePath: string): Promise<void>;
  downloadFile(remotePath: string, localPath: string): Promise<void>;
  writeFile(remotePath: string, data: Buffer | Uint8Array | string): Promise<void>;
  mkdir(dirPath: string): Promise<void>;
  getConnectionState?(): HostConnectionState;
  getConnectionEndpoint?(): Promise<HostConnectionEndpoint | null>;
  onConnectionStateChange?(listener: (state: HostConnectionState) => void): () => void;
  reconnect?(): Promise<void>;
}
