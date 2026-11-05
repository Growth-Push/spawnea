import { describe, expect, it } from 'vitest';
import { ScreenHistoryReader } from '../src/history/screen-history-reader.js';

describe('ScreenHistoryReader', () => {
  const reader = new ScreenHistoryReader();

  it('parses user, agent, and tool roles from terminal screen tail', async () => {
    const tailLines = [
      '› echo hello',
      '• Ran command: echo hello',
      'hello',
      'Worked for 1.2s · done',
    ];

    const result = await reader.readHistory({
      sessionId: 'sess-screen-1',
      harness: 'codex',
      worktreePath: '/workspace',
      isLocal: true,
      tailLines,
    });

    expect(result.source).toBe('screen');
    expect(result.items.length).toBeGreaterThanOrEqual(3);

    const userItem = result.items.find((i) => i.role === 'user');
    expect(userItem).toBeDefined();
    expect(userItem?.text).toContain('echo hello');
    expect(userItem?.turnBoundary).toBe('start');

    const toolItem = result.items.find((i) => i.role === 'tool');
    expect(toolItem).toBeDefined();
    expect(toolItem?.text).toContain('Ran command');

    const lastItem = result.items[result.items.length - 1];
    expect(lastItem.turnBoundary).toBe('end');
  });

  it('handles claude screen format with prompt and completion marker', async () => {
    const tailLines = [
      '❯ Check git status',
      'On branch main',
      'nothing to commit',
      '✻ Explored for 2s · done',
    ];

    const result = await reader.readHistory({
      sessionId: 'sess-screen-claude',
      harness: 'claude',
      worktreePath: '/workspace',
      isLocal: false, // remote session
      tailLines,
    });

    expect(result.source).toBe('screen');
    expect(result.items[0]).toMatchObject({
      role: 'user',
      text: 'Check git status',
      turnBoundary: 'start',
      source: 'screen',
    });
    const last = result.items[result.items.length - 1];
    expect(last.turnBoundary).toBe('end');
  });

  it('bounds item text length when lines exceed maxItemChars', async () => {
    const tailLines = ['› Short prompt', 'A'.repeat(500)];

    const result = await reader.readHistory(
      {
        sessionId: 'sess-screen-bound',
        harness: 'shell',
        worktreePath: '/ws',
        isLocal: true,
        tailLines,
      },
      { maxItemChars: 50 }
    );

    const longItem = result.items.find((i) => i.role === 'agent');
    expect(longItem?.text).toHaveLength(50);
    expect(longItem?.textTruncated).toBe(true);
  });

  it('handles empty or missing tailLines safely', async () => {
    const resEmpty = await reader.readHistory({
      sessionId: 'sess-empty',
      harness: 'shell',
      worktreePath: '/ws',
      isLocal: true,
      tailLines: [],
    });
    expect(resEmpty.items).toEqual([]);
    expect(resEmpty.source).toBe('screen');

    const resUndefined = await reader.readHistory({
      sessionId: 'sess-undef',
      harness: 'shell',
      worktreePath: '/ws',
      isLocal: true,
    });
    expect(resUndefined.items).toEqual([]);
  });

  it('generates stable screen item IDs regardless of pagination limit', async () => {
    const tailLines = [
      '› Prompt one',
      'Response line 1',
      'Response line 2',
      '› Prompt two',
    ];

    const context = {
      sessionId: 'sess-screen-stable',
      harness: 'shell',
      worktreePath: '/ws',
      isLocal: true,
      tailLines,
    };

    const unpaginated = await reader.readHistory(context);
    expect(unpaginated.items.length).toBeGreaterThanOrEqual(3);
    const unpaginatedIds = unpaginated.items.map((i) => i.id);

    // Paginated: page 1 with limit 1
    const page1 = await reader.readHistory(context, { limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0].id).toBe(unpaginatedIds[0]);

    // Page 2
    const page2 = await reader.readHistory(context, { limit: 1, cursor: page1.cursor });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0].id).toBe(unpaginatedIds[1]);

    // Page 3
    const page3 = await reader.readHistory(context, { limit: 1, cursor: page2.cursor });
    expect(page3.items).toHaveLength(1);
    expect(page3.items[0].id).toBe(unpaginatedIds[2]);
  });

  it('excludes the live editable composer and its shortcuts footer from conversation history', async () => {
    const tailLines = [
      '› echo hello',
      'hello',
      'Worked for 1.2s · done',
      '› Ask Codex to do anything',
      '  ? for shortcuts',
    ];

    const result = await reader.readHistory({
      sessionId: 'sess-composer-test',
      harness: 'codex',
      worktreePath: '/ws',
      isLocal: true,
      tailLines,
    });

    expect(result.items.length).toBeGreaterThanOrEqual(2);
    // Must NOT contain the live prompt placeholder or shortcut footer
    expect(result.items.some((i) => i.text.includes('Ask Codex'))).toBe(false);
    expect(result.items.some((i) => i.text.includes('shortcuts'))).toBe(false);

    // If screen ONLY contains the composer, items should be empty
    const composerOnly = await reader.readHistory({
      sessionId: 'sess-composer-only',
      harness: 'codex',
      worktreePath: '/ws',
      isLocal: true,
      tailLines: ['› Ask Codex to do anything', '  ? for shortcuts'],
    });
    expect(composerOnly.items).toHaveLength(0);

    // Footerless draft is also excluded
    const footerlessDraft = await reader.readHistory({
      sessionId: 'sess-composer-footerless',
      harness: 'codex',
      worktreePath: '/ws',
      isLocal: true,
      tailLines: ['• Answer', '› unsent draft in progress'],
    });
    expect(footerlessDraft.items.some((i) => i.text.includes('unsent draft'))).toBe(false);
  });

  it('preserves roles across indented continuation lines for prompts and tools', async () => {
    const tailLines = [
      '› First line of prompt',
      '  second line of prompt',
      '• Ran printf hello',
      '  └ hello from stdout',
      'Assistant reply here',
      '✻ Explored for 1s · done',
    ];

    const result = await reader.readHistory({
      sessionId: 'sess-multiline',
      harness: 'claude',
      worktreePath: '/ws',
      isLocal: true,
      tailLines,
    });

    expect(result.items).toHaveLength(3);
    // User prompt contains both lines
    expect(result.items[0].role).toBe('user');
    expect(result.items[0].text).toContain('First line of prompt');
    expect(result.items[0].text).toContain('second line of prompt');
    expect(result.items[0].turnBoundary).toBe('start');

    // Tool item contains header and indented output
    expect(result.items[1].role).toBe('tool');
    expect(result.items[1].text).toContain('Ran printf hello');
    expect(result.items[1].text).toContain('hello from stdout');

    // Agent reply
    expect(result.items[2].role).toBe('agent');
    expect(result.items[2].text).toContain('Assistant reply here');
    expect(result.items[2].turnBoundary).toBe('end');
  });

  it('normalizes harness names (aliases, paths, extensions) before choosing composer filters', async () => {
    // A footerless tail containing answer followed by draft with harness alias 'claude-code' or path '/usr/bin/claude'
    const tailLines = [
      '● Previous answer',
      '❯ unsent draft',
    ];

    const aliasResult = await reader.readHistory({
      sessionId: 'sess-alias-claude',
      harness: 'claude-code',
      worktreePath: '/ws',
      isLocal: true,
      tailLines,
    });
    expect(aliasResult.items.some((i) => i.text.includes('unsent draft'))).toBe(false);

    const pathResult = await reader.readHistory({
      sessionId: 'sess-path-claude',
      harness: '/usr/bin/claude',
      worktreePath: '/ws',
      isLocal: true,
      tailLines,
    });
    expect(pathResult.items.some((i) => i.text.includes('unsent draft'))).toBe(false);

    const codexPathResult = await reader.readHistory({
      sessionId: 'sess-path-codex',
      harness: 'host:codex-cli',
      worktreePath: '/ws',
      isLocal: true,
      tailLines: ['● Codex answer', '› unsent codex draft'],
    });
    expect(codexPathResult.items.some((i) => i.text.includes('unsent codex draft'))).toBe(false);
  });

  it('preserves conversation and does not strip Hermes bordered prompts', async () => {
    const tailLines = [
      'Welcome to Hermes Agent!',
      '────────────────────────────────────────',
      '❯ Run this shell command: echo 42',
      '────────────────────────────────────────',
      '💻 $ echo 42',
      '42',
      '─ 50.3s · ran 1 command · done',
    ];

    const result = await reader.readHistory({
      sessionId: 'sess-hermes',
      harness: 'hermes',
      worktreePath: '/ws',
      isLocal: true,
      tailLines,
    });

    expect(result.items.some((i) => i.role === 'user' && i.text.includes('Run this shell command'))).toBe(true);
    expect(result.items.some((i) => i.role === 'tool' && i.text.includes('echo 42'))).toBe(true);
  });

  it('does not classify interactive menu choices as user prompts', async () => {
    const tailLines = [
      '❯ Use the AskUserQuestion tool',
      'Which color do you prefer?',
      '❯ 1. Red',
      '     The color red',
      '  2. Green',
      'Enter to select · Esc to cancel',
    ];

    const result = await reader.readHistory({
      sessionId: 'sess-menu',
      harness: 'claude',
      worktreePath: '/ws',
      isLocal: true,
      tailLines,
    });

    // 1. Red should NOT be a user prompt item
    const userItems = result.items.filter((i) => i.role === 'user');
    expect(userItems).toHaveLength(1);
    expect(userItems[0].text).toBe('Use the AskUserQuestion tool');
    // Menu choice is part of agent output
    expect(result.items.some((i) => i.role === 'agent' && i.text.includes('1. Red'))).toBe(true);
  });

  it('recognizes collapsed Claude tool summaries without bullets', async () => {
    const tailLines = [
      '❯ Run bash command',
      '  Ran 1 shell command',
      '● Finished',
      '✻ Baked for 50s · done 11:11 AM',
    ];

    const result = await reader.readHistory({
      sessionId: 'sess-collapsed-tool',
      harness: 'claude',
      worktreePath: '/ws',
      isLocal: true,
      tailLines,
    });

    expect(result.items).toHaveLength(3); // user, tool, agent
    expect(result.items[0].role).toBe('user');
    expect(result.items[0].text).toBe('Run bash command');
    expect(result.items[1].role).toBe('tool');
    expect(result.items[1].text).toContain('Ran 1 shell command');
    expect(result.items[2].role).toBe('agent');
    expect(result.items[2].text).toContain('Finished');
  });

  it('returns the most recent N exchanges in recent_exchanges mode for screen', async () => {
    const tailLines: string[] = [];
    for (let i = 1; i <= 25; i++) {
      tailLines.push(`› screen question ${i}`);
      tailLines.push(`screen answer ${i}`);
      tailLines.push('Worked for 1s · done');
    }

    const context = {
      sessionId: 'sess-recent-screen',
      harness: 'codex',
      worktreePath: '/ws',
      isLocal: true,
      tailLines,
    };

    const result = await reader.readHistory(context, { limit: 10, mode: 'recent_exchanges' });
    expect(result.items[0].text).toBe('screen question 16');
    expect(result.items.at(-1)?.text).toContain('screen answer 25');
    expect(result.hasMore).toBe(false);
  });
});
