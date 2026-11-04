import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexHistoryReader } from '../src/history/codex-history-reader.js';

describe('CodexHistoryReader', () => {
  let tempDir: string;
  let reader: CodexHistoryReader;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hist-test-'));
    reader = new CodexHistoryReader();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('separates user, agent, and tool with task_started and task_complete marking turns', async () => {
    const file = path.join(tempDir, 'rollout-test.jsonl');
    const lines = [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-11-04T10:00:00.000Z',
        payload: { session_id: 'codex-sess-1', cwd: '/workspace' },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-11-04T10:00:01.000Z',
        payload: { type: 'task_started', turn_id: 'turn-alpha' },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-11-04T10:00:02.000Z',
        payload: { type: 'message', role: 'user', content: 'Run test suite' },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-11-04T10:00:03.000Z',
        payload: {
          type: 'custom_tool_call',
          name: 'shell',
          input: { command: 'pnpm test' },
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-11-04T10:00:04.000Z',
        payload: {
          type: 'item_completed',
          item: {
            type: 'CommandExecution',
            command: 'pnpm test',
            aggregated_output: '4 tests passed',
          },
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-11-04T10:00:05.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: 'All tests passed successfully.',
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-11-04T10:00:06.000Z',
        payload: { type: 'task_complete', turn_id: 'turn-alpha' },
      }),
    ];
    fs.writeFileSync(file, lines.join('\n') + '\n');

    const result = await reader.readHistory({
      sessionId: 'sess-codex-1',
      harness: 'codex',
      worktreePath: '/workspace',
      isLocal: true,
      resolvedTranscriptPath: file,
    });

    expect(result).not.toBeNull();
    expect(result?.source).toBe('transcript');
    expect(result?.items).toHaveLength(4); // user, tool call, tool completed output, agent reply

    expect(result?.items[0]).toMatchObject({
      role: 'user',
      text: 'Run test suite',
      turnBoundary: 'start',
      turnId: 'turn-alpha',
      timestamp: '2026-11-04T10:00:02.000Z',
    });
    expect(result?.items[1]).toMatchObject({
      role: 'tool',
      turnId: 'turn-alpha',
    });
    expect(result?.items[1].text).toContain('pnpm test');
    expect(result?.items[2]).toMatchObject({
      role: 'tool',
      turnId: 'turn-alpha',
    });
    expect(result?.items[2].text).toContain('4 tests passed');
    expect(result?.items[3]).toMatchObject({
      role: 'agent',
      text: 'All tests passed successfully.',
      turnBoundary: 'end',
      turnId: 'turn-alpha',
      timestamp: '2026-11-04T10:00:05.000Z',
    });
  });

  it('associates unequivocally with two sessions in the same folder using separate resolved paths', async () => {
    const file1 = path.join(tempDir, 'rollout-1.jsonl');
    const file2 = path.join(tempDir, 'rollout-2.jsonl');

    fs.writeFileSync(
      file1,
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: 'Codex 1' },
      }) + '\n'
    );
    fs.writeFileSync(
      file2,
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: 'Codex 2' },
      }) + '\n'
    );

    const res1 = await reader.readHistory({
      sessionId: 'sess-1',
      harness: 'codex',
      worktreePath: '/shared/dir',
      isLocal: true,
      resolvedTranscriptPath: file1,
    });

    const res2 = await reader.readHistory({
      sessionId: 'sess-2',
      harness: 'codex',
      worktreePath: '/shared/dir',
      isLocal: true,
      resolvedTranscriptPath: file2,
    });

    expect(res1?.items[0].text).toBe('Codex 1');
    expect(res2?.items[0].text).toBe('Codex 2');
  });

  it('reads incrementally using cursor and handles appended entries', async () => {
    const file = path.join(tempDir, 'rollout-inc.jsonl');
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: 'First message' },
      }) + '\n'
    );

    const first = await reader.readHistory({
      sessionId: 'sess-inc',
      harness: 'codex',
      worktreePath: '/ws',
      isLocal: true,
      resolvedTranscriptPath: file,
    });

    expect(first?.items).toHaveLength(1);
    expect(first?.cursor).toBeDefined();

    fs.appendFileSync(
      file,
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: 'Second message' },
      }) + '\n'
    );

    const second = await reader.readHistory(
      {
        sessionId: 'sess-inc',
        harness: 'codex',
        worktreePath: '/ws',
        isLocal: true,
        resolvedTranscriptPath: file,
      },
      { cursor: first?.cursor }
    );

    expect(second?.items).toHaveLength(1);
    expect(second?.items[0].text).toBe('Second message');
  });

  it('bounds item text length and marks textTruncated: true', async () => {
    const file = path.join(tempDir, 'rollout-long.jsonl');
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: 'B'.repeat(300) },
      }) + '\n'
    );

    const result = await reader.readHistory(
      {
        sessionId: 'sess-long',
        harness: 'codex',
        worktreePath: '/ws',
        isLocal: true,
        resolvedTranscriptPath: file,
      },
      { maxItemChars: 50 }
    );

    expect(result?.items[0].text).toHaveLength(50);
    expect(result?.items[0].textTruncated).toBe(true);
  });

  it('returns null safely when file is absent', async () => {
    const result = await reader.readHistory({
      sessionId: 'sess-missing',
      harness: 'codex',
      worktreePath: '/ws',
      isLocal: true,
      resolvedTranscriptPath: path.join(tempDir, 'does-not-exist.jsonl'),
    });

    expect(result).toBeNull();
  });

  it('handles partial / broken JSON lines without throwing', async () => {
    const file = path.join(tempDir, 'rollout-broken.jsonl');
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: 'Good line' },
      }) + '\n{"broken_json'
    );

    const result = await reader.readHistory({
      sessionId: 'sess-broken',
      harness: 'codex',
      worktreePath: '/ws',
      isLocal: true,
      resolvedTranscriptPath: file,
    });

    expect(result?.items).toHaveLength(1);
    expect(result?.items[0].text).toBe('Good line');
  });

  it('limits items and supports cursor pagination', async () => {
    const file = path.join(tempDir, 'rollout-limit.jsonl');
    const records = [
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: '1' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: '2' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: '3' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: '4' } }),
    ];
    fs.writeFileSync(file, records.join('\n') + '\n');

    const page1 = await reader.readHistory(
      {
        sessionId: 'sess-limit',
        harness: 'codex',
        worktreePath: '/ws',
        isLocal: true,
        resolvedTranscriptPath: file,
      },
      { limit: 2 }
    );

    expect(page1?.items).toHaveLength(2);
    expect(page1?.items[0].text).toBe('1');
    expect(page1?.items[1].text).toBe('2');
    expect(page1?.hasMore).toBe(true);

    const page2 = await reader.readHistory(
      {
        sessionId: 'sess-limit',
        harness: 'codex',
        worktreePath: '/ws',
        isLocal: true,
        resolvedTranscriptPath: file,
      },
      { limit: 2, cursor: page1?.cursor }
    );

    expect(page2?.items).toHaveLength(2);
    expect(page2?.items[0].text).toBe('3');
    expect(page2?.items[1].text).toBe('4');
    expect(page2?.hasMore).toBe(false);
  });

  it('resets cursor and pagination when the resolved rollout file changes', async () => {
    const fileA = path.join(tempDir, 'rollout-a.jsonl');
    const fileB = path.join(tempDir, 'rollout-b.jsonl');
    fs.writeFileSync(
      fileA,
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'A message' } }) + '\n'
    );
    fs.writeFileSync(
      fileB,
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'B initial message' } }) + '\n'
    );

    const first = await reader.readHistory({
      sessionId: 'sess-switch',
      harness: 'codex',
      worktreePath: '/ws',
      isLocal: true,
      resolvedTranscriptPath: fileA,
    });
    expect(first?.items[0].text).toBe('A message');

    // Switch to fileB using the cursor from fileA
    const switched = await reader.readHistory(
      {
        sessionId: 'sess-switch',
        harness: 'codex',
        worktreePath: '/ws',
        isLocal: true,
        resolvedTranscriptPath: fileB,
      },
      { cursor: first?.cursor }
    );
    expect(switched?.items[0].text).toBe('B initial message');
  });

  it('does not prematurely close turn on assistant commentary before tool calls', async () => {
    const file = path.join(tempDir, 'commentary-test.jsonl');
    const records = [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 't-comm' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'Run check' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'Checking repository...' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'shell', input: 'git status' } },
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: 'git status', aggregated_output: 'clean' } } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'Repository is clean.' } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't-comm' } },
    ];
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const result = await reader.readHistory({
      sessionId: 'sess-comm',
      harness: 'codex',
      worktreePath: '/ws',
      isLocal: true,
      resolvedTranscriptPath: file,
    });

    expect(result?.items).toHaveLength(5);
    expect(result?.items[0]).toMatchObject({ role: 'user', turnBoundary: 'start' });
    expect(result?.items[1]).toMatchObject({ role: 'agent', turnBoundary: undefined }); // commentary, NOT end
    expect(result?.items[2]).toMatchObject({ role: 'tool', turnBoundary: undefined });
    expect(result?.items[3]).toMatchObject({ role: 'tool', turnBoundary: undefined });
    expect(result?.items[4]).toMatchObject({ role: 'agent', turnBoundary: 'end' }); // final reply, IS end
  });

  it('processes buffered records following an oversized line', async () => {
    const file = path.join(tempDir, 'oversized-codex.jsonl');
    const records = [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'Y'.repeat(400 * 1024) } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'Done processing.' } },
    ];
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const result = await reader.readHistory({
      sessionId: 'sess-oversized-codex',
      harness: 'codex',
      worktreePath: '/ws',
      isLocal: true,
      resolvedTranscriptPath: file,
    });

    expect(result?.items).toHaveLength(2);
    expect(result?.items[0].textTruncated).toBe(true);
    expect(result?.items[1].text).toBe('Done processing.');
  });

  it('emits pending assistant item with turnBoundary: end when task_complete is appended in subsequent read', async () => {
    const file = path.join(tempDir, 'incremental-complete.jsonl');
    const initialRecords = [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-inc' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'Do something' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'Working on it' } },
    ];
    fs.writeFileSync(file, initialRecords.map((r) => JSON.stringify(r)).join('\n') + '\n');

    // First read: task_complete is not yet written
    const first = await reader.readHistory({
      sessionId: 'sess-inc',
      harness: 'codex',
      worktreePath: '/ws',
      isLocal: true,
      resolvedTranscriptPath: file,
    });

    expect(first?.items).toHaveLength(2);
    expect(first?.items[0]).toMatchObject({ role: 'user', turnBoundary: 'start' });
    expect(first?.items[1]).toMatchObject({ role: 'agent', turnBoundary: undefined });
    expect(first?.cursor).toContain(':pending:');

    // Append task_complete
    fs.appendFileSync(
      file,
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-inc' } }) + '\n'
    );

    // Second read: task_complete has arrived
    const second = await reader.readHistory(
      {
        sessionId: 'sess-inc',
        harness: 'codex',
        worktreePath: '/ws',
        isLocal: true,
        resolvedTranscriptPath: file,
      },
      { cursor: first?.cursor }
    );

    expect(second?.items).toHaveLength(1);
    expect(second?.items[0]).toMatchObject({
      role: 'agent',
      text: 'Working on it',
      turnBoundary: 'end',
      turnId: 'turn-inc',
    });
    expect(second?.cursor).toContain(':closed:1');
    expect(second?.cursor).not.toContain(':pending:');
  });

  it('returns null on nonempty unreadable transcript to allow screen fallback', async () => {
    const file = path.join(tempDir, 'corrupt.jsonl');
    fs.writeFileSync(file, 'not a valid json line at all\nsecond broken line\n');

    const result = await reader.readHistory({
      sessionId: 'sess-corrupt',
      harness: 'codex',
      worktreePath: '/ws',
      isLocal: true,
      resolvedTranscriptPath: file,
    });

    expect(result).toBeNull();
  });

  it('efficiently streams large multi-chunk records without quadratic buffer copies', async () => {
    const file = path.join(tempDir, 'large.jsonl');
    const largeText = 'W'.repeat(400 * 1024);
    const records = [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-large' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: `Start ${largeText}` } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'Finished large' } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-large' } },
    ];
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const result = await reader.readHistory({
      sessionId: 'sess-large',
      harness: 'codex',
      worktreePath: '/ws',
      isLocal: true,
      resolvedTranscriptPath: file,
    });

    expect(result).not.toBeNull();
    expect(result?.items).toHaveLength(2);
    expect(result?.items[0].textTruncated).toBe(true);
    expect(result?.items[1].text).toBe('Finished large');
    expect(result?.items[1].turnBoundary).toBe('end');
  });

  it('generates stable fallback turn IDs across paginated requests', async () => {
    const file = path.join(tempDir, 'fallback-turns.jsonl');
    // Two turns without turn_id in task_started
    const records = [
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'Turn 1 prompt' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'Turn 1 answer' } },
      { type: 'event_msg', payload: { type: 'task_complete' } },
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'Turn 2 prompt' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'Turn 2 answer' } },
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ];
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const context = {
      sessionId: 'sess-fb-turns',
      harness: 'codex',
      worktreePath: '/ws',
      isLocal: true,
      resolvedTranscriptPath: file,
    };

    // Unpaginated read
    const all = await reader.readHistory(context, { limit: 10 });
    expect(all?.items).toHaveLength(4);
    const turn1Id = all?.items[0].turnId;
    const turn2Id = all?.items[2].turnId;
    expect(turn1Id).toBeDefined();
    expect(turn2Id).toBeDefined();
    expect(turn1Id).not.toBe(turn2Id);

    // Paginated read across turns (page 1 reads turn 1, page 2 reads turn 2)
    const page1 = await reader.readHistory(context, { limit: 2 });
    expect(page1?.items).toHaveLength(2);
    expect(page1?.items[0].turnId).toBe(turn1Id);
    expect(page1?.items[1].turnId).toBe(turn1Id);

    const page2 = await reader.readHistory(context, { limit: 2, cursor: page1?.cursor });
    expect(page2?.items).toHaveLength(2);
    expect(page2?.items[0].turnId).toBe(turn2Id);
    expect(page2?.items[1].turnId).toBe(turn2Id);
  });

  it('detects rollout replacement under same filename and resets cursor to offset 0', async () => {
    const file = path.join(tempDir, 'rollout-rep.jsonl');
    const initialRecords = [
      { type: 'session_meta', payload: { session_id: 'codex-sess-init' } },
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'Short q' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'Short a' } },
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ];
    fs.writeFileSync(file, initialRecords.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const context = {
      sessionId: 'sess-rep-codex',
      harness: 'codex',
      worktreePath: '/ws',
      isLocal: true,
      resolvedTranscriptPath: file,
    };

    const firstRead = await reader.readHistory(context);
    expect(firstRead?.items).toHaveLength(2);
    expect(firstRead?.cursor).toBeDefined();

    // Overwrite the file with completely new content that is longer
    const newRecords = [
      { type: 'session_meta', payload: { session_id: 'codex-sess-replaced' } },
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'Substantially longer replaced prompt for replacement verification' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'Substantially longer replaced response after rollout reset' } },
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ];
    fs.writeFileSync(file, newRecords.map((r) => JSON.stringify(r)).join('\n') + '\n');

    // Querying with the old cursor should detect head fingerprint mismatch and reset to offset 0
    const secondRead = await reader.readHistory(context, { cursor: firstRead?.cursor });
    expect(secondRead).not.toBeNull();
    expect(secondRead?.items).toHaveLength(2);
    expect(secondRead?.items[0].text).toContain('Substantially longer replaced prompt');
    expect(secondRead?.items[1].text).toContain('Substantially longer replaced response');
  });
});
