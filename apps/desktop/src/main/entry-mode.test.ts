import { describe, expect, it } from 'vitest';
import { shouldRunCli } from './entry-mode.js';

describe('desktop entry mode', () => {
  it('selects the CLI only for the explicit packaged-app flag', () => {
    expect(shouldRunCli(['Spawnea', '--spawnea-cli', 'list'])).toBe(true);
    expect(shouldRunCli(['Spawnea', '--smoke-test'])).toBe(false);
    expect(shouldRunCli(['Spawnea'])).toBe(false);
  });
});
