import { createConnection } from 'node:net';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  SPAWNEA_CONTROL_API_VERSION,
  type ControlRuntimeDescriptor,
} from '@spawnea/domain';
import { resolveControlRuntimeFileCandidates } from '../main/control-runtime.js';

function runtimeFilesFromArgs(argv: string[]): string[] {
  const index = argv.indexOf('--runtime-file');
  if (index !== -1) {
    const value = argv[index + 1];
    if (!value) throw new Error('--runtime-file requires a path');
    return [resolve(value)];
  }
  return resolveControlRuntimeFileCandidates();
}

async function loadRuntimeDescriptor(path: string): Promise<ControlRuntimeDescriptor> {
  const stat = await lstat(path);
  if (!stat.isFile()) throw new Error(`Spawnea control runtime is not a regular file: ${path}`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('Spawnea control runtime is owned by another user');
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error('Spawnea control runtime permissions are too broad; expected 0600');
  }
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<ControlRuntimeDescriptor>;
  if (
    parsed.apiVersion !== SPAWNEA_CONTROL_API_VERSION
    || typeof parsed.socketPath !== 'string'
    || !parsed.socketPath.startsWith('/')
    || typeof parsed.token !== 'string'
    || !/^[a-f0-9]{64}$/.test(parsed.token)
    || typeof parsed.pid !== 'number'
  ) {
    throw new Error('Spawnea control runtime descriptor is malformed or incompatible');
  }
  return parsed as ControlRuntimeDescriptor;
}

async function main(): Promise<void> {
  const runtimeFiles = runtimeFilesFromArgs(process.argv.slice(2));
  let descriptor: ControlRuntimeDescriptor | undefined;
  let missingError: unknown;
  for (const runtimeFile of runtimeFiles) {
    try {
      descriptor = await loadRuntimeDescriptor(runtimeFile);
      break;
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      missingError = error;
    }
  }
  if (!descriptor) throw missingError ?? new Error('Spawnea control runtime was not found');
  const socket = createConnection(descriptor.socketPath);
  let connectionFailed = false;

  socket.once('connect', () => {
    socket.write(`${JSON.stringify({ type: 'spawnea-auth', token: descriptor.token })}\n`);
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
    process.stdin.resume();
  });
  socket.once('error', (error) => {
    console.error(`Spawnea MCP bridge could not connect: ${error.message}`);
    connectionFailed = true;
  });
  socket.once('close', () => {
    if (!process.stdin.destroyed) process.stdin.pause();
    // The desktop gateway owns the socket. Once Spawnea exits, this one-shot
    // stdio bridge must exit too so the MCP client can restart it cleanly.
    process.exit(connectionFailed ? 1 : 0);
  });

  const shutdown = () => {
    process.stdin.unpipe(socket);
    socket.end();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(`Spawnea MCP bridge failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
