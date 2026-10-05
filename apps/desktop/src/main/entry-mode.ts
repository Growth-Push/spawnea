export function shouldRunMcpBridge(argv: readonly string[]): boolean {
  return argv.includes('--spawnea-mcp');
}

export function shouldRunCli(argv: readonly string[]): boolean {
  return argv.includes('--spawnea-cli');
}
