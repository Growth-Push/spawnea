import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useActivitySamples } from './useActivitySamples';
import type { Session } from '@spawnea/domain';

afterEach(() => { cleanup(); vi.useRealTimers(); });
it('persists only observations and marks startup and delayed periods as unknown', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const record = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, 'spawneaApi', { configurable: true, value: { beginDashboardHistory: vi.fn().mockResolvedValue(undefined), recordDashboardObservation: record } });
  const sessions = [{ id: 'root', status: 'working' }] as Session[];
  const hook = renderHook(({ ready }) => useActivitySamples(sessions, ready), { initialProps: { ready: false } });
  await act(async () => {});
  expect(record.mock.calls[0][0]).toMatchObject({ gap: true });
  hook.rerender({ ready: true });
  await act(async () => {});
  expect(record.mock.calls.at(-1)?.[0]).toMatchObject({ parents: 1, children: 0, gap: false });
  await act(async () => { vi.setSystemTime(100_000); vi.advanceTimersByTime(10_000); });
  expect(record.mock.calls.at(-2)?.[0].gap).toBe(true);
  expect(record.mock.calls.at(-1)?.[0].gap).toBe(false);
  hook.unmount();
  const count = record.mock.calls.length;
  await act(async () => { vi.advanceTimersByTime(20_000); });
  expect(record).toHaveBeenCalledTimes(count);
});

it('reports failed writes and inserts an unknown marker before recovery', async () => {
  const record = vi.fn().mockRejectedValueOnce(new Error('storage')).mockResolvedValue(undefined);
  Object.defineProperty(window, 'spawneaApi', { configurable: true, value: { beginDashboardHistory: vi.fn().mockResolvedValue(undefined), recordDashboardObservation: record } });
  const hook = renderHook(() => useActivitySamples([{ id: 'root', status: 'working' }] as Session[], true));
  await act(async () => {});
  expect(hook.result.current.error).toMatch(/Could not save/);
  expect(record.mock.calls.map(([s]) => s.gap)).toEqual([true, false]);
  expect(window.spawneaApi.beginDashboardHistory).toHaveBeenCalledTimes(2);
});

it('uses the captured document when the global is unavailable during callbacks and cleanup', async () => {
  vi.useFakeTimers();
  const ownerDocument = document;
  const add = vi.spyOn(ownerDocument, 'addEventListener');
  const remove = vi.spyOn(ownerDocument, 'removeEventListener');
  const record = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, 'spawneaApi', { configurable: true, value: { beginDashboardHistory: vi.fn().mockResolvedValue(undefined), recordDashboardObservation: record } });
  const hook = renderHook(() => useActivitySamples([{ id: 'root', status: 'working' }] as Session[], true));
  await act(async () => {});
  const visibility = add.mock.calls.find(([type]) => type === 'visibilitychange')?.[1] as EventListener;
  expect(visibility).toBeTypeOf('function');
  try {
    vi.stubGlobal('document', undefined);
    await act(async () => { vi.advanceTimersByTime(10_000); });
    hook.unmount();
    const count = record.mock.calls.length;
    await act(async () => { visibility(new Event('visibilitychange')); vi.advanceTimersByTime(10_000); });
    expect(record).toHaveBeenCalledTimes(count);
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  } finally {
    vi.unstubAllGlobals();
    add.mockRestore();
    remove.mockRestore();
  }
});
