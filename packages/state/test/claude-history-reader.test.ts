import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ClaudeHistoryReader,
  encodeClaudeProjectPath,
  resolveClaudeTranscriptPath,
} from '../src/history/claude-history-reader.js';

describe('ClaudeHistoryReader', () => {
  let tempHome: string;
  let reader: ClaudeHistoryReader;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hist-test-'));
    reader = new ClaudeHistoryReader();
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  describe('encodeClaudeProjectPath', () => {
    it('normalizes path and replaces non-alphanumeric chars with dashes', () => {
      expect(encodeClaudeProjectPath('/var/project/my-app')).toBe('-var-project-my-app');
      expect(encodeClaudeProjectPath('C:\\Users\\dev\\project')).toBe('C--Users-dev-project');
      expect(encodeClaudeProjectPath('/project/sub_dir/')).toBe('-project-sub-dir');
    });

    it('truncates to 200 chars and appends polynomial path hash when sanitized path exceeds 200 chars', () => {
      const longCwd = '/workspace/' + [
        'nested-project'.repeat(4),
        'subdirectory'.repeat(4),
        'source-component'.repeat(6),
      ].join('/');

      let expectedHash = 0;
      for (let i = 0; i < longCwd.length; i++) {
        expectedHash = (Math.imul(31, expectedHash) + longCwd.charCodeAt(i)) | 0;
      }
      const expectedDir = longCwd.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200) + '-' + Math.abs(expectedHash).toString(36);

      expect(encodeClaudeProjectPath(longCwd)).toBe(expectedDir);
    });
  });

  describe('resolveClaudeTranscriptPath', () => {
    it('constructs expected path under ~/.claude/projects/<sanitized-cwd>/<uuid>.jsonl', () => {
      const p = resolveClaudeTranscriptPath({
        sessionId: 'sess-1',
        harness: 'claude',
        worktreePath: '/data/repo',
        isLocal: true,
        agentSessionId: 'uuid-1234',
        homeDir: tempHome,
      });
      expect(p).toBe(path.join(tempHome, '.claude', 'projects', '-data-repo', 'uuid-1234.jsonl'));
    });
  });

  describe('readHistory with synthetic fixtures', () => {
    it('separates user, agent, and tool with turn boundaries and timestamps', async () => {
      const worktreePath = '/data/test-project';
      const encoded = encodeClaudeProjectPath(worktreePath);
      const projDir = path.join(tempHome, '.claude', 'projects', encoded);
      fs.mkdirSync(projDir, { recursive: true });

      const transcriptFile = path.join(projDir, 'session-abc.jsonl');
      const lines = [
        JSON.stringify({
          type: 'user',
          uuid: 'turn-1',
          timestamp: '2026-11-04T10:00:00.000Z',
          message: { role: 'user', content: 'Please inspect the repository' },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-11-04T10:00:01.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', name: 'list_files', input: { path: '.' } },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          timestamp: '2026-11-04T10:00:02.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', content: 'file1.txt\nfile2.txt' },
            ],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-11-04T10:00:03.000Z',
          message: {
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [
              { type: 'text', text: 'I found file1.txt and file2.txt.' },
            ],
          },
        }),
      ];
      fs.writeFileSync(transcriptFile, lines.join('\n') + '\n');

      const result = await reader.readHistory({
        sessionId: 'sess-1',
        harness: 'claude',
        worktreePath,
        isLocal: true,
        agentSessionId: 'session-abc',
        homeDir: tempHome,
      });

      expect(result).not.toBeNull();
      expect(result?.source).toBe('transcript');
      expect(result?.items).toHaveLength(4);

      // Check roles
      expect(result?.items[0]).toMatchObject({
        role: 'user',
        text: 'Please inspect the repository',
        source: 'transcript',
        turnBoundary: 'start',
        timestamp: '2026-11-04T10:00:00.000Z',
      });
      expect(result?.items[1]).toMatchObject({
        role: 'tool',
        source: 'transcript',
      });
      expect(result?.items[1].text).toContain('list_files');
      expect(result?.items[2]).toMatchObject({
        role: 'tool',
        source: 'transcript',
      });
      expect(result?.items[2].text).toContain('file1.txt');
      expect(result?.items[3]).toMatchObject({
        role: 'agent',
        text: 'I found file1.txt and file2.txt.',
        source: 'transcript',
        turnBoundary: 'end',
        timestamp: '2026-11-04T10:00:03.000Z',
      });
    });

    it('associates unequivocally with two sessions in the same folder', async () => {
      const worktreePath = '/shared/workspace';
      const encoded = encodeClaudeProjectPath(worktreePath);
      const projDir = path.join(tempHome, '.claude', 'projects', encoded);
      fs.mkdirSync(projDir, { recursive: true });

      const file1 = path.join(projDir, 'session-111.jsonl');
      const file2 = path.join(projDir, 'session-222.jsonl');

      fs.writeFileSync(
        file1,
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'Message for session 1' },
        }) + '\n'
      );
      fs.writeFileSync(
        file2,
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'Message for session 2' },
        }) + '\n'
      );

      const res1 = await reader.readHistory({
        sessionId: 'sess-1',
        harness: 'claude',
        worktreePath,
        isLocal: true,
        agentSessionId: 'session-111',
        homeDir: tempHome,
      });

      const res2 = await reader.readHistory({
        sessionId: 'sess-2',
        harness: 'claude',
        worktreePath,
        isLocal: true,
        agentSessionId: 'session-222',
        homeDir: tempHome,
      });

      expect(res1?.items[0].text).toBe('Message for session 1');
      expect(res2?.items[0].text).toBe('Message for session 2');
    });

    it('reads incrementally using cursor and handles appended lines', async () => {
      const worktreePath = '/data/incremental';
      const encoded = encodeClaudeProjectPath(worktreePath);
      const projDir = path.join(tempHome, '.claude', 'projects', encoded);
      fs.mkdirSync(projDir, { recursive: true });

      const file = path.join(projDir, 'sess-inc.jsonl');
      fs.writeFileSync(
        file,
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'Initial message' },
        }) + '\n'
      );

      const firstRead = await reader.readHistory({
        sessionId: 'sess-inc',
        harness: 'claude',
        worktreePath,
        isLocal: true,
        agentSessionId: 'sess-inc',
        homeDir: tempHome,
      });

      expect(firstRead?.items).toHaveLength(1);
      expect(firstRead?.cursor).toBeDefined();

      // Appending new line
      fs.appendFileSync(
        file,
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: 'Appended reply' },
        }) + '\n'
      );

      const secondRead = await reader.readHistory(
        {
          sessionId: 'sess-inc',
          harness: 'claude',
          worktreePath,
          isLocal: true,
          agentSessionId: 'sess-inc',
          homeDir: tempHome,
        },
        { cursor: firstRead?.cursor }
      );

      expect(secondRead?.items).toHaveLength(1);
      expect(secondRead?.items[0].text).toBe('Appended reply');
      expect(secondRead?.cursor).not.toBe(firstRead?.cursor);
    });

    it('bounds item text length and marks textTruncated: true', async () => {
      const worktreePath = '/data/bounded';
      const encoded = encodeClaudeProjectPath(worktreePath);
      const projDir = path.join(tempHome, '.claude', 'projects', encoded);
      fs.mkdirSync(projDir, { recursive: true });

      const file = path.join(projDir, 'sess-long.jsonl');
      const longText = 'A'.repeat(500);
      fs.writeFileSync(
        file,
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: longText },
        }) + '\n'
      );

      const result = await reader.readHistory(
        {
          sessionId: 'sess-long',
          harness: 'claude',
          worktreePath,
          isLocal: true,
          agentSessionId: 'sess-long',
          homeDir: tempHome,
        },
        { maxItemChars: 100 }
      );

      expect(result?.items[0].text).toHaveLength(100);
      expect(result?.items[0].textTruncated).toBe(true);
    });

    it('limits items and sets hasMore: true', async () => {
      const worktreePath = '/data/limit';
      const encoded = encodeClaudeProjectPath(worktreePath);
      const projDir = path.join(tempHome, '.claude', 'projects', encoded);
      fs.mkdirSync(projDir, { recursive: true });

      const file = path.join(projDir, 'sess-limit.jsonl');
      const lines = [
        JSON.stringify({ type: 'user', message: { role: 'user', content: '1' } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: '2' } }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: '3' } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: '4' } }),
      ];
      fs.writeFileSync(file, lines.join('\n') + '\n');

      const result = await reader.readHistory(
        {
          sessionId: 'sess-limit',
          harness: 'claude',
          worktreePath,
          isLocal: true,
          agentSessionId: 'sess-limit',
          homeDir: tempHome,
        },
        { limit: 2 }
      );

      expect(result?.items).toHaveLength(2);
      expect(result?.items[0].text).toBe('1');
      expect(result?.items[1].text).toBe('2');
      expect(result?.hasMore).toBe(true);

      const page2 = await reader.readHistory(
        {
          sessionId: 'sess-limit',
          harness: 'claude',
          worktreePath,
          isLocal: true,
          agentSessionId: 'sess-limit',
          homeDir: tempHome,
        },
        { limit: 2, cursor: result?.cursor }
      );
      expect(page2?.items).toHaveLength(2);
      expect(page2?.items[0].text).toBe('3');
      expect(page2?.items[1].text).toBe('4');
      expect(page2?.hasMore).toBe(false);
    });

    it('returns null safely when file is absent', async () => {
      const result = await reader.readHistory({
        sessionId: 'sess-missing',
        harness: 'claude',
        worktreePath: '/nonexistent/path',
        isLocal: true,
        agentSessionId: 'not-on-disk',
        homeDir: tempHome,
      });

      expect(result).toBeNull();
    });

    it('handles truncated or partial JSON line at end without crashing', async () => {
      const worktreePath = '/data/truncated';
      const encoded = encodeClaudeProjectPath(worktreePath);
      const projDir = path.join(tempHome, '.claude', 'projects', encoded);
      fs.mkdirSync(projDir, { recursive: true });

      const file = path.join(projDir, 'sess-trunc.jsonl');
      const lines = [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'Valid line' } }),
        '{"type":"assistant","message":{"content":"Par', // Broken trailing line
      ];
      fs.writeFileSync(file, lines.join('\n'));

      const result = await reader.readHistory({
        sessionId: 'sess-trunc',
        harness: 'claude',
        worktreePath,
        isLocal: true,
        agentSessionId: 'sess-trunc',
        homeDir: tempHome,
      });

      expect(result?.items).toHaveLength(1);
      expect(result?.items[0].text).toBe('Valid line');
    });

    it('handles rotated or shrunk file when cursor is past EOF', async () => {
      const worktreePath = '/data/rotated';
      const encoded = encodeClaudeProjectPath(worktreePath);
      const projDir = path.join(tempHome, '.claude', 'projects', encoded);
      fs.mkdirSync(projDir, { recursive: true });

      const file = path.join(projDir, 'sess-rot.jsonl');
      fs.writeFileSync(
        file,
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'Newer shorter file' } }) + '\n'
      );

      const result = await reader.readHistory(
        {
          sessionId: 'sess-rot',
          harness: 'claude',
          worktreePath,
          isLocal: true,
          agentSessionId: 'sess-rot',
          homeDir: tempHome,
        },
        { cursor: 'offset:999999:block:1' } // Past EOF with leftover block index
      );

      expect(result?.items).toHaveLength(1);
      expect(result?.items[0].text).toBe('Newer shorter file');
    });

    it('preserves completed turn endings across page boundaries', async () => {
      const worktreePath = '/data/page-boundary';
      const encoded = encodeClaudeProjectPath(worktreePath);
      const projDir = path.join(tempHome, '.claude', 'projects', encoded);
      fs.mkdirSync(projDir, { recursive: true });

      const file = path.join(projDir, 'sess-pb.jsonl');
      const records = [
        { type: 'user', uuid: 'u1', message: { content: 'question 1' } },
        { type: 'assistant', uuid: 'a1', message: { content: 'answer 1', stop_reason: 'end_turn' } },
        { type: 'user', uuid: 'u2', message: { content: 'question 2' } },
        { type: 'assistant', uuid: 'a2', message: { content: 'answer 2', stop_reason: 'end_turn' } },
      ];
      fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

      const context = {
        sessionId: 'sess-pb',
        harness: 'claude',
        worktreePath,
        isLocal: true,
        agentSessionId: 'sess-pb',
        homeDir: tempHome,
      };

      const page1 = await reader.readHistory(context, { limit: 2 });
      expect(page1?.items).toHaveLength(2);
      expect(page1?.items[0].turnBoundary).toBe('start');
      expect(page1?.items[1].turnBoundary).toBe('end');
      expect(page1?.hasMore).toBe(true);

      const page2 = await reader.readHistory(context, { limit: 2, cursor: page1?.cursor });
      expect(page2?.items).toHaveLength(2);
      expect(page2?.items[0].turnBoundary).toBe('start');
      expect(page2?.items[1].turnBoundary).toBe('end');
      expect(page2?.hasMore).toBe(false);
    });

    it('processes buffered records following an oversized line', async () => {
      const worktreePath = '/data/oversized';
      const encoded = encodeClaudeProjectPath(worktreePath);
      const projDir = path.join(tempHome, '.claude', 'projects', encoded);
      fs.mkdirSync(projDir, { recursive: true });

      const file = path.join(projDir, 'sess-oversized.jsonl');
      const records = [
        { type: 'user', uuid: 'u1', message: { content: 'X'.repeat(400 * 1024) } },
        { type: 'assistant', uuid: 'a1', message: { content: 'Followup response', stop_reason: 'end_turn' } },
      ];
      fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

      const result = await reader.readHistory({
        sessionId: 'sess-oversized',
        harness: 'claude',
        worktreePath,
        isLocal: true,
        agentSessionId: 'sess-oversized',
        homeDir: tempHome,
      });

      expect(result?.items).toHaveLength(2);
      expect(result?.items[0].textTruncated).toBe(true);
      expect(result?.items[1].text).toBe('Followup response');
      expect(result?.items[1].turnBoundary).toBe('end');
    });

    it('marks only the final text block as turnBoundary: end in multi-block assistant message', async () => {
      const worktreePath = '/data/multiblock';
      const encoded = encodeClaudeProjectPath(worktreePath);
      const projDir = path.join(tempHome, '.claude', 'projects', encoded);
      fs.mkdirSync(projDir, { recursive: true });

      const file = path.join(projDir, 'sess-mb.jsonl');
      const records = [
        { type: 'user', uuid: 'u1', message: { content: 'Inspect code' } },
        {
          type: 'assistant',
          uuid: 'a1',
          message: {
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [
              { type: 'text', text: 'First paragraph analysis.' },
              { type: 'text', text: 'Second paragraph conclusion.' },
            ],
          },
        },
      ];
      fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

      const result = await reader.readHistory({
        sessionId: 'sess-mb',
        harness: 'claude',
        worktreePath,
        isLocal: true,
        agentSessionId: 'sess-mb',
        homeDir: tempHome,
      });

      expect(result?.items).toHaveLength(3);
      expect(result?.items[0]).toMatchObject({ role: 'user', turnBoundary: 'start' });
      expect(result?.items[1]).toMatchObject({
        role: 'agent',
        text: 'First paragraph analysis.',
        turnBoundary: undefined,
      });
      expect(result?.items[2]).toMatchObject({
        role: 'agent',
        text: 'Second paragraph conclusion.',
        turnBoundary: 'end',
      });
    });

    it('preserves single turnBoundary: start across block continuation pages', async () => {
      const worktreePath = '/data/user-multiblock';
      const encoded = encodeClaudeProjectPath(worktreePath);
      const projDir = path.join(tempHome, '.claude', 'projects', encoded);
      fs.mkdirSync(projDir, { recursive: true });

      const file = path.join(projDir, 'sess-umb.jsonl');
      const records = [
        {
          type: 'user',
          uuid: 'u-multi',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'First user block' },
              { type: 'text', text: 'Second user block' },
            ],
          },
        },
        {
          type: 'assistant',
          uuid: 'a-multi',
          message: {
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Response to both blocks' }],
          },
        },
      ];
      fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

      const context = {
        sessionId: 'sess-umb',
        harness: 'claude',
        worktreePath,
        isLocal: true,
        agentSessionId: 'sess-umb',
        homeDir: tempHome,
      };

      // Page 1 with limit: 1 returns only the first block
      const page1 = await reader.readHistory(context, { limit: 1 });
      expect(page1?.items).toHaveLength(1);
      expect(page1?.items[0].text).toBe('First user block');
      expect(page1?.items[0].turnBoundary).toBe('start');
      expect(page1?.hasMore).toBe(true);

      // Page 2 resumes from block cursor
      const page2 = await reader.readHistory(context, { limit: 1, cursor: page1?.cursor });
      expect(page2?.items).toHaveLength(1);
      expect(page2?.items[0].text).toBe('Second user block');
      // Must NOT be marked as start again
      expect(page2?.items[0].turnBoundary).toBeUndefined();
      expect(page2?.hasMore).toBe(true);

      // Page 3 returns assistant response
      const page3 = await reader.readHistory(context, { limit: 1, cursor: page2?.cursor });
      expect(page3?.items).toHaveLength(1);
      expect(page3?.items[0].text).toBe('Response to both blocks');
      expect(page3?.items[0].turnBoundary).toBe('end');
    });

    it('preserves prompt text following a large image block in user message', async () => {
      const worktreePath = '/data/image-prompt';
      const encoded = encodeClaudeProjectPath(worktreePath);
      const projDir = path.join(tempHome, '.claude', 'projects', encoded);
      fs.mkdirSync(projDir, { recursive: true });

      const file = path.join(projDir, 'sess-img.jsonl');
      const records = [
        {
          type: 'user',
          uuid: 'u-img',
          message: {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', data: 'A'.repeat(400 * 1024) } },
              { type: 'text', text: 'Analyze this chart' },
            ],
          },
        },
        {
          type: 'assistant',
          uuid: 'a-img',
          message: {
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'The chart indicates growth.' }],
          },
        },
      ];
      fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

      const result = await reader.readHistory({
        sessionId: 'sess-img',
        harness: 'claude',
        worktreePath,
        isLocal: true,
        agentSessionId: 'sess-img',
        homeDir: tempHome,
      });

      expect(result?.items).toHaveLength(2);
      expect(result?.items[0]).toMatchObject({
        role: 'user',
        text: 'Analyze this chart',
        turnBoundary: 'start',
      });
      expect(result?.items[1]).toMatchObject({
        role: 'agent',
        text: 'The chart indicates growth.',
        turnBoundary: 'end',
      });
    });

    it('returns empty transcript page instead of null on exhausted block continuation in record 0', async () => {
      const worktreePath = '/data/exhaust-block';
      const encoded = encodeClaudeProjectPath(worktreePath);
      const projDir = path.join(tempHome, '.claude', 'projects', encoded);
      fs.mkdirSync(projDir, { recursive: true });

      const file = path.join(projDir, 'sess-ex.jsonl');
      const records = [
        {
          type: 'user',
          uuid: 'u-ex',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'Prompt text' },
              { type: 'image', source: { type: 'base64', data: 'data123' } },
            ],
          },
        },
      ];
      fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

      const context = {
        sessionId: 'sess-ex',
        harness: 'claude',
        worktreePath,
        isLocal: true,
        agentSessionId: 'sess-ex',
        homeDir: tempHome,
      };

      const page1 = await reader.readHistory(context, { limit: 1 });
      expect(page1).not.toBeNull();
      expect(page1?.items).toHaveLength(1);
      expect(page1?.items[0].text).toBe('Prompt text');
      expect(page1?.hasMore).toBe(true);
      expect(page1?.cursor).toContain(':block:1');

      // Page 2 resumes from block 1 (image), reaching EOF with 0 items
      const page2 = await reader.readHistory(context, { limit: 1, cursor: page1?.cursor });
      expect(page2).not.toBeNull();
      expect(page2?.source).toBe('transcript');
      expect(page2?.items).toHaveLength(0);
      expect(page2?.hasMore).toBe(false);
    });

    it('efficiently streams large multi-chunk records without quadratic buffer copies', async () => {
      const worktreePath = '/data/multi-chunk';
      const encoded = encodeClaudeProjectPath(worktreePath);
      const projDir = path.join(tempHome, '.claude', 'projects', encoded);
      fs.mkdirSync(projDir, { recursive: true });

      const file = path.join(projDir, 'sess-mc.jsonl');
      // Create a 500 KiB record (spans multiple 64 KiB buffer chunks)
      const largePayload = 'Z'.repeat(500 * 1024);
      const records = [
        {
          type: 'user',
          uuid: 'u-large',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: `Prefix ${largePayload}` },
            ],
          },
        },
        {
          type: 'assistant',
          uuid: 'a-large',
          message: {
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Done streaming large payload.' }],
          },
        },
      ];
      fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

      const result = await reader.readHistory({
        sessionId: 'sess-mc',
        harness: 'claude',
        worktreePath,
        isLocal: true,
        agentSessionId: 'sess-mc',
        homeDir: tempHome,
      });

      expect(result).not.toBeNull();
      expect(result?.items).toHaveLength(2);
      expect(result?.items[0].textTruncated).toBe(true);
      expect(result?.items[1].text).toBe('Done streaming large payload.');
      expect(result?.items[1].turnBoundary).toBe('end');
    });

    it('marks refusal stop_reason as turnBoundary end', async () => {
      const worktreePath = '/data/refusal';
      const encoded = encodeClaudeProjectPath(worktreePath);
      const projDir = path.join(tempHome, '.claude', 'projects', encoded);
      fs.mkdirSync(projDir, { recursive: true });

      const file = path.join(projDir, 'sess-refusal.jsonl');
      const records = [
        {
          type: 'user',
          uuid: 'u-refusal',
          message: {
            role: 'user',
            content: 'Do something unsupported',
          },
        },
        {
          type: 'assistant',
          uuid: 'a-refusal',
          message: {
            role: 'assistant',
            stop_reason: 'refusal',
            content: 'I cannot fulfill this request.',
          },
        },
      ];
      fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

      const result = await reader.readHistory({
        sessionId: 'sess-refusal',
        harness: 'claude',
        worktreePath,
        isLocal: true,
        agentSessionId: 'sess-refusal',
        homeDir: tempHome,
      });

      expect(result).not.toBeNull();
      expect(result?.items).toHaveLength(2);
      expect(result?.items[0].turnBoundary).toBe('start');
      expect(result?.items[1].turnBoundary).toBe('end');
      expect(result?.items[1].text).toBe('I cannot fulfill this request.');
    });

    it('detects file replacement under same filename and resets cursor to offset 0', async () => {
      const worktreePath = '/data/replaced';
      const encoded = encodeClaudeProjectPath(worktreePath);
      const projDir = path.join(tempHome, '.claude', 'projects', encoded);
      fs.mkdirSync(projDir, { recursive: true });

      const file = path.join(projDir, 'sess-rep.jsonl');
      const initialRecords = [
        {
          type: 'user',
          uuid: 'u-init',
          message: { role: 'user', content: 'Short first question' },
        },
        {
          type: 'assistant',
          uuid: 'a-init',
          message: { role: 'assistant', stop_reason: 'end_turn', content: 'Short answer' },
        },
      ];
      fs.writeFileSync(file, initialRecords.map((r) => JSON.stringify(r)).join('\n') + '\n');

      const context = {
        sessionId: 'sess-rep',
        harness: 'claude',
        worktreePath,
        isLocal: true,
        agentSessionId: 'sess-rep',
        homeDir: tempHome,
      };

      const firstRead = await reader.readHistory(context);
      expect(firstRead?.items).toHaveLength(2);
      expect(firstRead?.cursor).toBeDefined();

      // Overwrite the file with completely new content that is longer
      const newRecords = [
        {
          type: 'user',
          uuid: 'u-new',
          message: { role: 'user', content: 'Completely replaced prompt that is significantly longer than original' },
        },
        {
          type: 'assistant',
          uuid: 'a-new',
          message: { role: 'assistant', stop_reason: 'end_turn', content: 'Completely new response after file replacement' },
        },
      ];
      fs.writeFileSync(file, newRecords.map((r) => JSON.stringify(r)).join('\n') + '\n');

      // Querying with the old cursor should detect different head fingerprint and reset to offset 0
      const secondRead = await reader.readHistory(context, { cursor: firstRead?.cursor });
      expect(secondRead).not.toBeNull();
      expect(secondRead?.items).toHaveLength(2);
      expect(secondRead?.items[0].text).toContain('Completely replaced prompt');
      expect(secondRead?.items[1].text).toContain('Completely new response');
    });

    it('handles streamed assistant entries with stop_reason: null followed by system/turn_duration record', async () => {
      const worktreePath = '/data/streamed';
      const encoded = encodeClaudeProjectPath(worktreePath);
      const projDir = path.join(tempHome, '.claude', 'projects', encoded);
      fs.mkdirSync(projDir, { recursive: true });

      const file = path.join(projDir, 'sess-streamed.jsonl');
      const records = [
        {
          type: 'user',
          uuid: 'u-stream',
          message: { role: 'user', content: 'What is 2+2?' },
        },
        {
          type: 'assistant',
          uuid: 'a-stream',
          message: { role: 'assistant', stop_reason: null, content: '4' },
        },
        {
          type: 'system',
          subtype: 'turn_duration',
          duration_ms: 1200,
        },
      ];
      fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

      const result = await reader.readHistory({
        sessionId: 'sess-streamed',
        harness: 'claude',
        worktreePath,
        isLocal: true,
        agentSessionId: 'sess-streamed',
        homeDir: tempHome,
      });

      expect(result).not.toBeNull();
      expect(result?.items).toHaveLength(2);
      expect(result?.items[0].turnBoundary).toBe('start');
      expect(result?.items[1].turnBoundary).toBe('end');
      expect(result?.items[1].text).toBe('4');
    });

    it('emits pending assistant item with turnBoundary: end when system/turn_duration is appended in subsequent read', async () => {
      const worktreePath = '/data/pending-stream';
      const encoded = encodeClaudeProjectPath(worktreePath);
      const projDir = path.join(tempHome, '.claude', 'projects', encoded);
      fs.mkdirSync(projDir, { recursive: true });

      const file = path.join(projDir, 'sess-pending-stream.jsonl');
      const initialRecords = [
        {
          type: 'user',
          uuid: 'u-pend',
          message: { role: 'user', content: 'Prompt' },
        },
        {
          type: 'assistant',
          uuid: 'a-pend',
          message: { role: 'assistant', stop_reason: null, content: 'Ongoing answer' },
        },
      ];
      fs.writeFileSync(file, initialRecords.map((r) => JSON.stringify(r)).join('\n') + '\n');

      const context = {
        sessionId: 'sess-pending-stream',
        harness: 'claude',
        worktreePath,
        isLocal: true,
        agentSessionId: 'sess-pending-stream',
        homeDir: tempHome,
      };

      const firstRead = await reader.readHistory(context);
      expect(firstRead?.items).toHaveLength(2);
      expect(firstRead?.items[1].turnBoundary).toBeUndefined();
      expect(firstRead?.cursor).toContain(':pending:');

      // Append turn duration record
      fs.appendFileSync(
        file,
        JSON.stringify({
          type: 'system',
          subtype: 'turn_duration',
          duration_ms: 850,
        }) + '\n'
      );

      const secondRead = await reader.readHistory(context, { cursor: firstRead?.cursor });
      expect(secondRead).not.toBeNull();
      expect(secondRead?.items).toHaveLength(1);
      expect(secondRead?.items[0].role).toBe('agent');
      expect(secondRead?.items[0].text).toBe('Ongoing answer');
      expect(secondRead?.items[0].turnBoundary).toBe('end');
      expect(secondRead?.cursor).toContain(':closed:1');
    });

    it('does not advance past multi-block assistant record when pagination stops before last block followed by completion', async () => {
      const worktreePath = '/data/multi-block-comp';
      const encoded = encodeClaudeProjectPath(worktreePath);
      const projDir = path.join(tempHome, '.claude', 'projects', encoded);
      fs.mkdirSync(projDir, { recursive: true });

      const file = path.join(projDir, 'sess-mb-comp.jsonl');
      const records = [
        {
          type: 'user',
          uuid: 'u-mb',
          message: { role: 'user', content: 'Explain in two steps' },
        },
        {
          type: 'assistant',
          uuid: 'a-mb',
          message: {
            role: 'assistant',
            stop_reason: null,
            content: [
              { type: 'text', text: 'Step 1: First point' },
              { type: 'text', text: 'Step 2: Second point' },
            ],
          },
        },
        {
          type: 'system',
          subtype: 'turn_duration',
          duration_ms: 500,
        },
      ];
      fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

      const context = {
        sessionId: 'sess-mb-comp',
        harness: 'claude',
        worktreePath,
        isLocal: true,
        agentSessionId: 'sess-mb-comp',
        homeDir: tempHome,
      };

      // Read page 1 with limit 2: gets user prompt and Step 1
      const page1 = await reader.readHistory(context, { limit: 2 });
      expect(page1).not.toBeNull();
      expect(page1?.items).toHaveLength(2);
      expect(page1?.items[0].text).toBe('Explain in two steps');
      expect(page1?.items[1].text).toBe('Step 1: First point');
      expect(page1?.hasMore).toBe(true);
      expect(page1?.cursor).toContain(':block:1');

      // Read page 2: must return Step 2 with turnBoundary: end!
      const page2 = await reader.readHistory(context, { limit: 2, cursor: page1?.cursor });
      expect(page2).not.toBeNull();
      expect(page2?.items).toHaveLength(1);
      expect(page2?.items[0].text).toBe('Step 2: Second point');
      expect(page2?.items[0].turnBoundary).toBe('end');
    });

    it('replays only the boundary-updating item when system/turn_duration is appended to multi-block message and limit is 1', async () => {
      const worktreePath = '/data/mb-pending-limit';
      const encoded = encodeClaudeProjectPath(worktreePath);
      const projDir = path.join(tempHome, '.claude', 'projects', encoded);
      fs.mkdirSync(projDir, { recursive: true });

      const file = path.join(projDir, 'sess-mb-limit.jsonl');
      const initialRecords = [
        {
          type: 'user',
          uuid: 'u-mbl',
          message: { role: 'user', content: 'Generate code' },
        },
        {
          type: 'assistant',
          uuid: 'a-mbl',
          message: {
            role: 'assistant',
            stop_reason: null,
            content: [
              { type: 'text', text: 'Block one commentary' },
              { type: 'tool_use', name: 'write_file', input: { path: 'a.ts' } },
              { type: 'text', text: 'Block three final summary' },
            ],
          },
        },
      ];
      fs.writeFileSync(file, initialRecords.map((r) => JSON.stringify(r)).join('\n') + '\n');

      const context = {
        sessionId: 'sess-mb-limit',
        harness: 'claude',
        worktreePath,
        isLocal: true,
        agentSessionId: 'sess-mb-limit',
        homeDir: tempHome,
      };

      // Page 1 gets all 4 items (user + 3 assistant blocks)
      const firstRead = await reader.readHistory(context, { limit: 10 });
      expect(firstRead?.items).toHaveLength(4);
      expect(firstRead?.cursor).toContain(':pending:');

      // Append turn duration
      fs.appendFileSync(
        file,
        JSON.stringify({
          type: 'system',
          subtype: 'turn_duration',
          duration_ms: 1200,
        }) + '\n'
      );

      // Next query requests limit 1: must return only 1 item (the final item with turnBoundary: end)
      const secondRead = await reader.readHistory(context, { limit: 1, cursor: firstRead?.cursor });
      expect(secondRead).not.toBeNull();
      expect(secondRead?.items).toHaveLength(1);
      expect(secondRead?.items[0].text).toBe('Block three final summary');
      expect(secondRead?.items[0].turnBoundary).toBe('end');
    });

    it('does not treat system api_error as turn completion', async () => {
      const worktreePath = '/data/api-error';
      const encoded = encodeClaudeProjectPath(worktreePath);
      const projDir = path.join(tempHome, '.claude', 'projects', encoded);
      fs.mkdirSync(projDir, { recursive: true });

      const file = path.join(projDir, 'sess-api-err.jsonl');
      const records = [
        {
          type: 'user',
          uuid: 'u-err',
          message: { role: 'user', content: 'Do task' },
        },
        {
          type: 'assistant',
          uuid: 'a-err-1',
          message: { role: 'assistant', stop_reason: null, content: 'Starting...' },
        },
        {
          type: 'system',
          subtype: 'api_error',
          error: 'Rate limit exceeded, retrying',
        },
        {
          type: 'assistant',
          uuid: 'a-err-2',
          message: { role: 'assistant', stop_reason: 'end_turn', content: 'Finished after retry.' },
        },
      ];
      fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

      const result = await reader.readHistory({
        sessionId: 'sess-api-err',
        harness: 'claude',
        worktreePath,
        isLocal: true,
        agentSessionId: 'sess-api-err',
        homeDir: tempHome,
      });

      expect(result).not.toBeNull();
      expect(result?.items).toHaveLength(3); // user, assistant 1, assistant 2
      expect(result?.items[0].turnBoundary).toBe('start');
      // assistant 1 must NOT have turnBoundary: 'end' because api_error did not close the turn
      expect(result?.items[1].turnBoundary).toBeUndefined();
      // assistant 2 must have turnBoundary: 'end'
      expect(result?.items[2].turnBoundary).toBe('end');
      expect(result?.items[2].text).toBe('Finished after retry.');
    });

    it('skips user records with isMeta: true without creating user items or starting turns', async () => {
      const worktreePath = '/workspace/myproject';
      const sanitized = encodeClaudeProjectPath(worktreePath);
      const projectDir = path.join(tempHome, '.claude', 'projects', sanitized);
      fs.mkdirSync(projectDir, { recursive: true });
      const file = path.join(projectDir, 'sess-meta.jsonl');

      const records = [
        {
          type: 'user',
          uuid: 'u-1',
          message: { role: 'user', content: 'First actual prompt' },
        },
        {
          type: 'assistant',
          uuid: 'a-1',
          message: { role: 'assistant', stop_reason: 'end_turn', content: 'First reply' },
        },
        {
          type: 'user',
          uuid: 'u-meta-1',
          isMeta: true,
          message: { role: 'user', content: 'System injected caveat or hook reminder' },
        },
        {
          type: 'user',
          uuid: 'u-meta-2',
          message: { role: 'user', content: 'Another injected caveat', isMeta: true },
        },
        {
          type: 'user',
          uuid: 'u-2',
          message: { role: 'user', content: 'Second actual prompt' },
        },
        {
          type: 'assistant',
          uuid: 'a-2',
          message: { role: 'assistant', stop_reason: 'end_turn', content: 'Second reply' },
        },
      ];
      fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

      const result = await reader.readHistory({
        sessionId: 'sess-meta',
        harness: 'claude',
        worktreePath,
        isLocal: true,
        agentSessionId: 'sess-meta',
        homeDir: tempHome,
      });

      expect(result).not.toBeNull();
      // Only u-1, a-1, u-2, a-2 should be items; the two isMeta records must be skipped completely
      expect(result?.items).toHaveLength(4);
      expect(result?.items.map((i) => i.text)).toEqual([
        'First actual prompt',
        'First reply',
        'Second actual prompt',
        'Second reply',
      ]);
      expect(result?.items[0]).toMatchObject({ role: 'user', turnBoundary: 'start', turnId: 'u-1' });
      expect(result?.items[1]).toMatchObject({ role: 'agent', turnBoundary: 'end', turnId: 'u-1' });
      expect(result?.items[2]).toMatchObject({ role: 'user', turnBoundary: 'start', turnId: 'u-2' });
      expect(result?.items[3]).toMatchObject({ role: 'agent', turnBoundary: 'end', turnId: 'u-2' });
    });
  });
});
