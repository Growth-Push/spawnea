import { isAbsolute } from 'node:path';
import { watchControlRuntime } from '../main/control-runtime-watchdog.js';

async function main(): Promise<void> {
  const [parentPidText, runtimeFilePath, socketPath] = process.argv.slice(2);
  const parentPid = Number(parentPidText);
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) {
    throw new Error('Spawnea MCP watchdog requires a positive parent PID');
  }
  if (!runtimeFilePath || !socketPath || !isAbsolute(runtimeFilePath) || !isAbsolute(socketPath)) {
    throw new Error('Spawnea MCP watchdog requires absolute runtime and socket paths');
  }
  await watchControlRuntime(parentPid, runtimeFilePath, socketPath);
}

main().catch((error) => {
  console.error(`Spawnea MCP watchdog failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
