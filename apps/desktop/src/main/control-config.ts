/**
 * MCP control is part of the normal desktop runtime. It can be disabled for
 * diagnostics or environments that intentionally do not want a local socket.
 */
export function isControlMcpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.SPAWNEA_CONTROL_ENABLED?.trim().toLowerCase();
  if (!value) return true;
  return !['0', 'false', 'off', 'no', 'disabled'].includes(value);
}
