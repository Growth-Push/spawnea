import { createConnection, type Socket } from 'node:net';
import { lstat, readFile } from 'node:fs/promises';
import {
  SPAWNEA_CONTROL_API_VERSION,
  type ControlRuntimeDescriptor,
} from '@spawnea/domain';
import { runtimeFilesFromArgs } from '../mcp/runtime-args.js';

export interface ControlCliClientOptions {
  profile?: string;
  runtimeFile?: string;
  sessionId?: string;
  env?: NodeJS.ProcessEnv;
}

export async function loadControlRuntime(
  options: ControlCliClientOptions = {},
): Promise<ControlRuntimeDescriptor> {
  const env = options.env ?? process.env;
  const runtimeFiles = options.runtimeFile
    ? [options.runtimeFile]
    : runtimeFilesFromArgs(options.profile ? ['--profile', options.profile] : [], env);

  let descriptor: ControlRuntimeDescriptor | undefined;
  for (const candidate of runtimeFiles) {
    try {
      const stat = await lstat(candidate);
      if (!stat.isFile()) continue;
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) continue;
      if ((stat.mode & 0o077) !== 0) continue;

      const parsed = JSON.parse(await readFile(candidate, 'utf8')) as Partial<ControlRuntimeDescriptor>;
      if (
        parsed.apiVersion === SPAWNEA_CONTROL_API_VERSION &&
        typeof parsed.socketPath === 'string' &&
        parsed.socketPath.startsWith('/') &&
        typeof parsed.token === 'string' &&
        /^[a-f0-9]{64}$/.test(parsed.token) &&
        typeof parsed.pid === 'number'
      ) {
        descriptor = parsed as ControlRuntimeDescriptor;
        break;
      }
    } catch {
      // Check next candidate
    }
  }

  if (!descriptor) {
    throw new Error('Spawnea desktop app is not running (control runtime descriptor not found). Start Spawnea first.');
  }

  return descriptor;
}

export class ControlCliClient {
  private socket: Socket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (res: any) => void; reject: (err: Error) => void }>();
  private buffer = '';

  private constructor(
    private readonly descriptor: ControlRuntimeDescriptor,
    private readonly sessionId?: string,
  ) {}

  static async connect(options: ControlCliClientOptions = {}): Promise<ControlCliClient> {
    const descriptor = await loadControlRuntime(options);
    const client = new ControlCliClient(descriptor, options.sessionId);
    await client.init();
    return client;
  }

  private async init(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(this.descriptor.socketPath);
      socket.setEncoding('utf8');
      this.socket = socket;

      const onError = (err: Error) => {
        socket.destroy();
        reject(new Error(`Spawnea desktop app is not responding (control socket unavailable: ${err.message}). Start Spawnea first.`));
      };

      socket.once('error', onError);

      socket.once('connect', () => {
        socket.removeListener('error', onError);

        const handleSocketClose = (reason: string) => {
          for (const { reject } of this.pending.values()) {
            reject(new Error(`Control socket connection closed: ${reason}`));
          }
          this.pending.clear();
        };

        socket.on('error', (err) => handleSocketClose(`socket error: ${err.message}`));
        socket.on('close', () => handleSocketClose('socket closed'));
        socket.on('end', () => handleSocketClose('socket ended'));

        socket.on('data', (chunk) => this.handleData(chunk));

        // Send Spawnea authentication frame
        const auth = {
          type: 'spawnea-auth',
          token: this.descriptor.token,
          mode: 'cli',
          sessionId: this.sessionId || undefined,
        };
        socket.write(`${JSON.stringify(auth)}\n`);
        resolve();
      });
    });

    // Complete MCP handshake
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'spawnea-cli', version: '1.0.0' },
    });

    this.sendNotification('notifications/initialized');
  }

  private handleData(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) {
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) {
              reject(new Error(msg.error.message || `RPC Error ${msg.error.code}`));
            } else {
              resolve(msg.result);
            }
          }
        } catch {
          // Ignore malformed line
        }
      }
      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  private sendRequest(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        return reject(new Error('Connection to Spawnea control socket was closed'));
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request '${method}' timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.socket.write(`${payload}\n`);
    });
  }

  private sendNotification(method: string, params: Record<string, unknown> = {}): void {
    if (!this.socket || this.socket.destroyed) return;
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.socket.write(`${payload}\n`);
  }

  async callTool<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.sendRequest('tools/call', { name, arguments: args });
    if (result?.isError) {
      const msg = result.structuredContent?.error?.message ||
                  result.content?.map((c: any) => c.text).join('\n') ||
                  'Operation failed';
      throw new Error(msg);
    }
    return (result?.structuredContent ?? result) as T;
  }

  close(): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.socket = null;
    for (const { reject } of this.pending.values()) {
      reject(new Error('Control socket connection was closed'));
    }
    this.pending.clear();
  }
}
