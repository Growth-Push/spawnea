export function shouldRunCli(argv: readonly string[]): boolean {
  return argv.includes('--spawnea-cli');
}
