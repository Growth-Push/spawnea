import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as pty from 'node-pty';
import type {
  HostAdapter,
  PtyStream,
  PtyOptions,
  ExecOptions,
  ExecResult,
  HostTestResult,
  Logger,
} from '@spawnea/domain';
import { createLogger } from '@spawnea/domain';

const execAsync = promisify(exec);

export interface LocalHostAdapterOptions {
  serverId?: string;
  logger?: Logger;
}

export class LocalHostAdapter implements HostAdapter {
  readonly serverId: string;
  private logger: Logger;
  private connected = true;

  constructor(options?: LocalHostAdapterOptions) {
    this.serverId = options?.serverId || 'local';
    this.logger = options?.logger || createLogger(`LocalHost:${this.serverId}`);
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  getConnectionState(): import('@spawnea/domain').HostConnectionState {
    return {
      serverId: this.serverId,
      status: this.connected ? 'connected' : 'disconnected',
      attempt: 0,
      maxAttempts: 5,
    };
  }

  onConnectionStateChange(_listener: (state: import('@spawnea/domain').HostConnectionState) => void): () => void {
    return () => {};
  }

  async reconnect(): Promise<void> {
    this.connected = true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async testConnection(): Promise<HostTestResult> {
    const startTime = Date.now();
    try {
      const { stdout } = await execAsync('which tmux || echo "tmux not found"');
      const latencyMs = Date.now() - startTime;
      const tmuxAvailable = !stdout.includes('tmux not found');
      return {
        success: true,
        hostId: this.serverId,
        target: 'localhost',
        latencyMs,
        details: tmuxAvailable ? 'Local machine ready (tmux found)' : 'Local machine ready (warning: tmux not found)',
      };
    } catch (err: any) {
      return {
        success: false,
        hostId: this.serverId,
        target: 'localhost',
        error: err?.message || 'Local execution failed',
      };
    }
  }

  async execute(command: string, options?: ExecOptions): Promise<ExecResult> {
    this.logger.debug('Executing local command', { command, cwd: options?.cwd });
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: options?.cwd,
        env: options?.env ? { ...process.env, ...options.env } : process.env,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || err.message || '',
        exitCode: typeof err.code === 'number' ? err.code : 1,
      };
    }
  }

  async openPty(command: string, options: PtyOptions): Promise<PtyStream> {
    const shell = process.env.SHELL || '/bin/bash';
    const cols = options?.cols || 80;
    const rows = options?.rows || 24;

    let ptyProcess: pty.IPty;

    if (command && command.trim().length > 0) {
      // Execute via shell exec so the process is directly replaced by tmux
      ptyProcess = pty.spawn(shell, ['-c', `exec ${command}`], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: options.cwd || process.cwd(),
        env: options.env ? { ...process.env, ...options.env } : (process.env as Record<string, string>),
      });
    } else {
      ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: options?.cwd || process.cwd(),
        env: options?.env ? { ...process.env, ...options.env } : (process.env as Record<string, string>),
      });
    }

    const streamId = `pty-local-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;
    const onDataListeners = new Set<(data: string) => void>();
    const onExitListeners = new Set<(exitCode: number) => void>();

    const dataDisposable = ptyProcess.onData((data) => {
      for (const listener of onDataListeners) {
        listener(data);
      }
    });

    const exitDisposable = ptyProcess.onExit(({ exitCode }) => {
      for (const listener of onExitListeners) {
        listener(exitCode);
      }
    });

    return {
      id: streamId,
      write(data: string): void {
        ptyProcess.write(data);
      },
      resize(c: number, r: number): void {
        try {
          ptyProcess.resize(c, r);
        } catch {
          // ignore
        }
      },
      onData(callback: (data: string) => void): () => void {
        onDataListeners.add(callback);
        return () => {
          onDataListeners.delete(callback);
        };
      },
      onExit(callback: (exitCode: number) => void): () => void {
        onExitListeners.add(callback);
        return () => {
          onExitListeners.delete(callback);
        };
      },
      close(): void {
        try {
          dataDisposable.dispose();
          exitDisposable.dispose();
          ptyProcess.kill();
        } catch {
          // ignore
        }
      },
    };
  }

  async listFiles(dirPath: string): Promise<import('@spawnea/domain').FileEntry[]> {
    this.logger.debug('Listing local directory files', { dirPath });
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const results: import('@spawnea/domain').FileEntry[] = [];

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        let size = 0;
        let modifiedAt = new Date();

        try {
          const stats = await fs.stat(fullPath);
          size = stats.size;
          modifiedAt = stats.mtime;
        } catch {
          // Keep defaults if stat fails
        }

        results.push({
          name: entry.name,
          path: fullPath,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
          size,
          modifiedAt,
        });
      }

      // Sort directories first, then alphabetically
      return results.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });
    } catch (err: any) {
      throw new Error(`Failed to list directory '${dirPath}': ${err.message || String(err)}`);
    }
  }

  async readFile(
    filePath: string,
    maxBytes = 2 * 1024 * 1024
  ): Promise<import('@spawnea/domain').FileContentResult> {
    this.logger.debug('Reading local file', { filePath, maxBytes });
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    try {
      const stats = await fs.stat(filePath);
      const mimeType = getLocalMimeType(filePath);
      const isImage = mimeType.startsWith('image/');
      const effectiveMaxBytes = isImage ? Math.max(maxBytes, 10 * 1024 * 1024) : maxBytes;

      const isTruncated = stats.size > effectiveMaxBytes;
      const lengthToRead = isTruncated ? effectiveMaxBytes : stats.size;

      const fileHandle = await fs.open(filePath, 'r');
      const buffer = Buffer.alloc(lengthToRead);
      try {
        await fileHandle.read(buffer, 0, lengthToRead, 0);
      } finally {
        await fileHandle.close();
      }

      const binary = isImage || isLocalBinaryBuffer(buffer);

      let content: string;
      if (isImage) {
        content = `data:${mimeType};base64,${buffer.toString('base64')}`;
      } else if (binary) {
        content = buffer.toString('base64');
      } else {
        content = buffer.toString('utf8');
      }

      return {
        path: filePath,
        content,
        isBinary: binary,
        isTruncated,
        sizeBytes: stats.size,
        mimeType,
      };
    } catch (err: any) {
      throw new Error(`Failed to read file '${filePath}': ${err.message || String(err)}`);
    }
  }

  async stat(filePath: string): Promise<import('@spawnea/domain').FileStat> {
    const fs = await import('node:fs/promises');
    try {
      const stats = await fs.stat(filePath);
      return {
        size: stats.size,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        modifiedAt: stats.mtime,
      };
    } catch (err: any) {
      throw new Error(`Failed to stat '${filePath}': ${err.message || String(err)}`);
    }
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    try {
      await fs.mkdir(path.dirname(remotePath), { recursive: true });
      await fs.copyFile(localPath, remotePath);
      this.logger.debug('Uploaded file locally', { localPath, remotePath });
    } catch (err: any) {
      throw new Error(`Failed to upload local file '${localPath}' to '${remotePath}': ${err.message || String(err)}`);
    }
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    try {
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.copyFile(remotePath, localPath);
      this.logger.debug('Downloaded file locally', { remotePath, localPath });
    } catch (err: any) {
      throw new Error(`Failed to download local file '${remotePath}' to '${localPath}': ${err.message || String(err)}`);
    }
  }

  async writeFile(remotePath: string, data: Buffer | Uint8Array | string): Promise<void> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    try {
      await fs.mkdir(path.dirname(remotePath), { recursive: true });
      await fs.writeFile(remotePath, data);
      this.logger.debug('Wrote file locally', { remotePath, bytes: data.length });
    } catch (err: any) {
      throw new Error(`Failed to write file '${remotePath}': ${err.message || String(err)}`);
    }
  }

  async mkdir(dirPath: string): Promise<void> {
    const fs = await import('node:fs/promises');
    try {
      await fs.mkdir(dirPath, { recursive: true });
      this.logger.debug('Created directory locally', { dirPath });
    } catch (err: any) {
      throw new Error(`Failed to create directory '${dirPath}': ${err.message || String(err)}`);
    }
  }
}

function getLocalMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'svg': return 'image/svg+xml';
    case 'webp': return 'image/webp';
    case 'ico': return 'image/x-icon';
    case 'json': return 'application/json';
    case 'md': return 'text/markdown';
    case 'ts':
    case 'tsx': return 'text/typescript';
    case 'js':
    case 'jsx': return 'text/javascript';
    case 'html': return 'text/html';
    case 'css': return 'text/css';
    case 'txt': return 'text/plain';
    case 'yaml':
    case 'yml': return 'text/yaml';
    case 'pdf': return 'application/pdf';
    default: return 'text/plain';
  }
}

function isLocalBinaryBuffer(buf: Buffer): boolean {
  const checkLength = Math.min(buf.length, 1024);
  for (let i = 0; i < checkLength; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

