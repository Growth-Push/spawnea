import { shouldRunCli, shouldRunMcpBridge } from './entry-mode.js';

if (shouldRunCli(process.argv)) {
  const { runCli } = await import('../cli/index.js');
  const cliIdx = process.argv.indexOf('--spawnea-cli');
  const cliArgs = cliIdx !== -1 ? process.argv.slice(cliIdx + 1) : process.argv.slice(2);
  try {
    await runCli(cliArgs);
    process.exit(process.exitCode ?? 0);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`spawnea error: ${message}`);
    process.exit(1);
  }
} else if (shouldRunMcpBridge(process.argv)) {
  await import('../mcp/index.js');
} else {
  await import('./index.js');
}
