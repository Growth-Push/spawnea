import { describe, expect, it } from 'vitest';
import { isControlEnabled } from './control-config.js';

describe('control runtime configuration', () => {
  it('enables the gateway when the setting is absent or enabled', () => {
    expect(isControlEnabled({}, 'linux')).toBe(true);
    expect(isControlEnabled({ SPAWNEA_CONTROL_ENABLED: '1' }, 'linux')).toBe(true);
    expect(isControlEnabled({ SPAWNEA_CONTROL_ENABLED: 'true' }, 'linux')).toBe(true);
    expect(isControlEnabled({ SPAWNEA_CONTROL_ENABLED: 'enabled' }, 'linux')).toBe(true);
  });

  it('only disables the gateway for explicit disabled values', () => {
    for (const value of ['0', 'false', 'off', 'no', 'disabled', ' FALSE ']) {
      expect(isControlEnabled({ SPAWNEA_CONTROL_ENABLED: value }, 'linux')).toBe(false);
    }

    expect(isControlEnabled({ SPAWNEA_CONTROL_ENABLED: 'unexpected-value' }, 'linux')).toBe(true);
  });

  it('disables the gateway for an explicit canonical setting', () => {
    expect(isControlEnabled({ SPAWNEA_CONTROL_ENABLED: '0' }, 'linux')).toBe(false);
  });

  it('disables the gateway on Windows until named-pipe transport is available', () => {
    expect(isControlEnabled({}, 'win32')).toBe(false);
    expect(isControlEnabled({ SPAWNEA_CONTROL_ENABLED: '1' }, 'win32')).toBe(false);
  });
});
