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
    expect(resolveControlRuntimeFileCandidates(env)[0]).toBe('/run/user/1000/spawnea/control-runtime.json');
    expect(new Set(resolveControlRuntimeFileCandidates(env)).size)
      .toBe(resolveControlRuntimeFileCandidates(env).length);
  });

  it('discovers the standard Linux runtime directory when XDG_RUNTIME_DIR is missing', () => {
    if (typeof process.getuid !== 'function') return;
    expect(resolveControlRuntimeFileCandidates({})).toContain(
      `/run/user/${process.getuid()}/spawnea/control-runtime.json`,
    );
  });

  it('uses canonical Spawnea overrides', () => {
    expect(resolveControlRuntimeDirectory({
      SPAWNEA_CONTROL_RUNTIME_DIR: '/tmp/spawnea-new',
    })).toBe('/tmp/spawnea-new');
    expect(resolveControlRuntimeDirectory({ SPAWNEA_CONTROL_RUNTIME_DIR: '/tmp/spawnea-old' }))
      .toBe('/tmp/spawnea-old');
    expect(resolveControlRuntimeFile({ SPAWNEA_CONTROL_RUNTIME_FILE: '/tmp/legacy.json' }))
      .toBe('/tmp/legacy.json');
    expect(resolveControlRuntimeFileCandidates({ SPAWNEA_CONTROL_RUNTIME_FILE: '/tmp/legacy.json' }))
      .toEqual(['/tmp/legacy.json']);
    expect(resolveControlSocketPath({ SPAWNEA_CONTROL_SOCKET: '/tmp/legacy.sock' }))
      .toBe('/tmp/legacy.sock');
  });

  it('canonicalizes identities across all runtime paths and candidates', () => {
    const env = { XDG_RUNTIME_DIR: '/run/user/1000', SPAWNEA_PROFILE: ' Work ' };
    expect(resolveControlRuntimeDirectory(env)).toBe('/run/user/1000/spawnea/profiles/work');
    expect(resolveControlRuntimeFile(env, 'Work')).toBe('/run/user/1000/spawnea/profiles/work/control-runtime.json');
    expect(resolveControlSocketPath(env, 'Work')).toBe('/run/user/1000/spawnea/profiles/work/control.sock');
    expect(resolveControlRuntimeFileCandidates(env, 'Work'))
      .toEqual(resolveControlRuntimeFileCandidates(env, 'work'));
    expect(resolveControlRuntimeFile({ SPAWNEA_CONTROL_RUNTIME_FILE: '/tmp/Explicit.json' }, 'invalid/name'))
      .toBe('/tmp/Explicit.json');
    expect(resolveControlSocketPath({ SPAWNEA_CONTROL_SOCKET: '/tmp/Explicit.sock' }, 'invalid/name'))
      .toBe('/tmp/Explicit.sock');
  });

  it('resolves profile-scoped runtime paths when profile parameter or environment variable is set', () => {
    const env = { XDG_RUNTIME_DIR: '/run/user/1000' };
    expect(resolveControlRuntimeDirectory(env, 'project-a')).toBe('/run/user/1000/spawnea/profiles/project-a');
    expect(resolveControlRuntimeFile(env, 'project-a'))
      .toBe('/run/user/1000/spawnea/profiles/project-a/control-runtime.json');
    expect(resolveControlSocketPath(env, 'project-a'))
      .toBe('/run/user/1000/spawnea/profiles/project-a/control.sock');
    expect(resolveControlRuntimeFileCandidates(env, 'project-a')[0])
      .toBe('/run/user/1000/spawnea/profiles/project-a/control-runtime.json');

    // Inherit from SPAWNEA_PROFILE env var when argument is omitted
    const envWithProfile = { XDG_RUNTIME_DIR: '/run/user/1000', SPAWNEA_PROFILE: 'chatgpt' };
    expect(resolveControlRuntimeDirectory(envWithProfile)).toBe('/run/user/1000/spawnea/profiles/chatgpt');
    expect(resolveControlSocketPath(envWithProfile)).toBe('/run/user/1000/spawnea/profiles/chatgpt/control.sock');
  });
});
