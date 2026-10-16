import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useVisibleRefresh } from './useVisibleRefresh';

describe('useVisibleRefresh', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('never shows an inspection shorter than the show delay', () => {
    const { result } = renderHook(() => useVisibleRefresh());
    act(() => result.current.setChecking('a', true));
    act(() => vi.advanceTimersByTime(200));
    act(() => result.current.setChecking('a', false));
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.refreshingIds.has('a')).toBe(false);
  });

  it('shows after 300ms and stays at least 600ms after appearing', () => {
    const { result } = renderHook(() => useVisibleRefresh());
    act(() => result.current.setChecking('a', true));
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.refreshingIds.has('a')).toBe(true);
    act(() => result.current.setChecking('a', false));
    act(() => vi.advanceTimersByTime(599));
    expect(result.current.refreshingIds.has('a')).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.refreshingIds.has('a')).toBe(false);
  });

  it('keeps the indicator while the inspection is still running', () => {
    const { result } = renderHook(() => useVisibleRefresh());
    act(() => result.current.setChecking('a', true));
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.refreshingIds.has('a')).toBe(true);
    act(() => result.current.setChecking('a', false));
    act(() => vi.advanceTimersByTime(0));
    expect(result.current.refreshingIds.has('a')).toBe(false);
  });
});
