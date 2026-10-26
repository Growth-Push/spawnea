import type { Session } from '@spawnea/domain';

export function needsAttention(session: Session): boolean {
  return session.status === 'needs_input' || session.status === 'error';
}

/** Retain real ancestry; malformed cycles are exposed once as fallback roots. */
export function sessionForest(sessions: readonly Session[]) {
  const unique = [...new Map(sessions.map((s) => [s.id, s])).values()];
  const byId = new Map(unique.map((s) => [s.id, s]));
  const children = new Map<string, Session[]>();
  const roots: Session[] = [];
  for (const session of unique) {
    const seen = new Set([session.id]);
    let parent = session.parentSessionId;
    let cycle = false;
    while (parent && byId.has(parent)) {
      if (seen.has(parent)) { cycle = true; break; }
      seen.add(parent);
      parent = byId.get(parent)?.parentSessionId;
    }
    if (!session.parentSessionId || !byId.has(session.parentSessionId) || cycle) roots.push(session);
    else children.set(session.parentSessionId, [...(children.get(session.parentSessionId) ?? []), session]);
  }
  const sort = (a: Session, b: Session) => (a.childAlias || a.name).localeCompare(b.childAlias || b.name, undefined, { numeric: true, sensitivity: 'base' });
  roots.sort(sort);
  for (const list of children.values()) list.sort(sort);
  return { roots, children, byId };
}

export interface ActivitySample { time: number; parents: number; children: number; gap: boolean }
export const SAMPLE_INTERVAL = 10_000;
export const MAX_SAMPLES = 720;

/** Count concurrent working-or-starting root and child sessions. */
export function countWorking(sessions: readonly Session[]) {
  const working = [...new Map(sessions.map((s) => [s.id, s])).values()].filter(
    (s) => s.status === 'working' || s.status === 'starting'
  );
  return {
    parents: working.filter((s) => !s.parentSessionId).length,
    children: working.filter((s) => Boolean(s.parentSessionId)).length,
  };
}

export function appendActivity(previous: readonly ActivitySample[], sessions: readonly Session[], time: number, observed: boolean): ActivitySample[] {
  const { parents, children } = countWorking(sessions);
  const last = previous.at(-1);
  return [...previous, {
    time,
    parents,
    children,
    gap: !observed || Boolean(last && time - last.time > SAMPLE_INTERVAL * 2),
  }].slice(-MAX_SAMPLES);
}
