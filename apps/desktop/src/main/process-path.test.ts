import { describe, expect, it } from 'vitest';
import { delimiter } from 'node:path';
import { initializeProcessPath } from './process-path.js';

describe('desktop process PATH', () => {
  it('preserves the inherited Unix PATH and adds common user executable locations', () => {
    const env: NodeJS.ProcessEnv = { PATH: `/custom/bin${delimiter}/usr/bin` };

    const normalizedPath = initializeProcessPath(env, 'darwin');

    expect(normalizedPath).toBe(env.PATH);
    expect(normalizedPath?.startsWith(`/custom/bin${delimiter}/usr/bin`)).toBe(true);
    expect(normalizedPath?.split(delimiter)).toEqual(expect.arrayContaining([
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/opt/local/bin',
    ]));
  });

  it('does not alter the PATH on Windows', () => {
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\Windows\\System32' };

    expect(initializeProcessPath(env, 'win32')).toBe(env.PATH);
    expect(env.PATH).toBe('C:\\Windows\\System32');
  });

  it('does not duplicate paths already inherited from the shell', () => {
    const env: NodeJS.ProcessEnv = { PATH: `/opt/homebrew/bin${delimiter}/usr/bin` };

    const normalizedPath = initializeProcessPath(env, 'darwin');

    expect(normalizedPath?.split(delimiter).filter((entry) => entry === '/opt/homebrew/bin')).toHaveLength(1);
  });
});