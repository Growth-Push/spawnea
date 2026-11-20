import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { dashboardHistorySchema } from '../src/dashboard-history/schema.js';
import { DASHBOARD_BOUNDS_SQL, DashboardHistoryRepository } from '../src/dashboard-history/repository.js';
import { createDatabase, createRepositories } from '../src/index.js';

describe('dashboard history storage', () => {
  it('excludes observations from a prior opening even when its clock was ahead', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(dashboardHistorySchema);
      new DashboardHistoryRepository(sqlite).record({ time: 500, parents: 9, children: 8, gap: false });
      const opening = new DashboardHistoryRepository(sqlite, 'launch');
      expect(opening.view()).toMatchObject({ first: null, last: null, points: [] });
      expect(opening.page(0, 600, null, 100)).toEqual({ observations: [], next: null });
    } finally { sqlite.close(); }
  });

  it('includes this opening’s new observations after the clock rolls back', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(dashboardHistorySchema);
      const opening = new DashboardHistoryRepository(sqlite, 'launch');
      opening.record({ time: 410, parents: 1, children: 1, gap: false });
      opening.record({ time: 350, parents: 0, children: 0, gap: false });
      expect(opening.view()).toMatchObject({ first: 350, last: 410 });
      expect(opening.view(340, 360).points).toEqual([
        { time: 350, parents: 0, children: 0, gap: false, summarized: false, containsGap: false },
      ]);
      expect(opening.page(340, 360, null, 100).observations.map(({ time }) => time)).toEqual([350]);
    } finally { sqlite.close(); }
  });
  it('uses indexed searches for both history bounds', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(dashboardHistorySchema);
      const details = (sqlite.prepare(`EXPLAIN QUERY PLAN ${DASHBOARD_BOUNDS_SQL}`).all() as { detail: string }[]).map((row) => row.detail);
      expect(details.filter((detail) => /SEARCH dashboard_activity_samples USING COVERING INDEX dashboard_activity_samples_time/.test(detail))).toHaveLength(2);
      expect(details.some((detail) => /SCAN dashboard_activity_samples/.test(detail))).toBe(false);
      expect(new DashboardHistoryRepository(sqlite).bounds()).toEqual({ first: null, last: null });
    } finally { sqlite.close(); }
  });
  it('scopes chart bounds, zoom and detail to each writer sharing a profile', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-launch-'));
    const path = join(directory, 'fixture.db');
    const sqlite = new Database(path);
    const peer = new Database(path);
    try {
      sqlite.exec(dashboardHistorySchema);
      sqlite.exec('UPDATE dashboard_closed_sessions SET count = 7');
      const history = new DashboardHistoryRepository(sqlite);
      history.record({ time: 10, parents: 9, children: 8, gap: false });
      const firstOpening = new DashboardHistoryRepository(sqlite, 'launch');
      firstOpening.begin(100);
      expect(firstOpening.view()).toEqual({ first: null, last: null, points: [], closedCount: 7 });
      expect(firstOpening.page(0, 99, null, 100)).toEqual({ observations: [], next: null });
      firstOpening.record({ time: 100, parents: 0, children: 0, gap: false });
      firstOpening.record({ time: 102, parents: 2, children: 1, gap: false });
      firstOpening.record({ time: 102, parents: 3, children: 1, gap: false });
      expect(firstOpening.view()).toMatchObject({ first: 100, last: 102, closedCount: 7 });
      expect(firstOpening.view(0, 101).points).toEqual([
        { time: 100, parents: 0, children: 0, gap: false, summarized: false, containsGap: false },
      ]);
      expect(firstOpening.view(0, 99).points).toEqual([]);
      const page = firstOpening.page(0, 102, { time: 10, id: 1 }, 2);
      expect(page.observations.map(({ parents }) => parents)).toEqual([0, 2]);
      expect(page.next).toMatchObject({ time: 102 });
      expect(firstOpening.page(0, 102, page.next, 2).observations.map(({ parents }) => parents)).toEqual([3]);
      firstOpening.begin(150);
      firstOpening.record({ time: 150, parents: 1, children: 1, gap: false });
      expect(firstOpening.view(110, 140).points[0]).toMatchObject({ time: 110, gap: true });
      expect(firstOpening.bounds()).toEqual({ first: 100, last: 150 });

      const secondOpening = new DashboardHistoryRepository(peer, 'launch');
      secondOpening.begin(200);
      expect(secondOpening.view()).toEqual({ first: null, last: null, points: [], closedCount: 7 });
      secondOpening.record({ time: 200, parents: 0, children: 0, gap: true });
      secondOpening.record({ time: 201, parents: 1, children: 0, gap: false });
      expect(secondOpening.view().points.map(({ time, gap }) => [time, gap])).toEqual([[200, true], [201, false]]);
      firstOpening.record({ time: 201, parents: 4, children: 2, gap: false });
      expect(new DashboardHistoryRepository(sqlite, 'launch').bounds()).toEqual({ first: 100, last: 201 });
      expect(firstOpening.view(200, 201).points.map(({ parents }) => parents)).toEqual([4]);
      expect(secondOpening.bounds()).toEqual({ first: 200, last: 201 });
      expect(secondOpening.page(0, 201, null, 100).observations.map(({ time }) => time)).toEqual([200, 201]);
      expect(history.page(0, 201, null, 100).observations.map(({ time }) => time))
        .toEqual([10, 11, 100, 102, 102, 103, 150, 151, 200, 201, 201]);
    } finally {
      peer.close();
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('retains confirmed closure count across reopening without counting repeated deletion', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-closure-'));
    const path = join(directory, 'fixture.db');
    try {
      const first = createDatabase({ path });
      const repos = createRepositories(first.db);
      await repos.servers.save({ id: 's', name: 'S', host: 'example', sshPort: 22, enabled: true });
      await repos.projects.save({ id: 'p', serverId: 's', name: 'P', rootPath: '/example' });
      await repos.agents.save({ id: 'a', name: 'A', harness: 'shell', command: 'sh' });
      await repos.sessions.save({ id: 'one', name: 'One', serverId: 's', projectId: 'p', agentId: 'a', task: '', worktreePath: '/example', branch: 'main', tmuxSessionName: 'one', status: 'idle' });
      await repos.sessions.delete('one', { countAsClosed: true });
      first.close();
      const second = createDatabase({ path });
      try {
        expect(new DashboardHistoryRepository(second.sqlite).closedCount()).toBe(1);
        expect(await createRepositories(second.db).sessions.delete('one', { countAsClosed: true })).toBe(false);
        expect(new DashboardHistoryRepository(second.sqlite).closedCount()).toBe(1);
      } finally { second.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('bounds the overview while retaining older details and explicit gaps', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(dashboardHistorySchema);
      const history = new DashboardHistoryRepository(sqlite);
      for (let i = 0; i < 2000; i++) history.record({ time: i * 1000, parents: i, children: 0, gap: i === 2 });
      const overview = history.view();
      expect(overview.points.length).toBeLessThanOrEqual(400);
      expect(overview.first).toBe(0);
      expect(overview.last).toBe(1_999_000);
      expect(overview.points[0].containsGap).toBe(true);
      const detail = history.view(0, 4000);
      expect(detail.points.map((point) => point.parents)).toEqual([0, 1, 2, 3, 4]);
      expect(detail.points[2].gap).toBe(true);
      history.record({ time: 2_100_000, parents: 0, children: 0, gap: true });
      history.record({ time: 2_200_000, parents: 1, children: 0, gap: false });
      expect(history.view(2_150_000, 2_180_000).points[0]).toMatchObject({ time: 2_150_000, gap: true });
    } finally { sqlite.close(); }
  });

  it('marks the interval between app openings as unknown', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(dashboardHistorySchema);
      const history = new DashboardHistoryRepository(sqlite);
      history.begin(100);
      history.record({ time: 100, parents: 1, children: 0, gap: false });
      history.begin(200);
      history.record({ time: 200, parents: 2, children: 0, gap: false });
      expect(history.view(120, 180).points).toEqual([{ time: 120, parents: 0, children: 0, gap: true, summarized: false, containsGap: true }]);
      expect(history.view(200, 200).points.at(-1)).toMatchObject({ time: 200, parents: 2, gap: false });
    } finally { sqlite.close(); }
  });
  it('persists aggregates and pages every observation across reopen and duplicate timestamps', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-history-'));
    try {
      const path = join(directory, 'fixture.db');
      const first = new Database(path);
      first.exec(dashboardHistorySchema);
      const writer = new DashboardHistoryRepository(first);
      for (let i = 0; i < 7; i++) writer.record({ time: Math.floor(i / 2), parents: i, children: 0, gap: i === 3 });
      first.close();
      const second = new Database(path);
      try {
        const reader = new DashboardHistoryRepository(second);
        expect(reader.bounds()).toEqual({ first: 0, last: 3 });
        expect(reader.closedCount()).toBe(0);
        const results = [];
        let cursor = null;
        do {
          const page = reader.page(0, 3, cursor, 2);
          results.push(...page.observations);
          cursor = page.next;
        } while (cursor);
        expect(results.map((row) => row.parents)).toEqual([0, 1, 2, 3, 4, 5, 6]);
        expect(results[3].gap).toBe(true);
        expect(() => reader.page(0, 3, null, 1001)).toThrow();
      } finally { second.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
