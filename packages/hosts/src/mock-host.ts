import type {
  HostAdapter,
  HostTestResult,
  ExecOptions,
  ExecResult,
  PtyOptions,
  PtyStream,
  HostConnectionState,
} from '@spawnea/domain';
import { HostReconnectionSupervisor } from './reconnection-supervisor.js';

export interface MockCommandRule {
  pattern: RegExp | string;
  response:
    | ExecResult
    | Promise<ExecResult>
    | ((command: string, options?: ExecOptions) => ExecResult | Promise<ExecResult>);
}

export class MockHostAdapter implements HostAdapter {
  readonly serverId: string;
  private connected = false;
  public directories: Set<string> = new Set();
  public sessions: Set<string> = new Set();
  public executedCommands: { command: string; options?: ExecOptions }[] = [];
  public customRules: MockCommandRule[] = [];
  public shouldFailConnection = false;
  public connectionErrorMessage = 'SSH connection timeout';
  public supervisor: HostReconnectionSupervisor;

  constructor(serverId = 'mock-server', initialDirs: string[] = [], supervisor?: HostReconnectionSupervisor) {
    this.serverId = serverId;
    this.supervisor = supervisor || new HostReconnectionSupervisor();
    for (const dir of initialDirs) {
      this.directories.add(dir);
    }
  }

  getConnectionState(): HostConnectionState {
    return this.supervisor.getState(this.serverId);
  }

  onConnectionStateChange(listener: (state: HostConnectionState) => void): () => void {
    return this.supervisor.onStateChange(listener);
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.shouldFailConnection) {
      this.connected = false;
      this.supervisor.markDisconnected(this.serverId, this.connectionErrorMessage);
      throw new Error(this.connectionErrorMessage);
    }
    this.connected = true;
    this.supervisor.markConnected(this.serverId);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.supervisor.markDisconnected(this.serverId);
  }

  async reconnect(): Promise<void> {
    this.connected = false;
    await this.connect();
  }

  async retryNow(): Promise<boolean> {
    return this.supervisor.retryNow(this.serverId, () => this.reconnect());
  }

  simulateDrop(errorMessage = 'Simulated connection drop'): void {
    this.connected = false;
    this.supervisor.handleConnectionDrop(this.serverId, errorMessage, () => this.reconnect());
  }

  async testConnection(): Promise<HostTestResult> {
    if (this.shouldFailConnection) {
      return {
        success: false,
        hostId: this.serverId,
        target: 'mock-target',
        latencyMs: 50,
        error: this.connectionErrorMessage,
      };
    }
    return {
      success: true,
      hostId: this.serverId,
      target: 'mock-target',
      latencyMs: 12,
      details: 'Mock connection successful',
    };
  }

  async execute(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (!this.connected) {
      await this.connect();
    }

    this.executedCommands.push({ command, options });

    // Check custom rules first
    for (const rule of this.customRules) {
      const matches =
        typeof rule.pattern === 'string'
          ? command.includes(rule.pattern)
          : rule.pattern.test(command);

      if (matches) {
        if (typeof rule.response === 'function') {
          return await rule.response(command, options);
        }
        return await rule.response;
      }
    }

    // Default built-in mock behaviors for common commands
    if (command.startsWith('test -d ') || command.includes('test -d ')) {
      const match = command.match(/test -d\s+(?:'([^']+)'|"([^"]+)"|(\S+))/);
      const dirPath = match ? (match[1] || match[2] || match[3]) : '';
      const exists = this.directories.has(dirPath);
      return {
        stdout: '',
        stderr: exists ? '' : 'No such file or directory',
        exitCode: exists ? 0 : 1,
      };
    }

    if (command.startsWith('mkdir -p ') || command.includes('mkdir -p ')) {
      const match = command.match(/mkdir -p\s+(?:'([^']+)'|"([^"]+)"|(\S+))/);
      const dirPath = match ? (match[1] || match[2] || match[3]) : '';
      if (dirPath) {
        this.directories.add(dirPath);
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (command.startsWith('git clone ') || command.includes('git clone ')) {
      const parts = command.trim().split(/\s+/);
      const targetPath = parts[parts.length - 1].replace(/^['"]|['"]$/g, '');
      if (targetPath) {
        this.directories.add(targetPath);
      }
      return { stdout: `Cloning into '${targetPath}'...`, stderr: '', exitCode: 0 };
    }

    if (command.includes('echo __SPAWNEA_OK__')) {
      return { stdout: '__SPAWNEA_OK__\n', stderr: '', exitCode: 0 };
    }

    if (command.includes('tmux has-session')) {
      const match = command.match(/tmux has-session -t\s+(?:'([^']+)'|"([^"]+)"|(\S+))/);
      const sessionName = match ? (match[1] || match[2] || match[3]) : '';
      const exists = sessionName ? this.sessions.has(sessionName) : false;
      return {
        stdout: '',
        stderr: exists ? '' : "can't find session",
        exitCode: exists ? 0 : 1,
      };
    }

    if (command.includes('tmux new-session')) {
      const match = command.match(/-s\s+(?:'([^']+)'|"([^"]+)"|(\S+))/);
      const sessionName = match ? (match[1] || match[2] || match[3]) : '';
      if (sessionName) {
        this.sessions.add(sessionName);
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (command.includes('tmux kill-session')) {
      const match = command.match(/tmux kill-session -t\s+(?:'([^']+)'|"([^"]+)"|(\S+))/);
      const sessionName = match ? (match[1] || match[2] || match[3]) : '';
      if (sessionName) {
        this.sessions.delete(sessionName);
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (command.includes('tail -n ')) {
      const match = command.match(/tail -n\s+(\d+)\s+(?:'([^']+)'|"([^"]+)"|(\S+))/);
      const lines = match ? parseInt(match[1], 10) : 10;
      const rawPath = match ? (match[2] || match[3] || match[4] || '') : '';
      const filePath = rawPath.replace(/^['"]|['"]$/g, '').split(' ')[0];
      const file = this.mockFiles.get(filePath);
      if (file) {
        const fileLines = file.content.split('\n');
        const tailLines = fileLines.slice(-lines).join('\n');
        return { stdout: tailLines, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    return { stdout: '', stderr: '', exitCode: 0 };
  }

  async openPty(_command: string, _options: PtyOptions): Promise<PtyStream> {
    if (!this.connected) {
      await this.connect();
    }

    const dataListeners: ((data: string) => void)[] = [];
    const exitListeners: ((code: number) => void)[] = [];
    const streamId = `pty-mock-${Date.now().toString(36)}`;

    return {
      id: streamId,
      onData(callback) {
        dataListeners.push(callback);
        return () => {
          const idx = dataListeners.indexOf(callback);
          if (idx !== -1) dataListeners.splice(idx, 1);
        };
      },
      onExit(callback) {
        exitListeners.push(callback);
        return () => {
          const idx = exitListeners.indexOf(callback);
          if (idx !== -1) exitListeners.splice(idx, 1);
        };
      },
      write(data) {
        // Echo input back in mock
        for (const cb of dataListeners) {
          cb(data);
        }
      },
      resize(_cols, _rows) {
        // No-op in mock
      },
      close() {
        for (const cb of exitListeners) {
          cb(0);
        }
      },
    };
  }

  // In-memory mock files
  public mockFiles: Map<
    string,
    { content: string; isBinary?: boolean; size?: number; modifiedAt?: Date; mimeType?: string }
  > = new Map();

  async listFiles(dirPath: string): Promise<import('@spawnea/domain').FileEntry[]> {
    if (!this.connected) {
      await this.connect();
    }

    const normalizedDir = dirPath.replace(/\/+$/, '');
    const entries: import('@spawnea/domain').FileEntry[] = [];
    const directChildrenDirs = new Set<string>();

    // 1. Collect directories
    for (const dir of this.directories) {
      const norm = dir.replace(/\/+$/, '');
      if (norm !== normalizedDir && norm.startsWith(normalizedDir + '/')) {
        const relative = norm.slice(normalizedDir.length + 1);
        const topChild = relative.split('/')[0];
        if (topChild && !directChildrenDirs.has(topChild)) {
          directChildrenDirs.add(topChild);
          entries.push({
            name: topChild,
            path: `${normalizedDir}/${topChild}`,
            isDirectory: true,
            isFile: false,
            size: 4096,
            modifiedAt: new Date(),
          });
        }
      }
    }

    // 2. Collect files
    for (const [filePath, fileData] of this.mockFiles.entries()) {
      const norm = filePath.replace(/\/+$/, '');
      if (norm.startsWith(normalizedDir + '/')) {
        const relative = norm.slice(normalizedDir.length + 1);
        if (!relative.includes('/')) {
          entries.push({
            name: relative,
            path: norm,
            isDirectory: false,
            isFile: true,
            size: fileData.size ?? Buffer.byteLength(fileData.content, 'utf8'),
            modifiedAt: fileData.modifiedAt || new Date(),
          });
        } else {
          const topChild = relative.split('/')[0];
          if (topChild && !directChildrenDirs.has(topChild)) {
            directChildrenDirs.add(topChild);
            entries.push({
              name: topChild,
              path: `${normalizedDir}/${topChild}`,
              isDirectory: true,
              isFile: false,
              size: 4096,
              modifiedAt: new Date(),
            });
          }
        }
      }
    }

    return entries.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  async readFile(
    filePath: string,
    maxBytes = 2 * 1024 * 1024
  ): Promise<import('@spawnea/domain').FileContentResult> {
    if (!this.connected) {
      await this.connect();
    }

    const file = this.mockFiles.get(filePath);
    if (!file) {
      throw new Error(`File not found: ${filePath}`);
    }

    const totalSize = file.size ?? Buffer.byteLength(file.content, 'utf8');
    const isTruncated = totalSize > maxBytes;
    const content = isTruncated ? file.content.slice(0, maxBytes) : file.content;

    return {
      path: filePath,
      content,
      isBinary: file.isBinary ?? false,
      isTruncated,
      sizeBytes: totalSize,
      mimeType: file.mimeType || (file.isBinary ? 'application/octet-stream' : 'text/plain'),
    };
  }

  async stat(filePath: string): Promise<import('@spawnea/domain').FileStat> {
    if (!this.connected) {
      await this.connect();
    }

    if (this.directories.has(filePath)) {
      return {
        size: 4096,
        isDirectory: true,
        isFile: false,
        modifiedAt: new Date(),
      };
    }

    const file = this.mockFiles.get(filePath);
    if (file) {
      return {
        size: file.size ?? Buffer.byteLength(file.content, 'utf8'),
        isDirectory: false,
        isFile: true,
        modifiedAt: file.modifiedAt || new Date(),
      };
    }

    throw new Error(`Path not found: ${filePath}`);
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }

    try {
      const fs = await import('node:fs/promises');
      const buf = await fs.readFile(localPath);
      this.mockFiles.set(remotePath, {
        content: buf.toString('utf8'),
        size: buf.length,
        isBinary: false,
        modifiedAt: new Date(),
      });
    } catch {
      // If localPath doesn't exist on disk, simulate upload with fallback content
      this.mockFiles.set(remotePath, {
        content: `mock-content-from:${localPath}`,
        size: 128,
        isBinary: false,
        modifiedAt: new Date(),
      });
    }
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }

    const file = this.mockFiles.get(remotePath);
    if (!file) {
      throw new Error(`Remote file not found: ${remotePath}`);
    }

    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, file.content);
    } catch {
      // Ignore disk write errors in pure unit test environments
    }
  }

  async writeFile(remotePath: string, data: Buffer | Uint8Array | string): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }

    const content = Buffer.isBuffer(data) || data instanceof Uint8Array
      ? Buffer.from(data).toString('utf8')
      : String(data);
    const size = Buffer.isBuffer(data) || data instanceof Uint8Array
      ? data.length
      : Buffer.byteLength(content, 'utf8');

    this.mockFiles.set(remotePath, {
      content,
      size,
      isBinary: false,
      modifiedAt: new Date(),
    });
  }

  async mkdir(dirPath: string): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
    this.directories.add(dirPath);
  }
}

