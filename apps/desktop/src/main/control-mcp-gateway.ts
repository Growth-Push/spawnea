import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, createConnection, type Server as NetServer, type Socket } from 'node:net';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport, serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import {
  SPAWNEA_CONTROL_API_VERSION,
  type ControlRuntimeDescriptor,
  type Logger,
} from '@spawnea/domain';
import type { AgentControlService } from './agent-control-service.js';
import { createSpawneaMcpServer } from './control-mcp-server.js';
import { resolveControlRuntimeFile, resolveControlSocketPath } from './control-runtime.js';

const AUTH_TIMEOUT_MS = 3_000;
const MAX_AUTH_BYTES = 4_096;

export interface ControlMcpGatewayOptions {
  control: AgentControlService;
  logger: Logger;
  runtimeFilePath?: string;
  socketPath?: string;
}

function sameToken(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function removeOwnedRuntimePath(path: string, expected: 'file' | 'socket'): Promise<void> {
  if (!(await pathExists(path))) return;
  const stat = await lstat(path);
  const owned = typeof process.getuid !== 'function' || stat.uid === process.getuid();
  const expectedType = expected === 'file' ? stat.isFile() : stat.isSocket();
  if (!owned || !expectedType) {
    throw new Error(`Refusing to replace unexpected ${expected} path: ${path}`);
  }
  await unlink(path);
}

async function processIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

export class ControlMcpGateway {
  readonly runtimeFilePath: string;
  readonly socketPath: string;
  private readonly control: AgentControlService;
  private readonly logger: Logger;
  private readonly token = randomBytes(32).toString('hex');
  private readonly handles = new Set<StdioServerHandle>();
  private server: NetServer | null = null;

  constructor(options: ControlMcpGatewayOptions) {
    this.control = options.control;
    this.logger = options.logger;
    this.runtimeFilePath = options.runtimeFilePath ?? resolveControlRuntimeFile();
    this.socketPath = options.socketPath ?? resolveControlSocketPath();
  }

  private startCleanupWatchdog(): void {
    if (!process.versions.electron) return;

    const watchdogPath = fileURLToPath(new URL('./spawnea-mcp-watchdog.js', import.meta.url));
    const watchdog = spawn(
      process.execPath,
      [watchdogPath, String(process.pid), this.runtimeFilePath, this.socketPath],
      {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      }
    );
    watchdog.once('error', (error) => {
      this.logger.warn('Failed to start Spawnea MCP runtime cleanup watchdog', { error: error.message });
    });
    watchdog.unref();
  }

  private async clearStaleRuntime(): Promise<void> {
    if (await pathExists(this.runtimeFilePath)) {
      let descriptor: Partial<ControlRuntimeDescriptor> | null = null;
      try {
        descriptor = JSON.parse(await readFile(this.runtimeFilePath, 'utf8'));
      } catch {
        // Ownership/type checks below still prevent deleting an unrelated path.
      }
      if (typeof descriptor?.pid === 'number' && await processIsAlive(descriptor.pid)) {
        throw new Error(`Another Spawnea control runtime is active (PID ${descriptor.pid})`);
      }
      await removeOwnedRuntimePath(this.runtimeFilePath, 'file');
    }
    await removeOwnedRuntimePath(this.socketPath, 'socket');
  }

  async start(): Promise<ControlRuntimeDescriptor> {
    if (this.server) throw new Error('Spawnea control gateway is already running');
    await mkdir(dirname(this.runtimeFilePath), { recursive: true, mode: 0o700 });
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.runtimeFilePath), 0o700);
    if (dirname(this.socketPath) !== dirname(this.runtimeFilePath)) {
      await chmod(dirname(this.socketPath), 0o700);
    }
    await this.clearStaleRuntime();

    const server = createServer((socket) => this.authenticate(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.socketPath);
    });
    await chmod(this.socketPath, 0o600);

    const descriptor: ControlRuntimeDescriptor = {
      apiVersion: SPAWNEA_CONTROL_API_VERSION,
      socketPath: this.socketPath,
      token: this.token,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };
    const tempPath = `${this.runtimeFilePath}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(descriptor)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, this.runtimeFilePath);
    await chmod(this.runtimeFilePath, 0o600);
    this.startCleanupWatchdog();
    this.logger.info('Spawnea MCP control gateway enabled', {
      runtimeFilePath: this.runtimeFilePath,
      socketPath: this.socketPath,
    });
    return descriptor;
  }

  private authenticate(socket: Socket): void {
    socket.pause();
    let buffered = Buffer.alloc(0);
    const timeout = setTimeout(() => socket.destroy(), AUTH_TIMEOUT_MS);
    const fail = () => {
      clearTimeout(timeout);
      socket.removeListener('data', onData);
      socket.destroy();
      this.logger.warn('Rejected unauthorized Spawnea MCP socket connection');
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_AUTH_BYTES) return fail();
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) return;

      let auth: { type?: unknown; token?: unknown };
      try {
        auth = JSON.parse(buffered.subarray(0, newline).toString('utf8'));
      } catch {
        return fail();
      }
      if (auth.type !== 'spawnea-auth' || !sameToken(auth.token, this.token)) return fail();

      clearTimeout(timeout);
      socket.removeListener('data', onData);
      const remainder = buffered.subarray(newline + 1);
      if (remainder.length > 0) socket.unshift(remainder);
      const transport = new StdioServerTransport(socket, socket, { maxBufferSize: 2 * 1024 * 1024 });
      const handle = serveStdio(() => createSpawneaMcpServer(this.control), {
        transport,
        onerror: (error) => this.logger.warn('Spawnea MCP transport error', { error: error.message }),
      });
      this.handles.add(handle);
      socket.once('close', () => this.handles.delete(handle));
      socket.resume();
    };
    socket.on('data', onData);
    socket.once('error', () => clearTimeout(timeout));
    socket.resume();
  }

  async close(): Promise<void> {
    const handles = Array.from(this.handles);
    this.handles.clear();
    await Promise.allSettled(handles.map((handle) => handle.close()));
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await removeOwnedRuntimePath(this.runtimeFilePath, 'file').catch(() => {});
    await removeOwnedRuntimePath(this.socketPath, 'socket').catch(() => {});
  }
}

export async function canConnectToControlSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}
