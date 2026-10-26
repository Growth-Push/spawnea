import { useEffect, useRef, useState } from 'react';
import type { Session } from '@spawnea/domain';
import { appendActivity, countWorking, SAMPLE_INTERVAL, type ActivitySample } from '../components/session-overview';

/** Aggregate existing renderer state only; never poll hosts or retain terminal data. */
export function useActivitySamples(sessions: readonly Session[], ready: boolean) {
  const [startedAt] = useState(Date.now);
  const [samples, setSamples] = useState<ActivitySample[]>([]);
  const current = useRef({ sessions, ready });
  current.current = { sessions, ready };
  useEffect(() => {
    setSamples((previous) => {
      const { parents, children } = countWorking(sessions);
      const last = previous.at(-1);
      const isGap = !ready || document.visibilityState === 'hidden';
      if (last && last.parents === parents && last.children === children && last.gap === isGap) {
        return previous;
      }
      return appendActivity(previous, sessions, Date.now(), ready && document.visibilityState !== 'hidden');
    });
  }, [sessions, ready]);
  useEffect(() => {
    const sample = () => setSamples((previous) => appendActivity(previous, current.current.sessions, Date.now(), current.current.ready && document.visibilityState !== 'hidden'));
    const timer = setInterval(sample, SAMPLE_INTERVAL);
    document.addEventListener('visibilitychange', sample);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', sample); };
  }, []);
  return { samples, startedAt };
}
