import { lstat, readFile, unlink } from 'node:fs/promises';
import type { ControlRuntimeDescriptor } from '@spawnea/domain';

async function pathMatches(path: string, expected: 'file' | 'socket'): Promise<boolean> {
  try {
    const stat = await lstat(path);
    const owned = typeof process.getuid !== 'function' || stat.uid === process.getuid();
    const expectedType = expected === 'file' ? stat.isFile() : stat.isSocket();
    return owned && expectedType;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function runtimeBelongsToProcess(runtimeFilePath: string, parentPid: number): Promise<boolean> {
  if (!(await pathMatches(runtimeFilePath, 'file'))) return false;
  try {
    const descriptor = JSON.parse(await readFile(runtimeFilePath, 'utf8')) as Partial<ControlRuntimeDescriptor>;
    return descriptor.pid === parentPid;
  } catch {
    return false;
  }
}

async function processIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

export async function cleanupExitedControlRuntime(
  parentPid: number,
  runtimeFilePath: string,
  socketPath: string
): Promise<boolean> {
  if (await processIsAlive(parentPid)) return false;
  if (!(await runtimeBelongsToProcess(runtimeFilePath, parentPid))) return false;

  await unlink(runtimeFilePath);
  if (await pathMatches(socketPath, 'socket')) {
    await unlink(socketPath);
  }
  return true;
}

export async function watchControlRuntime(
  parentPid: number,
  runtimeFilePath: string,
  socketPath: string,
  pollIntervalMs = 100
): Promise<void> {
  while (await runtimeBelongsToProcess(runtimeFilePath, parentPid)) {
    if (!(await processIsAlive(parentPid))) {
      await cleanupExitedControlRuntime(parentPid, runtimeFilePath, socketPath);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
