import { describe, expect, it } from 'vitest';
import type { Session } from '@spawnea/domain';
import { sessionTableRows, sessionTableTsv } from './dashboard-table';

const session = (id: string, patch: Partial<Session> = {}): Session => ({
  id, name: id, task: 'Private task must not be exported', serverId: 'host', projectId: 'project',
  agentId: 'agent', status: 'working', branch: 'main', worktreePath: '/workspace/example',
  tmuxSessionName: id, createdAt: new Date(0), lastActivityAt: new Date(0), ...patch,
});
const labels = { hostName: (id: string) => `Host ${id}`, projectName: (id: string) => `Project ${id}`, harness: (id: string) => `Harness ${id}` };

describe('Dashboard table export', () => {
  it('exports exactly the agreed columns using each session’s attribution and original parent ID', () => {
    const text = sessionTableTsv([
      session('root'),
      session('child', { parentSessionId: 'root', serverId: 'remote', projectId: 'other', agentId: 'custom', tmuxWindowName: 'agent' }),
      session('orphan', { parentSessionId: 'missing' }),
    ], labels);
    expect(text).toBe([
      'Name\tID\tParent ID\tHost\tProject\tHarness\tState\tBranch\tWorktree\ttmux',
      'root\troot\t\tHost host\tProject project\tHarness agent\tworking\tmain\t/workspace/example\troot',
      'child\tchild\troot\tHost remote\tProject other\tHarness custom\tworking\tmain\t/workspace/example\tchild:agent',
      'orphan\torphan\tmissing\tHost host\tProject project\tHarness agent\tworking\tmain\t/workspace/example\torphan',
    ].join('\r\n'));
    expect(text).not.toContain('Private task');
  });

  it('escapes embedded tabs, quotes and CR/LF without losing cell contents', () => {
    const text = sessionTableTsv([session('id', {
      name: 'Name\twith "quotes"\nand\rreturns', branch: 'quote"branch', worktreePath: '/path\twith tabs', tmuxSessionName: 'multi\r\nline',
    })], labels);
    expect(text.split('\r\n').slice(1).join('\r\n')).toBe(
      '"Name\twith ""quotes""\nand\rreturns"\tid\t\tHost host\tProject project\tHarness agent\tworking\t"quote""branch"\t"/path\twith tabs"\t"multi\r\nline"',
    );
  });

  it.each(['=1+1', '+SUM(A1)', '-1+2', '@SUM(A1)', '  =1+1', '\t=1+1', '\r=1+1', '\n=1+1', '\u0000=1+1', '\ufeff=1+1', '\tplain text', '\rplain text', '\nplain text'])(
    'neutralizes spreadsheet triggers while retaining the text: %j', (value) => {
      const record = session('id', { name: value, id: value, parentSessionId: value, branch: value, worktreePath: value, tmuxSessionName: value });
      const text = sessionTableTsv([record], { hostName: () => value, projectName: () => value, harness: () => value });
      const safe = `'${value}`;
      const escaped = /[\t\r\n"]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
      expect(text.slice(text.indexOf('\r\n') + 2)).toBe([
        escaped, escaped, escaped, escaped, escaped, escaped, 'working', escaped, escaped, escaped,
      ].join('\t'));
    },
  );

  it('preserves ordinary text, Unicode, existing apostrophes and empty cells', () => {
    // Multilingual input fixture verifies Unicode export, not product copy.
    const text = sessionTableTsv([session('id', { name: '日本語 🐾', branch: "'literal", worktreePath: '' })], labels);
    expect(text).toContain("日本語 🐾\tid\t\tHost host\tProject project\tHarness agent\tworking\t'literal\t\tid");
  });

  it('keeps preorder, excludes filtered branches and terminates on repeated IDs or cycles', () => {
    const root = session('root');
    const child = session('child', { parentSessionId: root.id });
    const leaf = session('leaf', { parentSessionId: child.id });
    const hidden = session('hidden');
    const second = session('second');
    const children = new Map([['root', [child, hidden]], ['child', [leaf]], ['leaf', [root]]]);
    expect(sessionTableRows([root, second, root], children, (s) => s.id !== 'hidden').map((s) => s.id)).toEqual(['root', 'child', 'leaf', 'second']);
  });
});
