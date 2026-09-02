export function shouldRunMcpBridge(argv: readonly string[]): boolean {
  return argv.includes('--spawnea-mcp');
}
