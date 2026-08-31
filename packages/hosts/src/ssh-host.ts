import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  HostAdapter,
  HostTestResult,
  ExecOptions,
  ExecResult,
  PtyOptions,
  PtyStream,
  FileEntry,
  FileContentResult,
  FileStat,
  HostConnectionState,
  Logger,
} from '@spawnea/domain';
import { createLogger, maskSensitiveString } from '@spawnea/domain';
import { resolveSshTarget, type ResolvedSshConfig } from './ssh-config.js';
import { HostReconnectionSupervisor } from './reconnection-supervisor.js';

export interface SSHHostOptions {
  serverId: string;
  target: string;
  user?: string;
  port?: number;
  configPath?: string;
  supervisor?: HostReconnectionSupervisor;
  logger?: Logger;
  displayTarget?: string;
  credentialBacked?: boolean;
  connectionOptionsProvider?: () => Promise<{
    target: string;
    user?: string;
    port?: number;
    release: () => void;
  }>;
}

export class SSHHostAdapter implements HostAdapter {
  readonly serverId: string;
  private readonly target: string;
  private readonly explicitUser?: string;
  private readonly explicitPort?: number;
  private readonly configPath?: string;
  private readonly logger: Logger;
  private readonly supervisor: HostReconnectionSupervisor;
  private readonly displayTarget: string;
  private readonly credentialBacked: boolean;
  private readonly connectionOptionsProvider?: SSHHostOptions['connectionOptionsProvider'];

  private client: Client | null = null;
  private sftpClient: SFTPWrapper | null = null;
  private sftpPromise: Promise<SFTPWrapper> | null = null;
  private connected = false;
  private connectingPromise: Promise<void> | null = null;
  private isDeliberateDisconnect = false;
  private activeCredentialRelease: (() => void) | null = null;

  constructor(options: SSHHostOptions) {
    this.serverId = options.serverId;
    this.target = options.target;
    this.explicitUser = options.user;
    this.explicitPort = options.port;
    this.configPath = options.configPath;
    this.logger = options.logger || createLogger(`SSHHost:${options.serverId}`);
    this.supervisor = options.supervisor || new HostReconnectionSupervisor({ logger: this.logger.child('reconnection') });
    this.displayTarget = options.displayTarget ?? options.target;
    this.credentialBacked = options.credentialBacked ?? false;
    this.connectionOptionsProvider = options.connectionOptionsProvider;
  }

  getConnectionState(): HostConnectionState {
    return this.supervisor.getState(this.serverId);
  }

  onConnectionStateChange(listener: (state: HostConnectionState) => void): () => void {
    return this.supervisor.onStateChange(listener);
  }

  getSupervisor(): HostReconnectionSupervisor {
    return this.supervisor;
  }

  isConnected(): boolean {
    return this.connected && this.client !== null;
  }

  async connect(): Promise<void> {
    if (this.isConnected()) {
      return;
    }

    if (this.connectingPromise) {
      return this.connectingPromise;
    }

    this.connectingPromise = this.establishConnection().catch((error) => {
      this.connectingPromise = null;
      throw error;
    });
    return this.connectingPromise;
  }

  private async establishConnection(): Promise<void> {
    const supplied = this.connectionOptionsProvider
      ? await this.connectionOptionsProvider()
      : {
          target: this.target,
          user: this.explicitUser,
          port: this.explicitPort,
          release: () => undefined,
        };
    this.releaseActiveCredentials();
    this.activeCredentialRelease = supplied.release;

    let resolved: ReturnType<typeof resolveSshTarget>;
    try {
      resolved = resolveSshTarget(
        supplied.target,
        supplied.user,
        supplied.port,
        this.configPath
      );
    } catch (error) {
      const message = maskSensitiveString(error instanceof Error ? error.message : String(error));
      this.releaseActiveCredentials();
      throw new Error(`Could not prepare SSH connection settings: ${message}`);
    }

    return new Promise<void>((resolve, reject) => {
      this.logger.info('Connecting to SSH host', {
        serverId: this.serverId,
        credentialBacked: this.credentialBacked,
      });

      const client = new Client();
      let hasFinished = false;

      client.on('ready', () => {
        if (hasFinished) return;
        hasFinished = true;
        this.client = client;
        this.connected = true;
        this.isDeliberateDisconnect = false;
        this.connectingPromise = null;
        this.logger.info('SSH connection established', { serverId: this.serverId });
        this.supervisor.markConnected(this.serverId);
        resolve();
      });

      client.on('error', (err) => {
        this.logger.error('SSH client connection error', err, { serverId: this.serverId });
        const wasConnected = this.connected;
        this.connected = false;
        if (!hasFinished) {
          hasFinished = true;
          this.connectingPromise = null;
          this.releaseActiveCredentials();
          reject(new Error(`SSH connection error: ${maskSensitiveString(err.message)}`));
        } else if (wasConnected && !this.isDeliberateDisconnect) {
          this.supervisor.handleConnectionDrop(
            this.serverId,
            maskSensitiveString(err.message),
            () => this.reconnect()
          );
        }
      });

      client.on('close', () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.client = null;
        this.sftpClient = null;
        this.sftpPromise = null;
        this.connectingPromise = null;
        this.releaseActiveCredentials();
        this.logger.info('SSH connection closed', { serverId: this.serverId });
        if (wasConnected && !this.isDeliberateDisconnect) {
          this.supervisor.handleConnectionDrop(
            this.serverId,
            'SSH connection closed unexpectedly',
            () => this.reconnect()
          );
        }
      });

      const connectConfig: import('ssh2').ConnectConfig = {
        host: resolved.hostname,
        port: resolved.port,
        username: resolved.user,
        readyTimeout: 10000,
        keepaliveInterval: 15000,
      };

      // Honor the selected host's OpenSSH IdentityAgent, including a local
      // 1Password agent socket, when the desktop process did not inherit
      // SSH_AUTH_SOCK from its launcher environment.
      const identityAgent = resolved.identityAgent === 'none'
        ? undefined
        : resolved.identityAgent || process.env.SSH_AUTH_SOCK;
      if (identityAgent) {
        connectConfig.agent = identityAgent;
      }

      // Check for identity files from ~/.ssh/config or default standard keys
      const candidateKeys = resolved.identityFile && resolved.identityFile.length > 0
        ? resolved.identityFile
        : [
            join(homedir(), '.ssh', 'id_ed25519'),
            join(homedir(), '.ssh', 'id_rsa'),
            join(homedir(), '.ssh', 'id_ecdsa'),
          ];

      for (const keyPath of candidateKeys) {
        if (existsSync(keyPath)) {
          try {
            connectConfig.privateKey = readFileSync(keyPath);
            break;
          } catch {
            // If encrypted with passphrase, ssh-agent should handle it
          }
        }
      }

      try {
        client.connect(connectConfig);
      } catch (err: any) {
        hasFinished = true;
        this.connectingPromise = null;
        const message = maskSensitiveString(err?.message || String(err));
        this.releaseActiveCredentials();
        reject(new Error(`Failed to initiate SSH connection: ${message}`));
      }
    });
  }

  private releaseActiveCredentials(): void {
    this.activeCredentialRelease?.();
    this.activeCredentialRelease = null;
  }

  async disconnect(): Promise<void> {
    this.isDeliberateDisconnect = true;
    if (this.client) {
      try {
        this.client.end();
      } catch {
        // Ignore disconnect errors
      }
      this.client = null;
      this.sftpClient = null;
      this.sftpPromise = null;
      this.connected = false;
    }
    this.releaseActiveCredentials();
    this.supervisor.markDisconnected(this.serverId);
  }

  async reconnect(): Promise<void> {
    this.logger.info('Attempting SSH host reconnection', { serverId: this.serverId });
    this.isDeliberateDisconnect = false;
    if (this.client) {
      try {
        this.client.end();
      } catch {
        // Ignore
      }
      this.client = null;
      this.sftpClient = null;
      this.sftpPromise = null;
      this.connected = false;
      this.connectingPromise = null;
    }

    await this.connect();
    // Test that the session is responsive
    const probe = await this.execute('echo __SPAWNEA_RECONNECTED__', { timeoutMs: 5000 });
    if (!probe.stdout.includes('__SPAWNEA_RECONNECTED__')) {
      throw new Error(`Reconnection probe failed with exit code ${probe.exitCode}`);
    }
    this.logger.info('SSH host reconnection verified successfully', { serverId: this.serverId });
  }

  async retryNow(): Promise<boolean> {
    return this.supervisor.retryNow(this.serverId, () => this.reconnect());
  }

  async testConnection(): Promise<HostTestResult> {
    const startTime = Date.now();
    try {
      await this.connect();
      const result = await this.execute('echo __SPAWNEA_OK__', { timeoutMs: 5000 });
      const latencyMs = Date.now() - startTime;

      if (result.exitCode === 0 && result.stdout.includes('__SPAWNEA_OK__')) {
        return {
          success: true,
          hostId: this.serverId,
          target: this.displayTarget,
          latencyMs,
          details: `Connected successfully (${latencyMs}ms)`,
        };
      }

      return {
        success: false,
        hostId: this.serverId,
        target: this.displayTarget,
        latencyMs,
        error: maskSensitiveString(result.stderr || `Probe command exited with code ${result.exitCode}`),
      };
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      const message = err?.message || String(err);
      return {
        success: false,
        hostId: this.serverId,
        target: this.displayTarget,
        latencyMs,
        error: maskSensitiveString(message),
      };
    }
  }

  async execute(command: string, options?: ExecOptions): Promise<ExecResult> {
    await this.connect();

    if (!this.client) {
      throw new Error('SSH client is not connected');
    }

    return new Promise<ExecResult>((resolve, reject) => {
      let timeoutId: NodeJS.Timeout | null = null;
      if (options?.timeoutMs && options.timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          reject(new Error(`Command timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);
      }

      const execOptions: import('ssh2').ExecOptions = {};
      if (options?.env) {
        execOptions.env = options.env;
      }

      // If cwd specified, wrap with cd
      let finalCommand = command;
      if (options?.cwd) {
        finalCommand = `cd ${escapeShellArg(options.cwd)} && ${command}`;
      }

      this.client!.exec(finalCommand, execOptions, (err, stream) => {
        if (err) {
          if (timeoutId) clearTimeout(timeoutId);
          return reject(err);
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (data: Buffer) => {
          stdout += data.toString('utf8');
        });

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString('utf8');
        });

        stream.on('close', (exitCode: number) => {
          if (timeoutId) clearTimeout(timeoutId);
          resolve({
            stdout,
            stderr,
            exitCode: typeof exitCode === 'number' ? exitCode : 0,
          });
        });

        stream.on('error', (streamErr: Error) => {
          if (timeoutId) clearTimeout(timeoutId);
          reject(streamErr);
        });
      });
    });
  }

  async openPty(command: string, options: PtyOptions): Promise<PtyStream> {
    await this.connect();

    if (!this.client) {
      throw new Error('SSH client is not connected');
    }

    return new Promise<PtyStream>((resolve, reject) => {
      let finalCommand = command;
      if (options.cwd) {
        finalCommand = `cd ${escapeShellArg(options.cwd)} && ${command}`;
      }

      this.client!.exec(
        finalCommand,
        {
          pty: {
            term: 'xterm-256color',
            rows: options.rows || 24,
            cols: options.cols || 80,
          },
          env: options.env,
        },
        (err, stream) => {
          if (err) return reject(err);

          const streamId = `pty-ssh-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;
          const dataListeners: ((data: string) => void)[] = [];
          const exitListeners: ((code: number) => void)[] = [];

          stream.on('data', (data: Buffer) => {
            const str = data.toString('utf8');
            for (const cb of dataListeners) {
              try {
                cb(str);
              } catch (e) {
                console.error('Error in PtyStream onData handler:', e);
              }
            }
          });

          stream.stderr.on('data', (data: Buffer) => {
            const str = data.toString('utf8');
            for (const cb of dataListeners) {
              try {
                cb(str);
              } catch (e) {
                console.error('Error in PtyStream onData handler:', e);
              }
            }
          });

          stream.on('close', (code: number) => {
            for (const cb of exitListeners) {
              try {
                cb(typeof code === 'number' ? code : 0);
              } catch (e) {
                console.error('Error in PtyStream onExit handler:', e);
              }
            }
          });

          const ptyStream: PtyStream = {
            id: streamId,
            onData(callback: (data: string) => void) {
              dataListeners.push(callback);
              return () => {
                const idx = dataListeners.indexOf(callback);
                if (idx !== -1) dataListeners.splice(idx, 1);
              };
            },
            onExit(callback: (code: number) => void) {
              exitListeners.push(callback);
              return () => {
                const idx = exitListeners.indexOf(callback);
                if (idx !== -1) exitListeners.splice(idx, 1);
              };
            },
            write(data: string) {
              if (stream.writable) {
                stream.write(data);
              }
            },
            resize(cols: number, rows: number) {
              try {
                (stream as any).setWindow(rows, cols, 0, 0);
              } catch {
                // Ignore resize errors if stream is closing
              }
            },
            close() {
              try {
                stream.close();
              } catch {
                // Ignore
              }
            },
          };

          resolve(ptyStream);
        }
      );
    });
  }

  private async getSftp(): Promise<SFTPWrapper> {
    await this.connect();

    if (!this.client) {
      throw new Error('SSH client is not connected');
    }

    if (this.sftpClient) {
      return this.sftpClient;
    }

    if (this.sftpPromise) {
      return this.sftpPromise;
    }

    this.sftpPromise = new Promise<SFTPWrapper>((resolve, reject) => {
      this.client!.sftp((err, sftp) => {
        this.sftpPromise = null;
        if (err) {
          this.logger.error('Failed to open SFTP session', err, { serverId: this.serverId });
          return reject(err);
        }
        this.sftpClient = sftp;
        sftp.on('close', () => {
          this.sftpClient = null;
          this.sftpPromise = null;
        });
        resolve(sftp);
      });
    });

    return this.sftpPromise;
  }

  async listFiles(dirPath: string): Promise<FileEntry[]> {
    this.logger.debug('Listing remote files via SFTP', { dirPath, serverId: this.serverId });
    const sftp = await this.getSftp();
    const path = await import('node:path');

    return new Promise((resolve, reject) => {
      sftp.readdir(dirPath, (err, list) => {
        if (err) {
          return reject(new Error(`Failed to list remote directory '${dirPath}': ${err.message || String(err)}`));
        }

        const entries: FileEntry[] = list
          .filter((item) => item.filename !== '.' && item.filename !== '..')
          .map((item) => {
            const fullPath = path.posix.join(dirPath, item.filename);
            const isDir = Boolean(item.attrs.isDirectory && item.attrs.isDirectory());
            const isFile = Boolean(item.attrs.isFile && item.attrs.isFile());
            const size = item.attrs.size || 0;
            const modifiedAt = item.attrs.mtime ? new Date(item.attrs.mtime * 1000) : new Date();

            return {
              name: item.filename,
              path: fullPath,
              isDirectory: isDir,
              isFile,
              size,
              modifiedAt,
            };
          });

        entries.sort((a, b) => {
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return a.name.localeCompare(b.name);
        });

        resolve(entries);
      });
    });
  }

  async readFile(
    filePath: string,
    maxBytes = 2 * 1024 * 1024
  ): Promise<FileContentResult> {
    this.logger.debug('Reading remote file via SFTP', { filePath, maxBytes, serverId: this.serverId });
    const sftp = await this.getSftp();

    const stat = await this.stat(filePath);
    const mimeType = getSshMimeType(filePath);
    const isImage = mimeType.startsWith('image/');
    const effectiveMaxBytes = isImage ? Math.max(maxBytes, 10 * 1024 * 1024) : maxBytes;

    const isTruncated = stat.size > effectiveMaxBytes;
    const lengthToRead = isTruncated ? effectiveMaxBytes : stat.size;

    return new Promise((resolve, reject) => {
      const readStream = sftp.createReadStream(filePath, {
        start: 0,
        end: Math.max(0, lengthToRead - 1),
      });

      const chunks: Buffer[] = [];

      readStream.on('data', (chunk: Buffer) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      readStream.on('error', (streamErr: Error) => {
        reject(new Error(`Failed to read remote file '${filePath}': ${streamErr.message || String(streamErr)}`));
      });

      readStream.on('close', () => {
        const fullBuffer = Buffer.concat(chunks);
        const binary = isImage || isSshBinaryBuffer(fullBuffer);

        let content: string;
        if (isImage) {
          content = `data:${mimeType};base64,${fullBuffer.toString('base64')}`;
        } else if (binary) {
          content = fullBuffer.toString('base64');
        } else {
          content = fullBuffer.toString('utf8');
        }

        resolve({
          path: filePath,
          content,
          isBinary: binary,
          isTruncated,
          sizeBytes: stat.size,
          mimeType,
        });
      });
    });
  }

  async stat(filePath: string): Promise<FileStat> {
    const sftp = await this.getSftp();

    return new Promise((resolve, reject) => {
      sftp.stat(filePath, (err, stats) => {
        if (err) {
          return reject(new Error(`Failed to stat remote path '${filePath}': ${err.message || String(err)}`));
        }

        resolve({
          size: stats.size,
          isDirectory: Boolean(stats.isDirectory && stats.isDirectory()),
          isFile: Boolean(stats.isFile && stats.isFile()),
          modifiedAt: stats.mtime ? new Date(stats.mtime * 1000) : new Date(),
        });
      });
    });
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    const path = await import('node:path');
    await this.mkdir(path.posix.dirname(remotePath));
    const sftp = await this.getSftp();

    return new Promise((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, (err) => {
        if (err) {
          this.logger.error('Failed to upload file over SFTP', err, { localPath, remotePath });
          return reject(new Error(`Failed to upload '${localPath}' to remote '${remotePath}': ${err.message || String(err)}`));
        }
        this.logger.debug('Uploaded file over SFTP', { localPath, remotePath });
        resolve();
      });
    });
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    const sftp = await this.getSftp();

    return new Promise((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, (err) => {
        if (err) {
          this.logger.error('Failed to download file over SFTP', err, { remotePath, localPath });
          return reject(new Error(`Failed to download remote '${remotePath}' to '${localPath}': ${err.message || String(err)}`));
        }
        this.logger.debug('Downloaded file over SFTP', { remotePath, localPath });
        resolve();
      });
    });
  }

  async writeFile(remotePath: string, data: Buffer | Uint8Array | string): Promise<void> {
    const path = await import('node:path');
    await this.mkdir(path.posix.dirname(remotePath));
    const sftp = await this.getSftp();
    const buf = Buffer.isBuffer(data)
      ? data
      : data instanceof Uint8Array
      ? Buffer.from(data)
      : Buffer.from(String(data), 'utf8');

    return new Promise((resolve, reject) => {
      sftp.writeFile(remotePath, buf, (err) => {
        if (err) {
          this.logger.error('Failed to write remote file over SFTP', err, { remotePath });
          return reject(new Error(`Failed to write remote file '${remotePath}': ${err.message || String(err)}`));
        }
        this.logger.debug('Wrote remote file over SFTP', { remotePath, bytes: buf.length });
        resolve();
      });
    });
  }

  async mkdir(dirPath: string): Promise<void> {
    const res = await this.execute(`mkdir -p ${escapeShellArg(dirPath)}`);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to create remote directory '${dirPath}': ${res.stderr}`);
    }
    this.logger.debug('Created remote directory', { dirPath });
  }
}

function getSshMimeType(filePath: string): string {
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

function isSshBinaryBuffer(buf: Buffer): boolean {
  const checkLength = Math.min(buf.length, 1024);
  for (let i = 0; i < checkLength; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
