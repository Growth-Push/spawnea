import { useEffect, useRef, useState } from 'react';
import type { DashboardObservation, Session } from '@spawnea/domain';
import { countWorking, SAMPLE_INTERVAL } from '../components/session-overview';

/** Persist aggregates from the existing session feed, without polling hosts. */
export function useActivitySamples(sessions: readonly Session[], ready: boolean, isDashboardOpen = true) {
  const current = useRef({ sessions, ready, isDashboardOpen });
  const last = useRef<DashboardObservation | null>(null);
  const enqueue = useRef<(observation: DashboardObservation) => void>(() => {});
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  current.current = { sessions, ready, isDashboardOpen };

  useEffect(() => {
    let active = true;
    const ownerDocument = typeof document === 'undefined' ? null : document;
    let queue = Promise.resolve();
    let lost = false;
    queue = queue.then(() => active ? window.spawneaApi.beginDashboardHistory() : undefined).catch(() => {
      lost = true;
      if (active) setError('Could not save dashboard history. Some observations may be missing.');
    });
    enqueue.current = (observation) => {
      queue = queue.then(async () => {
        if (!active) return;
        if (lost) await window.spawneaApi.beginDashboardHistory(observation.time);
        if (!active) return;
        await window.spawneaApi.recordDashboardObservation(observation);
        lost = false;
      }).then(() => {
        if (active) setRevision((value) => value + 1);
      }, () => {
        lost = true;
        if (active) setError('Could not save dashboard history. Some observations may be missing.');
      });
    };
    const sample = (force: boolean) => {
      if (!active) return;
      const now = Date.now();
      const available = current.current.ready && ownerDocument !== null && ownerDocument.visibilityState !== 'hidden';
      const counts = countWorking(current.current.sessions);
      const previous = last.current;
      if (!previous) {
        // An app reopening cannot establish what happened since the previous observation.
        enqueue.current({ time: now, parents: 0, children: 0, gap: true });
      } else if (available && !previous.gap && now - previous.time > SAMPLE_INTERVAL * 2) {
        enqueue.current({ time: previous.time + 1, parents: 0, children: 0, gap: true });
        force = true;
      }
      const next = { time: now, ...counts, gap: !available };
      if (!previous || force || previous.gap !== next.gap || previous.parents !== next.parents || previous.children !== next.children) {
        if (previous || available) enqueue.current(next);
        last.current = next;
      }
    };
    sample(true);
    const timer = setInterval(() => sample(true), SAMPLE_INTERVAL);
    const visibility = () => sample(true);
    ownerDocument?.addEventListener('visibilitychange', visibility);
    // React state changes call this without setting up a new timer.
    trigger.current = () => sample(false);
    return () => {
      active = false;
      trigger.current = () => {};
      enqueue.current = () => {};
      clearInterval(timer);
      ownerDocument?.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  const trigger = useRef<() => void>(() => {});
  useEffect(() => { trigger.current(); }, [sessions, ready]);
  return { revision, error };
}
