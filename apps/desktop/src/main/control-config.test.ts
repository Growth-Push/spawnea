import { describe, expect, it } from 'vitest';
import { isControlMcpEnabled } from './control-config.js';

describe('MCP control runtime configuration', () => {
  it('enables the gateway when the setting is absent or enabled', () => {
    expect(isControlMcpEnabled({}, 'linux')).toBe(true);
    expect(isControlMcpEnabled({ SPAWNEA_CONTROL_ENABLED: '1' }, 'linux')).toBe(true);
    expect(isControlMcpEnabled({ SPAWNEA_CONTROL_ENABLED: 'true' }, 'linux')).toBe(true);
    expect(isControlMcpEnabled({ SPAWNEA_CONTROL_ENABLED: 'enabled' }, 'linux')).toBe(true);
  });

  it('only disables the gateway for explicit disabled values', () => {
    for (const value of ['0', 'false', 'off', 'no', 'disabled', ' FALSE ']) {
      expect(isControlMcpEnabled({ SPAWNEA_CONTROL_ENABLED: value }, 'linux')).toBe(false);
    }

    expect(isControlMcpEnabled({ SPAWNEA_CONTROL_ENABLED: 'unexpected-value' }, 'linux')).toBe(true);
  });

  it('disables the gateway for an explicit canonical setting', () => {
    expect(isControlMcpEnabled({ SPAWNEA_CONTROL_ENABLED: '0' }, 'linux')).toBe(false);
  });

  it('disables the gateway on Windows until named-pipe transport is available', () => {
    expect(isControlMcpEnabled({}, 'win32')).toBe(false);
    expect(isControlMcpEnabled({ SPAWNEA_CONTROL_ENABLED: '1' }, 'win32')).toBe(false);
  });
});
