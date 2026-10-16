import { useCallback, useEffect, useRef, useState } from 'react';

export const REFRESH_SHOW_DELAY_MS = 300;
export const REFRESH_MIN_VISIBLE_MS = 600;

/**
 * Tracks which sessions are being re-inspected, but only reports a session as
 * refreshing when the inspection outlasts `showDelayMs`, and then keeps the
 * indicator visible for at least `minVisibleMs` so it never flickers.
 */
export function useVisibleRefresh(
  showDelayMs = REFRESH_SHOW_DELAY_MS,
  minVisibleMs = REFRESH_MIN_VISIBLE_MS
): { refreshingIds: ReadonlySet<string>; setChecking: (sessionId: string, checking: boolean) => void } {
  const [refreshingIds, setRefreshingIds] = useState<ReadonlySet<string>>(new Set());
  const showTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const hideTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const shownAt = useRef(new Map<string, number>());
  const checking = useRef(new Set<string>());

  const update = useCallback((sessionId: string, visible: boolean) => {
    setRefreshingIds((prev) => {
      if (prev.has(sessionId) === visible) return prev;
      const next = new Set(prev);
      if (visible) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }, []);

  const setChecking = useCallback(
    (sessionId: string, isChecking: boolean) => {
      if (isChecking) {
        checking.current.add(sessionId);
        const pendingHide = hideTimers.current.get(sessionId);
        if (pendingHide) {
          clearTimeout(pendingHide);
          hideTimers.current.delete(sessionId);
        }
        if (shownAt.current.has(sessionId) || showTimers.current.has(sessionId)) return;
        showTimers.current.set(
          sessionId,
          setTimeout(() => {
            showTimers.current.delete(sessionId);
            shownAt.current.set(sessionId, Date.now());
            update(sessionId, true);
          }, showDelayMs)
        );
        return;
      }

      checking.current.delete(sessionId);
      const pendingShow = showTimers.current.get(sessionId);
      if (pendingShow) {
        clearTimeout(pendingShow);
        showTimers.current.delete(sessionId);
        return;
      }
      const started = shownAt.current.get(sessionId);
      if (started === undefined) return;
      const remaining = Math.max(0, minVisibleMs - (Date.now() - started));
      hideTimers.current.set(
        sessionId,
        setTimeout(() => {
          hideTimers.current.delete(sessionId);
          shownAt.current.delete(sessionId);
          if (!checking.current.has(sessionId)) update(sessionId, false);
        }, remaining)
      );
    },
    [minVisibleMs, showDelayMs, update]
  );

  useEffect(() => {
    const shows = showTimers.current;
    const hides = hideTimers.current;
    return () => {
      shows.forEach(clearTimeout);
      hides.forEach(clearTimeout);
    };
  }, []);

  return { refreshingIds, setChecking };
}
