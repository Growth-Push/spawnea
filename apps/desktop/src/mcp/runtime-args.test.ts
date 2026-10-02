import { describe, expect, it } from 'vitest';
import { runtimeFilesFromArgs } from './runtime-args.js';

describe('MCP runtimeFilesFromArgs', () => {
  it('returns explicit --runtime-file when specified', () => {
    expect(runtimeFilesFromArgs(['--runtime-file', '/tmp/custom-runtime.json']))
      .toEqual(['/tmp/custom-runtime.json']);
  });

  it('throws when --runtime-file is missing its argument', () => {
    expect(() => runtimeFilesFromArgs(['--runtime-file'])).toThrow('--runtime-file requires a path');
  });

  it('resolves profile candidates when --profile is provided', () => {
    const env = { XDG_RUNTIME_DIR: '/run/user/1000' };
    const candidates = runtimeFilesFromArgs(['--profile', 'agent-worker'], env);
    expect(candidates[0]).toBe('/run/user/1000/spawnea/profiles/agent-worker/control-runtime.json');
  });

  it('resolves profile candidates when --profile= is provided', () => {
    const env = { XDG_RUNTIME_DIR: '/run/user/1000' };
    const candidates = runtimeFilesFromArgs(['--profile=agent-worker'], env);
    expect(candidates[0]).toBe('/run/user/1000/spawnea/profiles/agent-worker/control-runtime.json');
  });

  it('resolves profile candidates from SPAWNEA_PROFILE environment variable', () => {
    const env = { XDG_RUNTIME_DIR: '/run/user/1000', SPAWNEA_PROFILE: 'chatgpt' };
    const candidates = runtimeFilesFromArgs([], env);
    expect(candidates[0]).toBe('/run/user/1000/spawnea/profiles/chatgpt/control-runtime.json');
  });

  it('resolves default candidates when no profile is given', () => {
    const env = { XDG_RUNTIME_DIR: '/run/user/1000' };
    const candidates = runtimeFilesFromArgs([], env);
    expect(candidates[0]).toBe('/run/user/1000/spawnea/control-runtime.json');
  });

  it('throws on invalid profile name in args or env', () => {
    expect(() => runtimeFilesFromArgs(['--profile', 'invalid/name'])).toThrow('Invalid profile name');
    expect(() => runtimeFilesFromArgs([], { SPAWNEA_PROFILE: 'invalid..name' })).toThrow('Invalid profile name');
  });
});
