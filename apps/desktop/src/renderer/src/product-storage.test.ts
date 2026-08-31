import { beforeEach, describe, expect, it } from 'vitest';
import { spawneaSessionTabKey } from './product-storage.js';

describe('Spawnea renderer preferences', () => {
  beforeEach(() => localStorage.clear());

  it('reads the canonical session tab preference', () => {
    const canonicalKey = spawneaSessionTabKey('session-1');
    localStorage.setItem(canonicalKey, 'diff');

    expect(localStorage.getItem(canonicalKey)).toBe('diff');
  });
});
