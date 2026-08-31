import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { cleanupExitedControlRuntime } from './control-runtime-watchdog.js';

describe('control runtime cleanup watchdog', () => {
  const directories: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.allSettled(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await Promise.allSettled(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function createRuntime(parentPid: number) {
    const directory = await mkdtemp(join(tmpdir(), 'spawnea-control-watchdog-'));
    directories.push(directory);
    const runtimeFilePath = join(directory, 'runtime.json');
    const socketPath = join(directory, 'control.sock');
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    await writeFile(runtimeFilePath, JSON.stringify({ pid: parentPid }), { mode: 0o600 });
    return { runtimeFilePath, socketPath };
  }

  it('removes owner-controlled runtime paths for the exited descriptor PID', async () => {
    const deadPid = 2_147_483_647;
    const runtime = await createRuntime(deadPid);

    await expect(cleanupExitedControlRuntime(deadPid, runtime.runtimeFilePath, runtime.socketPath)).resolves.toBe(true);
    await expect(stat(runtime.runtimeFilePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(runtime.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not remove paths when the descriptor belongs to a different process', async () => {
    const runtime = await createRuntime(process.pid);

    await expect(cleanupExitedControlRuntime(2_147_483_647, runtime.runtimeFilePath, runtime.socketPath)).resolves.toBe(false);
    expect(JSON.parse(await readFile(runtime.runtimeFilePath, 'utf8'))).toEqual({ pid: process.pid });
    await expect(stat(runtime.socketPath)).resolves.toBeDefined();
  });
});
