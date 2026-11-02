import { describe, expect, it } from 'vitest';
import { aggregateCi, type CiObservation } from '../src/github-ci.js';

const result = (key: string, state: CiObservation['state'], observedAt = '2026-01-01T00:00:00Z'): CiObservation => ({ key, state, observedAt });

describe('CI aggregation', () => {
  it('never treats absent, incomplete, skipped, or cancelled checks as success', () => {
    expect(aggregateCi([], true)).toBe('no-checks');
    expect(aggregateCi([result('a', 'successful')], false)).toBe('unavailable');
    expect(aggregateCi([result('a', 'skipped')], true)).toBe('skipped');
    expect(aggregateCi([result('a', 'cancelled')], true)).toBe('cancelled');
    expect(aggregateCi([result('a', 'successful'), result('b', 'successful')], true)).toBe('successful');
  });

  it('uses the latest attempt for each provider key', () => {
    expect(aggregateCi([result('check:a', 'failed'), result('check:a', 'successful', '2026-01-02T00:00:00Z'), result('status:b', 'running')], true)).toBe('running');
    expect(aggregateCi([result('check:a', 'successful'), result('check:a', 'failed', '2026-01-02T00:00:00Z')], true)).toBe('failed');
    expect(aggregateCi([result('a', 'successful'), result('a', 'failed')], true)).toBe('unavailable');
    expect(aggregateCi([result('a', 'successful', 'invalid')], true)).toBe('unavailable');
  });
});
