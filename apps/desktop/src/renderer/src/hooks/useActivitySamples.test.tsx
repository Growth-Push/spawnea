import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useActivitySamples } from './useActivitySamples';
import type { Session } from '@spawnea/domain';

afterEach(() => { cleanup(); vi.useRealTimers(); });
it('keeps aggregate history through view toggles, observes updates, records gaps and resets on remount', () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const sessions = [{ id: 'root', status: 'working' }] as Session[];
  const hook = renderHook(({ ready }) => useActivitySamples(sessions, ready), { initialProps: { ready: false } });
  expect(hook.result.current.samples.at(-1)?.gap).toBe(true);
  hook.rerender({ ready: true });
  act(() => vi.advanceTimersByTime(10_000));
  expect(hook.result.current.samples.at(-1)).toMatchObject({ parents: 1, children: 0, gap: false });
  const length = hook.result.current.samples.length;
  hook.rerender({ ready: true });
  expect(hook.result.current.samples).toHaveLength(length);
  act(() => { vi.setSystemTime(100_000); vi.advanceTimersByTime(10_000); });
  expect(hook.result.current.samples.at(-1)?.gap).toBe(true);
  hook.unmount();
  const fresh = renderHook(() => useActivitySamples(sessions, true));
  expect(fresh.result.current.startedAt).toBe(110_000);
  expect(fresh.result.current.samples.length).toBeLessThan(length);
});
