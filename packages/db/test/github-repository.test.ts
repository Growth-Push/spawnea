import { describe, expect, it } from 'vitest';
import { createDatabase } from '../src/connection.js';
import { SqliteGitHubRepository, type StoredSessionLink } from '../src/repositories/github-repository.js';

const makeLink = (number: number, source: StoredSessionLink['source'] = 'output'): StoredSessionLink => ({ sessionId: 's', url: `https://github.com/example/repo/issues/${number}`, kind: 'issue', source, createdAt: new Date(number) });

describe('bounded GitHub link repository', () => {
  it('retains new provenance for an existing identity after a saturated incoming batch', async () => {
    const connection = createDatabase();
    connection.sqlite.pragma('foreign_keys = OFF');
    try {
      const repo = new SqliteGitHubRepository(connection.db);
      await repo.addLink(makeLink(9000, 'task'));
      await repo.addLink(makeLink(9001, 'prompt'));
      const links = await repo.admitLinks('s', [
        ...Array.from({ length: 140 }, (_, i) => makeLink(i + 1)),
        { ...makeLink(9000), url: 'https://github.com/EXAMPLE/REPO/issues/9000?view=1', createdAt: new Date(42) },
        { ...makeLink(9000), createdAt: new Date(99) },
      ]);
      expect(new Set(links.map((link) => link.url)).size).toBe(128);
      expect(links.filter((link) => link.url === makeLink(9000).url).map((link) => [link.source, link.createdAt.getTime()])).toEqual([['task', 9000], ['output', 42]]);
      expect(links.some((link) => link.url === makeLink(9001).url && link.source === 'prompt')).toBe(true);
      expect(links.some((link) => link.url === makeLink(126).url)).toBe(true);
      expect(links.some((link) => link.url === makeLink(127).url)).toBe(false);
      const rows = connection.sqlite.prepare('SELECT url, source, created_at FROM session_links WHERE session_id = ? ORDER BY url, source').all('s') as Array<{ url: string; source: string; created_at: number }>;
      expect(rows.length).toBeLessThanOrEqual(384);
      expect(rows.filter((row) => row.url === makeLink(9000).url).map((row) => [row.source, row.created_at])).toEqual([['output', 42], ['task', 9000]]);
      expect(await repo.links('s')).toEqual(links);
    } finally { connection.close(); }
  });

  it('bounds bulk and direct insertions, retains provenance and promotes higher priority', async () => {
    const connection = createDatabase();
    connection.sqlite.pragma('foreign_keys = OFF');
    try {
      const repo = new SqliteGitHubRepository(connection.db);
      for (let batch = 0; batch < 6; batch++) await repo.admitLinks('s', Array.from({ length: 500 }, (_, i) => makeLink(batch * 500 + i + 1)));
      expect(await repo.links('s')).toHaveLength(128);
      await repo.addLink(makeLink(9999, 'task'));
      await repo.addLink(makeLink(9999, 'prompt'));
      await repo.addLink(makeLink(9999, 'output'));
      const links = await repo.links('s');
      expect(new Set(links.map((link) => link.url)).size).toBe(128);
      expect(links.filter((link) => link.url.endsWith('/9999')).map((link) => link.source).sort()).toEqual(['output', 'prompt', 'task']);
      expect(links.some((link) => link.url.endsWith('/128'))).toBe(false);
      const first = links.find((link) => link.url.endsWith('/1'))!;
      await repo.addLink({ ...first, createdAt: new Date(900000) });
      expect((await repo.links('s')).find((link) => link.url.endsWith('/1'))?.createdAt).toEqual(first.createdAt);
      expect((connection.sqlite.prepare('SELECT count(*) AS n FROM session_links').get() as { n: number }).n).toBeLessThanOrEqual(384);
    } finally { connection.close(); }
  });

  it('lazily prunes over-limit legacy rows before returning them', async () => {
    const connection = createDatabase();
    connection.sqlite.pragma('foreign_keys = OFF');
    try {
      const insert = connection.sqlite.prepare('INSERT INTO session_links VALUES (?, ?, ?, ?, ?)');
      const fill = connection.sqlite.transaction(() => {
        for (let i = 1; i <= 4092; i++) insert.run('s', makeLink(i).url, 'issue', 'output', i);
        insert.run('s', `https://github.com/example/${'x'.repeat(3000)}`, 'repository', 'task', 1);
        insert.run('s', 'https://github.com/example/bad', 'x'.repeat(5000), 'task', 1);
        insert.run('s', `https://github.com/example/repo\0${'x'.repeat(10000)}`, 'repository', 'task', 1);
        insert.run('s', 'https://github.com/example/invalid-time', 'repository', 'task', 'invalid');
      });
      fill();
      const links = await new SqliteGitHubRepository(connection.db).links('s');
      expect(links).toHaveLength(128);
      expect(links[0].url).toBe(makeLink(1).url);
      expect((connection.sqlite.prepare('SELECT count(*) AS n FROM session_links').get() as { n: number }).n).toBe(128);
    } finally { connection.close(); }
  });

  it.each([4097, 8192])('rejects %i legacy rows using only an indexed bounded probe and preserves them', async (count) => {
    const connection = createDatabase();
    connection.sqlite.pragma('foreign_keys = OFF');
    try {
      const insert = connection.sqlite.prepare('INSERT INTO session_links VALUES (?, ?, ?, ?, ?)');
      connection.sqlite.transaction(() => { for (let i = 1; i <= count; i++) insert.run('s', makeLink(i).url, 'issue', 'output', i); })();
      const plan = connection.sqlite.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM session_links WHERE session_id = ? LIMIT 1 OFFSET 4096').all('s') as Array<{ detail: string }>;
      expect(plan.some((row) => row.detail.includes('SEARCH session_links USING COVERING INDEX') && row.detail.includes('session_id=?'))).toBe(true);
      const queries: string[] = [];
      const prepare = connection.sqlite.prepare;
      connection.sqlite.prepare = function (this: typeof connection.sqlite, query: string) { queries.push(query); return prepare.call(this, query); } as typeof prepare;
      const repo = new SqliteGitHubRepository(connection.db);
      await expect(repo.links('s')).rejects.toThrow('4096-row automatic recovery limit');
      await expect(repo.addLink(makeLink(count + 1, 'task'))).rejects.toThrow('4096-row automatic recovery limit');
      expect(queries.filter((query) => /select/i.test(query))).toHaveLength(2);
      expect(queries.filter((query) => /select/i.test(query)).every((query) => /select 1 as present/i.test(query) && /where session_id/i.test(query) && /limit 1 offset/i.test(query))).toBe(true);
      expect(queries.some((query) => /order by|\bdelete\b|\binsert\b/i.test(query))).toBe(false);
      expect((prepare.call(connection.sqlite, 'SELECT count(*) AS n FROM session_links WHERE session_id = ?').get('s') as { n: number }).n).toBe(count);
    } finally { connection.close(); }
  });
});
