import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
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

  it('keeps retained item offset when deduplicating paired user prompt so subsequent task_complete maintains stable item id', async () => {
    const file = path.join(tempDir, 'paired-prompt-stable-id.jsonl');
    const initialRecords = [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-pair-stable' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Hello Codex paired prompt' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'Hello Codex paired prompt' } },
    ];
    fs.writeFileSync(file, initialRecords.map((r) => JSON.stringify(r)).join('\n') + '\n');

    // Poll 1: after paired prompt records and before assistant output
    const first = await reader.readHistory({
      sessionId: 'sess-paired',
      harness: 'codex',
      worktreePath: '/ws',
      isLocal: true,
      resolvedTranscriptPath: file,
    });

    expect(first).not.toBeNull();
    expect(first?.items).toHaveLength(1);
    expect(first?.items[0].role).toBe('user');
    expect(first?.items[0].turnBoundary).toBe('start');
    const firstUserId = first!.items[0].id;
    expect(first?.cursor).toContain(':pending:');

    // Append task_complete without assistant output
    fs.appendFileSync(
      file,
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-pair-stable' } }) + '\n'
    );

    // Poll 2: after task_complete
    const second = await reader.readHistory(
      {
        sessionId: 'sess-paired',
        harness: 'codex',
        worktreePath: '/ws',
        isLocal: true,
        resolvedTranscriptPath: file,
      },
      { cursor: first?.cursor }
    );

    expect(second).not.toBeNull();
    expect(second?.items).toHaveLength(1);
    expect(second?.items[0].role).toBe('user');
    expect(second?.items[0].id).toBe(firstUserId);
    expect(second?.items[0].turnBoundary).toBe('single');
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

  it('skips injected context blocks (<user_instructions>, <environment_context>) without creating user items or starting turns', async () => {
    const file = path.join(tempDir, 'rollout-injected.jsonl');
    const records = [
      { id: 'meta-0', timestamp: '2026-01-01T00:00:00Z', instructions: 'fictional', git: {} },
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<user_instructions>\n# Fictional Guidelines\n- Work on one task at a time.\n- Build in dedicated worktrees.\n</user_instructions>',
          },
        ],
      },
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<environment_context>\n  <cwd>/workspace/project</cwd>\n  <approval_policy>on-request</approval_policy>\n</environment_context>',
          },
        ],
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: '<injected_context>\nSystem injected parameters\n</injected_context>',
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-real-1',
        },
      },
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Please implement the fictional feature according to specification.',
          },
        ],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'I have implemented the fictional feature and verified tests.',
          },
        ],
      },
      {
        type: 'event_msg',
        payload: {
          type: 'task_complete',
        },
      },
    ];
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const context = {
      sessionId: 'sess-injected-codex',
      harness: 'codex',
      worktreePath: '/ws',
      isLocal: true,
      resolvedTranscriptPath: file,
    };

    const res = await reader.readHistory(context);
    expect(res).not.toBeNull();
    // The three injected context records must be skipped; only the real prompt and response are returned
    expect(res?.items).toHaveLength(2);
    expect(res?.items[0]).toMatchObject({
      role: 'user',
      text: 'Please implement the fictional feature according to specification.',
      turnBoundary: 'start',
      turnId: 'turn-real-1',
    });
    expect(res?.items[1]).toMatchObject({
      role: 'agent',
      text: 'I have implemented the fictional feature and verified tests.',
      turnBoundary: 'end',
      turnId: 'turn-real-1',
    });
  });

  it('returns the most recent N exchanges in recent_exchanges mode for Codex and allows forward polling', async () => {
    const file = path.join(tempDir, 'rollout-recent.jsonl');
    const records = [];
    for (let i = 1; i <= 25; i++) {
      records.push({
        type: 'event_msg',
        payload: { type: 'user_message', message: `codex question ${i}` },
      });
      records.push({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: `codex answer ${i}` },
      });
    }
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const context = {
      sessionId: 'sess-recent-codex',
      harness: 'codex',
      worktreePath: '/ws',
      isLocal: true,
      resolvedTranscriptPath: file,
    };

    const result = await reader.readHistory(context, { limit: 15, mode: 'recent_exchanges' });
    expect(result).not.toBeNull();
    // 15 exchanges = 30 items
    expect(result?.items).toHaveLength(30);
    expect(result?.items[0].text).toBe('codex question 11');
    expect(result?.items.at(-1)?.text).toBe('codex answer 25');
    expect(result?.hasMore).toBe(false);

    // Incremental forward poll returns 0 items
    const poll1 = await reader.readHistory(context, { limit: 15, cursor: result?.cursor });
    expect(poll1?.items).toHaveLength(0);
  });

  it('counts paired user_message event and response_item user message as one logical exchange with 25 exchanges and limit 20', async () => {
    const file = path.join(tempDir, 'rollout-paired-25.jsonl');
    const records = [];
    for (let i = 1; i <= 25; i++) {
      // Paired prompt: both event_msg.user_message and response_item.message(user)
      records.push({
        type: 'event_msg',
        payload: { type: 'user_message', message: `question ${i}` },
      });
      records.push({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: `question ${i}` },
      });
      records.push({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: `answer ${i}` },
      });
    }
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const context = {
      sessionId: 'sess-paired-codex',
      harness: 'codex',
      worktreePath: '/ws',
      isLocal: true,
      resolvedTranscriptPath: file,
    };

    // Query 20 recent exchanges out of 25 total
    const result = await reader.readHistory(context, { limit: 20, mode: 'recent_exchanges' });
    expect(result).not.toBeNull();
    // 20 exchanges = 40 items (20 user + 20 agent), deduplicated paired user messages
    expect(result?.items).toHaveLength(40);
    expect(result?.items[0].text).toBe('question 6');
    expect(result?.items[0].role).toBe('user');
    expect(result?.items.at(-1)?.text).toBe('answer 25');
    expect(result?.items.at(-1)?.role).toBe('agent');
    expect(result?.hasMore).toBe(false);

    // Incremental forward poll with the returned cursor returns 0 items
    const pollForward = await reader.readHistory(context, { limit: 20, cursor: result?.cursor });
    expect(pollForward?.items).toHaveLength(0);
  });

  it('counts 100 exchanges all with identical prompt "continue" as distinct exchanges, and latest 2 returns exchanges 99-100', async () => {
    const file = path.join(tempDir, 'rollout-repeated-continue-100.jsonl');
    const records = [];
    for (let i = 1; i <= 100; i++) {
      records.push({
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: `turn-${i}` },
      });
      records.push({
        type: 'event_msg',
        payload: { type: 'user_message', message: 'continue' },
      });
      records.push({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: 'continue' },
      });
      records.push({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: `answer ${i}` },
      });
      records.push({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: `turn-${i}` },
      });
    }
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const context = {
      sessionId: 'sess-continue-100',
      harness: 'codex',
      worktreePath: '/ws',
      isLocal: true,
      resolvedTranscriptPath: file,
    };

    const result = await reader.readHistory(context, { limit: 2, mode: 'recent_exchanges' });
    expect(result).not.toBeNull();
    // 2 exchanges = 4 items (user 99, agent 99, user 100, agent 100)
    expect(result?.items).toHaveLength(4);
    expect(result?.items[0].role).toBe('user');
    expect(result?.items[0].text).toBe('continue');
    expect(result?.items[1].role).toBe('agent');
    expect(result?.items[1].text).toBe('answer 99');
    expect(result?.items[2].role).toBe('user');
    expect(result?.items[2].text).toBe('continue');
    expect(result?.items[3].role).toBe('agent');
    expect(result?.items[3].text).toBe('answer 100');
    expect(result?.hasMore).toBe(false);

    // Incremental forward poll returns 0 items
    const poll = await reader.readHistory(context, { limit: 2, cursor: result?.cursor });
    expect(poll?.items).toHaveLength(0);
  });

  it('counts 100 exchanges with "continue" when only response_item user messages exist, and latest 2 returns exchanges 99-100', async () => {
    const file = path.join(tempDir, 'rollout-response-only-100.jsonl');
    const records = [];
    for (let i = 1; i <= 100; i++) {
      records.push({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: 'continue' },
      });
      records.push({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: `answer ${i}` },
      });
    }
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const context = {
      sessionId: 'sess-response-100',
      harness: 'codex',
      worktreePath: '/ws',
      isLocal: true,
      resolvedTranscriptPath: file,
    };

    const result = await reader.readHistory(context, { limit: 2, mode: 'recent_exchanges' });
    expect(result).not.toBeNull();
    expect(result?.items).toHaveLength(4);
    expect(result?.items[0].text).toBe('continue');
    expect(result?.items[1].text).toBe('answer 99');
    expect(result?.items[2].text).toBe('continue');
    expect(result?.items[3].text).toBe('answer 100');
  });

  it('handles long initial context and long final response across 25 exchanges, returning exchanges 24-25', async () => {
    const file = path.join(tempDir, 'rollout-long-context-final.jsonl');
    const records = [];

    // Long initial context (> 64 KiB)
    const longContext = 'Initial system instructions and project context '.repeat(2000); // ~96 KiB
    records.push({
      type: 'session_meta',
      payload: { session_id: 'codex-sess-long-ctx', context: longContext },
    });

    // 25 exchanges
    for (let i = 1; i <= 25; i++) {
      records.push({
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: `turn-${i}` },
      });
      records.push({
        type: 'event_msg',
        payload: { type: 'user_message', message: `prompt ${i}` },
      });
      records.push({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: `prompt ${i}` },
      });
      if (i < 25) {
        records.push({
          type: 'response_item',
          payload: { type: 'message', role: 'assistant', content: `response ${i}` },
        });
      } else {
        // Final response is long (> 64 KiB)
        const longResponse = 'final response text chunk '.repeat(3000); // ~78 KiB
        records.push({
          type: 'response_item',
          payload: { type: 'message', role: 'assistant', content: longResponse },
        });
      }
      records.push({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: `turn-${i}` },
      });
    }

    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const context = {
      sessionId: 'sess-long-context',
      harness: 'codex',
      worktreePath: '/ws',
      isLocal: true,
      resolvedTranscriptPath: file,
    };

    const result = await reader.readHistory(context, { limit: 2, mode: 'recent_exchanges' });
    expect(result).not.toBeNull();
    // 2 exchanges = 4 items (user 24, agent 24, user 25, agent 25)
    expect(result?.items).toHaveLength(4);
    expect(result?.items[0].role).toBe('user');
    expect(result?.items[0].text).toBe('prompt 24');
    expect(result?.items[1].role).toBe('agent');
    expect(result?.items[1].text).toBe('response 24');
    expect(result?.items[2].role).toBe('user');
    expect(result?.items[2].text).toBe('prompt 25');
    expect(result?.items[3].role).toBe('agent');
    expect(result?.items[3].text).toContain('final response text chunk');
  });

  it('yields two user items when a turn is interrupted and the same prompt is repeated in the next turn', async () => {
    const file = path.join(tempDir, 'rollout-interrupted-turn.jsonl');
    const records = [
      // Turn 1: started, user prompt "run tests", then interrupted (turn_aborted, no assistant response)
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1' },
      },
      {
        type: 'event_msg',
        payload: { type: 'user_message', message: 'run tests' },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: 'run tests' },
      },
      {
        type: 'event_msg',
        payload: { type: 'turn_aborted', turn_id: 'turn-1' },
      },
      // Turn 2: started, same user prompt "run tests", completed normally
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-2' },
      },
      {
        type: 'event_msg',
        payload: { type: 'user_message', message: 'run tests' },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: 'run tests' },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: 'Tests completed successfully.' },
      },
      {
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-2' },
      },
    ];

    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const context = {
      sessionId: 'sess-interrupted',
      harness: 'codex',
      worktreePath: '/ws',
      isLocal: true,
      resolvedTranscriptPath: file,
    };

    const result = await reader.readHistory(context);
    expect(result).not.toBeNull();
    // Items: user 1 ("run tests"), user 2 ("run tests"), agent 2 ("Tests completed successfully.")
    expect(result?.items).toHaveLength(3);
    expect(result?.items[0].role).toBe('user');
    expect(result?.items[0].text).toBe('run tests');
    expect(result?.items[0].turnId).toBe('turn-1');
    expect(result?.items[1].role).toBe('user');
    expect(result?.items[1].text).toBe('run tests');
    expect(result?.items[1].turnId).toBe('turn-2');
    expect(result?.items[2].role).toBe('agent');
    expect(result?.items[2].text).toBe('Tests completed successfully.');
    expect(result?.items[2].turnId).toBe('turn-2');
  });

  it('reads only the tail when requesting latest 2 exchanges from a 20+ MB response_item-only rollout', async () => {
    const file = path.join(tempDir, 'rollout-response-only-20mb.jsonl');

    // 10,000 exchanges with 2 KiB response each -> ~21.7 MB
    const fdWrite = fs.openSync(file, 'w');
    const dummyPayload = 'z'.repeat(2000);
    for (let i = 1; i <= 10000; i++) {
      const u = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: `query-${i}` } }) + '\n';
      const a = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: dummyPayload } }) + '\n';
      fs.writeSync(fdWrite, Buffer.from(u, 'utf8'));
      fs.writeSync(fdWrite, Buffer.from(a, 'utf8'));
    }
    fs.closeSync(fdWrite);

    const stat = fs.statSync(file);
    expect(stat.size).toBeGreaterThan(20 * 1024 * 1024);

    const context = {
      sessionId: 'sess-large-response-only',
      harness: 'codex',
      worktreePath: '/ws',
      isLocal: true,
      resolvedTranscriptPath: file,
    };

    let totalBytesRead = 0;
    const originalReadSync = fs.readSync;
    fs.readSync = function (this: any, ...args: any[]) {
      const bytes = (originalReadSync as any).apply(this, args);
      if (typeof bytes === 'number' && bytes > 0) {
        totalBytesRead += bytes;
      }
      return bytes;
    } as any;
    syncBuiltinESMExports();

    try {
      const result = await reader.readHistory(context, { limit: 2, mode: 'recent_exchanges' });
      expect(result).not.toBeNull();
      // Latest 2 exchanges: queries 9999 and 10000
      expect(result?.items).toHaveLength(4);
      expect(result?.items[0].text).toBe('query-9999');
      expect(result?.items[2].text).toBe('query-10000');

      // Crucial assertion: bytes read is far below the 20+ MB file size (reads only the tail chunks)
      expect(totalBytesRead).toBeLessThan(512 * 1024);
    } finally {
      fs.readSync = originalReadSync;
      syncBuiltinESMExports();
    }
  });
});
