import { describe, expect, it } from 'vitest';
import { isControlMcpEnabled } from './control-config.js';

describe('MCP control runtime configuration', () => {
  it('enables the gateway when the setting is absent or enabled', () => {
    expect(isControlMcpEnabled({})).toBe(true);
    expect(isControlMcpEnabled({ SPAWNEA_CONTROL_ENABLED: '1' })).toBe(true);
    expect(isControlMcpEnabled({ SPAWNEA_CONTROL_ENABLED: 'true' })).toBe(true);
    expect(isControlMcpEnabled({ SPAWNEA_CONTROL_ENABLED: 'enabled' })).toBe(true);
  });

  it('only disables the gateway for explicit disabled values', () => {
    for (const value of ['0', 'false', 'off', 'no', 'disabled', ' FALSE ']) {
      expect(isControlMcpEnabled({ SPAWNEA_CONTROL_ENABLED: value })).toBe(false);
    }

    expect(isControlMcpEnabled({ SPAWNEA_CONTROL_ENABLED: 'unexpected-value' })).toBe(true);
  });

  it('disables the gateway for an explicit canonical setting', () => {
    expect(isControlMcpEnabled({ SPAWNEA_CONTROL_ENABLED: '0' })).toBe(false);
  });
});
