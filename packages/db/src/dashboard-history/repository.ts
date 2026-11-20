import type Database from 'better-sqlite3';
import type { DashboardHistoryView } from '@spawnea/domain';

export interface DashboardObservation {
  time: number;
  parents: number;
  children: number;
  gap: boolean;
}
export interface ObservationCursor { time: number; id: number }
export interface ObservationPage {
  observations: (DashboardObservation & { id: number })[];
  next: ObservationCursor | null;
}

export const DASHBOARD_BOUNDS_SQL = 'SELECT (SELECT min(observed_at) FROM dashboard_activity_samples) AS first, (SELECT max(observed_at) FROM dashboard_activity_samples) AS last';
const launchBoundsSql = 'SELECT (SELECT min(observed_at) FROM temp.dashboard_launch_samples) AS first, (SELECT max(observed_at) FROM temp.dashboard_launch_samples) AS last';
const insertSql = 'INSERT INTO dashboard_activity_samples(observed_at, parents, children, gap) VALUES (?, ?, ?, ?)';

/** Stores aggregates and optionally scopes dashboard reads to the current opening. */
export class DashboardHistoryRepository {
  private readonly samples: 'dashboard_activity_samples' | 'temp.dashboard_launch_samples';
  private readonly recordLaunchSample?: (sample: DashboardObservation) => void;

  constructor(private readonly sqlite: Database.Database, scope: 'all' | 'launch' = 'all') {
    this.samples = scope === 'launch' ? 'temp.dashboard_launch_samples' : 'dashboard_activity_samples';
    if (scope === 'launch') {
      // The Desktop owns one connection per launch. Mirror only this connection's
      // dashboard writes, keeping indexed reads independent of other writers.
      sqlite.exec(`
        CREATE TEMP TABLE IF NOT EXISTS dashboard_launch_samples (
          id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL,
          parents INTEGER NOT NULL, children INTEGER NOT NULL, gap INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS temp.dashboard_launch_samples_time ON dashboard_launch_samples(observed_at, id);
        CREATE INDEX IF NOT EXISTS temp.dashboard_launch_samples_gaps ON dashboard_launch_samples(gap, observed_at, id);
      `);
      const insert = sqlite.prepare(insertSql).safeIntegers();
      const insertLaunch = sqlite.prepare('INSERT INTO temp.dashboard_launch_samples(id, observed_at, parents, children, gap) VALUES (?, ?, ?, ?, ?)');
      this.recordLaunchSample = sqlite.transaction(({ time, parents, children, gap }: DashboardObservation) => {
        const values = [time, parents, children, gap ? 1 : 0];
        const { lastInsertRowid } = insert.run(...values);
        insertLaunch.run(lastInsertRowid, ...values);
      });
    }
  }

  record(sample: DashboardObservation): void {
    if (this.recordLaunchSample) this.recordLaunchSample(sample);
    else this.sqlite.prepare(insertSql).run(sample.time, sample.parents, sample.children, sample.gap ? 1 : 0);
  }

  begin(now: number): void {
    const { last } = this.bounds();
    if (this.recordLaunchSample && last === null) {
      // The offline interval belongs only to retained history. The sampler
      // records the new opening's first independently observed gap or count.
      const retained = this.readBounds(DASHBOARD_BOUNDS_SQL).last;
      this.sqlite.prepare(insertSql).run(retained !== null && retained < now ? retained + 1 : now, 0, 0, 1);
      return;
    }
    this.record({ time: last !== null && last < now ? last + 1 : now, parents: 0, children: 0, gap: true });
  }

  bounds(): { first: number | null; last: number | null } {
    return this.readBounds(this.recordLaunchSample ? launchBoundsSql : DASHBOARD_BOUNDS_SQL);
  }

  private readBounds(sql: string): { first: number | null; last: number | null } {
    return this.sqlite.prepare(sql).get() as { first: number | null; last: number | null };
  }

  page(from: number, to: number, cursor: ObservationCursor | null, limit: number): ObservationPage {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Invalid history page size');
    const rows = this.sqlite.prepare(`SELECT id, observed_at AS time, parents, children, gap
      FROM ${this.samples}
      WHERE observed_at >= @from AND observed_at <= @to
        AND (observed_at > @cursorTime OR (observed_at = @cursorTime AND id > @cursorId))
      ORDER BY observed_at, id LIMIT @limit`).all({ from, to, cursorTime: cursor?.time ?? from - 1, cursorId: cursor?.id ?? 0, limit: limit + 1 }) as (Omit<DashboardObservation, 'gap'> & { id: number; gap: number })[];
    const hasNext = rows.length > limit;
    const observations = rows.slice(0, limit).map((row) => ({ ...row, gap: row.gap === 1 }));
    const last = observations.at(-1);
    return { observations, next: hasNext && last ? { time: last.time, id: last.id } : null };
  }

  closedCount(): number {
    return (this.sqlite.prepare('SELECT count FROM dashboard_closed_sessions WHERE singleton = 1').get() as { count: number }).count;
  }

  view(from?: number, to?: number): DashboardHistoryView {
    const { first, last } = this.bounds();
    const closedCount = this.closedCount();
    if (first === null || last === null) return { first, last, closedCount, points: [] };
    const start = Math.max(first, from ?? first);
    const end = Math.min(last, to ?? last);
    if (start > end) return { first, last, closedCount, points: [] };
    const width = Math.max(1, Math.ceil((end - start + 1) / 399));
    const sampleQuery = this.sqlite.prepare(`SELECT observed_at AS time, parents, children, gap
      FROM ${this.samples} WHERE observed_at BETWEEN ? AND ? ORDER BY observed_at, id LIMIT 2`);
    const gapQuery = this.sqlite.prepare(`SELECT 1 FROM ${this.samples} WHERE gap = 1 AND observed_at BETWEEN ? AND ? LIMIT 1`);
    const points: DashboardHistoryView['points'] = [];
    const preceding = this.sqlite.prepare(`SELECT gap FROM ${this.samples} WHERE observed_at < ? ORDER BY observed_at DESC, id DESC LIMIT 1`)
      .get(start) as { gap: number } | undefined;
    if (preceding?.gap === 1) points.push({ time: start, parents: 0, children: 0, gap: true, summarized: false, containsGap: true });
    for (let lower = start; lower <= end; lower += width) {
      const upper = Math.min(end, lower + width - 1);
      const rows = sampleQuery.all(lower, upper) as { time: number; parents: number; children: number; gap: number }[];
      if (rows.length) {
        const row = rows[0];
        points.push({ time: row.time, parents: row.parents, children: row.children, gap: row.gap === 1, summarized: rows.length > 1, containsGap: Boolean(gapQuery.get(lower, upper)) });
      }
    }
    return { first, last, closedCount, points };
  }
}
