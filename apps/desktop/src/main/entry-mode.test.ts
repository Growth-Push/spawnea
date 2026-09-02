import { describe, expect, it } from 'vitest';
import { shouldRunMcpBridge } from './entry-mode.js';

describe('desktop entry mode', () => {
  it('selects the MCP bridge only for the explicit packaged-app flag', () => {
    expect(shouldRunMcpBridge(['Spawnea', '--spawnea-mcp'])).toBe(true);
    expect(shouldRunMcpBridge(['Spawnea', '--smoke-test'])).toBe(false);
    expect(shouldRunMcpBridge(['Spawnea'])).toBe(false);
  });
});
