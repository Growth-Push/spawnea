/**
 * MCP control is part of the normal desktop runtime on Unix-like systems. It
 * can be disabled for diagnostics or environments that intentionally do not
 * want a local socket. Windows remains disabled until named-pipe transport is
 * implemented.
 */
export function isControlMcpEnabled(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') return false;
  const value = env.SPAWNEA_CONTROL_ENABLED?.trim().toLowerCase();
  if (!value) return true;
  return !['0', 'false', 'off', 'no', 'disabled'].includes(value);
}
