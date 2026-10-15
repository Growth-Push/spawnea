import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, createConnection, type Server as NetServer, type Socket } from 'node:net';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import {
  SPAWNEA_CONTROL_API_VERSION,
  type ControlRuntimeDescriptor,
  type Logger,
} from '@spawnea/domain';
import type { AgentControlService } from './agent-control-service.js';
import {
  controlErrorEnvelope,
  createControlOperations,
  type ControlOperations,
} from './control-operations.js';
import { resolveControlRuntimeFile, resolveControlSocketPath } from './control-runtime.js';

const AUTH_TIMEOUT_MS = 3_000;
const AUTH_SCOPE_RETRY_INTERVAL_MS = 50;
const MAX_AUTH_BYTES = 4_096;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
// Above the CLI's longest request timeout (root/child creation, 120 s).
const REJECTED_DRAIN_TIMEOUT_MS = 150_000;

export interface ControlGatewayOptions {
  control: AgentControlService;
  logger: Logger;
  profile?: string;
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

export class ControlGateway {
  readonly runtimeFilePath: string;
  readonly socketPath: string;
  private readonly control: AgentControlService;
  private readonly logger: Logger;
  private readonly token = randomBytes(32).toString('hex');
  private readonly sockets = new Set<Socket>();
  private server: NetServer | null = null;
  private ownsSocketPath = false;
  private ownsRuntimeFilePath = false;

  constructor(options: ControlGatewayOptions) {
    this.control = options.control;
    this.logger = options.logger;
    this.runtimeFilePath = options.runtimeFilePath ?? resolveControlRuntimeFile(process.env, options.profile);
    this.socketPath = options.socketPath ?? resolveControlSocketPath(process.env, options.profile);

  }

  private startCleanupWatchdog(): void {
    if (!process.versions.electron) return;

    const watchdogPath = fileURLToPath(new URL('./spawnea-control-watchdog.js', import.meta.url));
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
      this.logger.warn('Failed to start Spawnea control runtime cleanup watchdog', { error: error.message });
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

    const server = createServer((socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
      this.authenticate(socket);
    });
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
    this.ownsSocketPath = true;
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
    try {
      await rename(tempPath, this.runtimeFilePath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
    this.ownsRuntimeFilePath = true;
    await chmod(this.runtimeFilePath, 0o600);
    this.startCleanupWatchdog();
    this.logger.info('Spawnea control gateway enabled', {
      runtimeFilePath: this.runtimeFilePath,
      socketPath: this.socketPath,
    });
    return descriptor;
  }

  private authenticate(socket: Socket): void {
    socket.pause();
    let buffered = Buffer.alloc(0);
    let authenticating = false;
    const timeout = setTimeout(() => socket.destroy(), AUTH_TIMEOUT_MS);
    const fail = () => {
      clearTimeout(timeout);
      socket.removeListener('data', onData);
      socket.destroy();
      this.logger.warn('Rejected unauthorized Spawnea control socket connection');
    };
    const handleChunk = async (chunk: Buffer) => {
      if (authenticating) return;
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      // Only the authentication line is bounded here; bytes after it belong to the first request.
      if (newline === -1 ? buffered.length > MAX_AUTH_BYTES : newline > MAX_AUTH_BYTES) return fail();
      if (newline === -1) return;

      let auth: { type?: unknown; token?: unknown; sessionId?: unknown };
      try {
        auth = JSON.parse(buffered.subarray(0, newline).toString('utf8'));
      } catch {
        return fail();
      }
      if (auth.type !== 'spawnea-auth' || !sameToken(auth.token, this.token) ||
          (auth.sessionId !== undefined && (typeof auth.sessionId !== 'string' || auth.sessionId.length === 0))) return fail();
      authenticating = true;
      socket.pause();
      socket.removeListener('data', onData);
      let operations: ControlOperations;
      if (typeof auth.sessionId === 'string') {
        let scopedControl: Awaited<ReturnType<AgentControlService['createScopedControl']>>;
        const deadline = Date.now() + AUTH_TIMEOUT_MS;
        while (true) {
          try {
            scopedControl = await this.control.createScopedControl(auth.sessionId, { allowChildSession: true });
            break;
          } catch {
            if (socket.destroyed || Date.now() >= deadline) return fail();
            await new Promise((resolve) => setTimeout(resolve, AUTH_SCOPE_RETRY_INTERVAL_MS));
          }
        }
        operations = createControlOperations(scopedControl, { isScoped: true });
      } else {
        operations = createControlOperations(this.control, { isScoped: false });
      }

      if (socket.destroyed) return fail();

      clearTimeout(timeout);
      const remainder = buffered.subarray(newline + 1);
      this.serveOperations(socket, operations, remainder);
    };
    const onData = (chunk: Buffer) => {
      handleChunk(chunk).catch(() => fail());
    };
    socket.on('data', onData);
    socket.once('error', () => clearTimeout(timeout));
    socket.resume();
  }

  private serveOperations(socket: Socket, operations: ControlOperations, initial: Buffer): void {
    // One decoder for the remainder of the authentication chunk and every later chunk, so a
    // multibyte character split across chunks is not corrupted.
    const decoder = new StringDecoder('utf8');
    let buffered = decoder.write(initial);
    const respond = (payload: Record<string, unknown>) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(payload)}\n`);
    };
    // Requests dispatched before an oversized frame still get their replies; the socket is
    // ended only after every in-flight handler has settled.
    let inFlight = 0;
    let rejected = false;
    const endWhenIdle = () => {
      if (rejected && inFlight === 0 && !socket.destroyed) socket.end();
    };
    const reject = () => {
      buffered = '';
      rejected = true;
      respond({ id: null, error: { code: 'invalid_request', message: 'Request exceeds the maximum size' } });
      // Bound the wait for in-flight handlers so a stuck operation cannot hold the socket open.
      const deadline = setTimeout(() => socket.destroy(), REJECTED_DRAIN_TIMEOUT_MS);
      deadline.unref();
      socket.once('close', () => clearTimeout(deadline));
      endWhenIdle();
    };
    const handleLine = async (line: string) => {
      let request: { id?: unknown; method?: unknown; params?: unknown } | null;
      try {
        request = JSON.parse(line);
      } catch {
        respond({ id: null, error: { code: 'invalid_request', message: 'Malformed JSON request' } });
        return;
      }
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        respond({ id: null, error: { code: 'invalid_request', message: 'Request must be a JSON object' } });
        return;
      }
      const id = typeof request.id === 'number' || typeof request.id === 'string' ? request.id : null;
      if (typeof request.method !== 'string') {
        respond({ id, error: { code: 'invalid_request', message: 'Request is missing a method' } });
        return;
      }
      const result = await operations.call(request.method, request.params);
      if (result.ok) {
        respond({ id, result: result.value });
      } else {
        respond({ id, error: result.error, details: controlErrorEnvelope(result.error) });
      }
    };
    const drain = () => {
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) return reject();
        if (line) {
          inFlight += 1;
          void handleLine(line)
            .catch((error) => {
              this.logger.warn('Spawnea control request failed', { error: error instanceof Error ? error.message : String(error) });
            })
            .finally(() => {
              inFlight -= 1;
              endWhenIdle();
            });
        }
        newline = buffered.indexOf('\n');
      }
      if (Buffer.byteLength(buffered) > MAX_REQUEST_BYTES) reject();
    };
    socket.on('data', (chunk: Buffer | string) => {
      if (rejected) return;
      buffered += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      drain();
    });
    socket.on('error', () => undefined);
    drain();
    socket.resume();
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (this.ownsRuntimeFilePath) {
      this.ownsRuntimeFilePath = false;
      await removeOwnedRuntimePath(this.runtimeFilePath, 'file').catch(() => {});
    }
    if (this.ownsSocketPath) {
      this.ownsSocketPath = false;
      await removeOwnedRuntimePath(this.socketPath, 'socket').catch(() => {});
    }
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
