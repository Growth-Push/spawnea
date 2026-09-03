// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, createServer, Socket, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { attachMcpBridgeSocket } from './socket-bridge.js';

describe('packaged MCP socket bridge', () => {
  const servers: Server[] = [];
  const sockets: Socket[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    await Promise.allSettled(
      servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    await Promise.allSettled(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('drains output larger than the writable high-water mark before natural exit', async () => {
    const token = 'a'.repeat(64);
    const payload = Buffer.alloc(1024 * 1024, 'x');
    const directory = await mkdtemp(join(tmpdir(), 'spawnea-mcp-bridge-'));
    directories.push(directory);
    const socketPath = join(directory, 'control.sock');
    let authenticationLine = '';
    const server = createServer((connection) => {
      sockets.push(connection);
      connection.once('data', (chunk) => {
        authenticationLine = chunk.toString('utf8');
        connection.end(payload);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });

    const received: Buffer[] = [];
    const stdout = new Writable({
      highWaterMark: 1024,
      write(chunk, _encoding, callback) {
        setImmediate(() => {
          received.push(Buffer.from(chunk));
          callback();
        });
      },
    });
    const stdin = new PassThrough();
    const client = createConnection(socketPath);
    sockets.push(client);
    const exitCode = new Promise<number>((resolve) => {
      attachMcpBridgeSocket(client, token, {
        stdin,
        stdout,
        reportConnectionError: (error) => {
          throw error;
        },
        setExitCode: resolve,
      });
    });

    await expect(exitCode).resolves.toBe(0);
    await finished(stdout);
    expect(authenticationLine).toBe(`${JSON.stringify({ type: 'spawnea-auth', token })}\n`);
    expect(Buffer.concat(received)).toEqual(payload);
  }, 15000);

  it('reports a failed connection through the process exit code', () => {
    const socket = new Socket();
    sockets.push(socket);
    const stdin = new PassThrough();
    const errors: string[] = [];
    const exitCodes: number[] = [];

    attachMcpBridgeSocket(socket, 'a'.repeat(64), {
      stdin,
      stdout: new PassThrough(),
      reportConnectionError: (error) => errors.push(error.message),
      setExitCode: (code) => exitCodes.push(code),
    });
    socket.emit('error', new Error('connection refused'));
    socket.emit('close', true);

    expect(errors).toEqual(['connection refused']);
    expect(exitCodes).toEqual([1]);
  });
});
