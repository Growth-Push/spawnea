import { useEffect, useRef, useState } from 'react';
import type { Session } from '@spawnea/domain';
import { appendActivity, countWorking, SAMPLE_INTERVAL, type ActivitySample } from '../components/session-overview';

/** Aggregate existing renderer state only; never poll hosts or retain terminal data. */
export function useActivitySamples(sessions: readonly Session[], ready: boolean, isDashboardOpen = true) {
  const [startedAt] = useState(Date.now);
  const [samples, setSamples] = useState<ActivitySample[]>([]);
  const samplesRef = useRef<ActivitySample[]>([]);
  const current = useRef({ sessions, ready, isDashboardOpen });

  useEffect(() => {
    current.current = { sessions, ready, isDashboardOpen };
  });

  // Keep samples state in sync with ref whenever dashboard is open or opens
  useEffect(() => {
    if (isDashboardOpen) {
      setSamples([...samplesRef.current]);
    }
  }, [isDashboardOpen]);

  useEffect(() => {
    const { parents, children } = countWorking(sessions);
    const last = samplesRef.current.at(-1);
    const isGap = !ready || document.visibilityState === 'hidden';
    if (!last || last.parents !== parents || last.children !== children || last.gap !== isGap) {
      samplesRef.current = appendActivity(
        samplesRef.current,
        sessions,
        Date.now(),
        ready && document.visibilityState !== 'hidden'
      );
      if (isDashboardOpen) {
        setSamples([...samplesRef.current]);
      }
    }
  }, [sessions, ready, isDashboardOpen]);

  useEffect(() => {
    const sample = () => {
      samplesRef.current = appendActivity(
        samplesRef.current,
        current.current.sessions,
        Date.now(),
        current.current.ready && document.visibilityState !== 'hidden'
      );
      if (current.current.isDashboardOpen) {
        setSamples([...samplesRef.current]);
      }
    };
    const timer = setInterval(sample, SAMPLE_INTERVAL);
    document.addEventListener('visibilitychange', sample);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', sample);
    };
  }, []);

  return { samples, startedAt };
}
