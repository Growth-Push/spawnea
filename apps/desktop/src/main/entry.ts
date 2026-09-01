import { shouldRunMcpBridge } from './entry-mode.js';

if (shouldRunMcpBridge(process.argv)) {
  await import('../mcp/index.js');
} else {
  await import('./index.js');
}
