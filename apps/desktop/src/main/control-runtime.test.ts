import { describe, expect, it } from 'vitest';
import {
  resolveControlRuntimeDirectory,
  resolveControlRuntimeFile,
  resolveControlRuntimeFileCandidates,
  resolveControlSocketPath,
} from './control-runtime.js';

describe('Spawnea control runtime paths', () => {
  it('uses the canonical Spawnea XDG runtime directory by default', () => {
    const env = { XDG_RUNTIME_DIR: '/run/user/1000' };
    expect(resolveControlRuntimeDirectory(env)).toBe('/run/user/1000/spawnea');
    expect(resolveControlRuntimeFile(env)).toBe('/run/user/1000/spawnea/control-runtime.json');
    expect(resolveControlSocketPath(env)).toBe('/run/user/1000/spawnea/control.sock');
    expect(resolveControlRuntimeFileCandidates(env)).toEqual([
      '/run/user/1000/spawnea/control-runtime.json',
    ]);
  });

  it('uses canonical Spawnea overrides', () => {
    expect(resolveControlRuntimeDirectory({
      SPAWNEA_CONTROL_RUNTIME_DIR: '/tmp/spawnea-new',
    })).toBe('/tmp/spawnea-new');
    expect(resolveControlRuntimeDirectory({ SPAWNEA_CONTROL_RUNTIME_DIR: '/tmp/spawnea-old' }))
      .toBe('/tmp/spawnea-old');
    expect(resolveControlRuntimeFile({ SPAWNEA_CONTROL_RUNTIME_FILE: '/tmp/legacy.json' }))
      .toBe('/tmp/legacy.json');
    expect(resolveControlSocketPath({ SPAWNEA_CONTROL_SOCKET: '/tmp/legacy.sock' }))
      .toBe('/tmp/legacy.sock');
  });
});
