import { shouldRunCli, shouldRunMcpBridge } from './entry-mode.js';

if (shouldRunCli(process.argv)) {
  await import('../cli/index.js');
} else if (shouldRunMcpBridge(process.argv)) {
  await import('../mcp/index.js');
} else {
  await import('./index.js');
}
