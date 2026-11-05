import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeClaudeProjectPath } from '../src/history/claude-history-reader.js';
import { SessionHistoryService } from '../src/history/history-service.js';

describe('SessionHistoryService (Hybrid Model)', () => {
  let tempHome: string;
  let service: SessionHistoryService;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-svc-test-'));
    service = new SessionHistoryService();
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('reads local Claude history from transcript when file is available', async () => {
    const worktreePath = '/workspace/my-project';
    const encoded = encodeClaudeProjectPath(worktreePath);
    const projDir = path.join(tempHome, '.claude', 'projects', encoded);
    fs.mkdirSync(projDir, { recursive: true });

    const transcript = path.join(projDir, 'uuid-claude.jsonl');
    fs.writeFileSync(
      transcript,
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Hello Claude' },
      }) + '\n'
    );

    const result = await service.getHistory({
      sessionId: 'sess-claude',
      harness: 'claude',
      worktreePath,
      isLocal: true,
      agentSessionId: 'uuid-claude',
      homeDir: tempHome,
      tailLines: ['❯ Hello Claude from screen'],
    });

    expect(result.source).toBe('transcript');
    expect(result.items[0].text).toBe('Hello Claude');
  });

  it('falls back to screen when local Claude transcript is absent without throwing', async () => {
    const result = await service.getHistory({
      sessionId: 'sess-claude-fallback',
      harness: 'claude',
      worktreePath: '/absent/path',
      isLocal: true,
      agentSessionId: 'nonexistent-uuid',
      homeDir: tempHome,
      tailLines: ['❯ Screen prompt fallback', 'Screen response'],
    });

    expect(result.source).toBe('screen');
    expect(result.items[0].text).toBe('Screen prompt fallback');
    expect(result.items[0].source).toBe('screen');
  });

  it('reads local Codex history from resolved transcript file', async () => {
    const rolloutFile = path.join(tempHome, 'rollout-codex.jsonl');
    fs.writeFileSync(
      rolloutFile,
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: 'Hello Codex' },
      }) + '\n'
    );

    const result = await service.getHistory({
      sessionId: 'sess-codex',
      harness: 'codex',
      worktreePath: '/workspace',
      isLocal: true,
      resolvedTranscriptPath: rolloutFile,
      tailLines: ['› Screen fallback'],
    });

    expect(result.source).toBe('transcript');
    expect(result.items[0].text).toBe('Hello Codex');
    expect(service.getResolvedTranscriptPath('sess-codex')).toBe(rolloutFile);
  });

  it('falls back to screen when local Codex rollout is absent without error', async () => {
    const result = await service.getHistory({
      sessionId: 'sess-codex-absent',
      harness: 'codex',
      worktreePath: '/workspace',
      isLocal: true,
      tailLines: ['› Codex prompt', 'Codex response'],
    });

    expect(result.source).toBe('screen');
    expect(result.items[0].text).toBe('Codex prompt');
  });

  it('uses screen reader for remote sessions even with transcript-capable harness', async () => {
    const result = await service.getHistory({
      sessionId: 'sess-remote',
      harness: 'claude',
      worktreePath: '/remote/workspace',
      isLocal: false,
      tailLines: ['❯ Remote prompt', 'Remote agent text'],
    });

    expect(result.source).toBe('screen');
    expect(result.items[0].text).toBe('Remote prompt');
  });

  it('uses screen reader for other harnesses like hermes and shell', async () => {
    const resultHermes = await service.getHistory({
      sessionId: 'sess-hermes',
      harness: 'hermes',
      worktreePath: '/workspace',
      isLocal: true,
      tailLines: ['› Hermes query', 'Hermes response'],
    });
    expect(resultHermes.source).toBe('screen');

    const resultShell = await service.getHistory({
      sessionId: 'sess-shell',
      harness: 'shell',
      worktreePath: '/workspace',
      isLocal: true,
      tailLines: ['$ ls -la', 'total 0'],
    });
    expect(resultShell.source).toBe('screen');
  });

  it('invalidates cached path when Claude agent conversation ID changes', async () => {
    const claudeDir = path.join(tempHome, '.claude', 'projects', '-workspace');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'conv-1.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Conversation 1' } }) + '\n'
    );
    fs.writeFileSync(
      path.join(claudeDir, 'conv-2.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Conversation 2' } }) + '\n'
    );

    const context = {
      sessionId: 'sess-claude-switch',
      harness: 'claude',
      worktreePath: '/workspace',
      isLocal: true,
      homeDir: tempHome,
    };

    const res1 = await service.getHistory({ ...context, agentSessionId: 'conv-1' });
    expect(res1.items[0].text).toBe('Conversation 1');

    const res2 = await service.getHistory({ ...context, agentSessionId: 'conv-2' });
    expect(res2.items[0].text).toBe('Conversation 2');
  });

  it('validates and retains cached rollout path for Codex using rollout format', async () => {
    const codexFile = path.join(tempHome, 'rollout-2026-11-04T10-00-00-uuid999.jsonl');
    fs.writeFileSync(
      codexFile,
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'Codex cached message' } }) + '\n'
    );

    service.setResolvedTranscriptPath('sess-codex-cache', codexFile);

    const result = await service.getHistory({
      sessionId: 'sess-codex-cache',
      harness: 'codex',
      worktreePath: '/workspace',
      isLocal: true,
      agentSessionId: 'uuid999',
      tailLines: ['› Should not use screen'],
    });

    expect(result.source).toBe('transcript');
    expect(result.items[0].text).toBe('Codex cached message');
  });

  it('falls back to screen when local transcript file is corrupt or unreadable', async () => {
    const corruptFile = path.join(tempHome, 'corrupt-rollout.jsonl');
    fs.writeFileSync(corruptFile, 'corrupt data\nnot valid json\n');

    service.setResolvedTranscriptPath('sess-corrupt-fallback', corruptFile);

    const result = await service.getHistory({
      sessionId: 'sess-corrupt-fallback',
      harness: 'codex',
      worktreePath: '/workspace',
      isLocal: true,
      tailLines: ['› Screen prompt after corrupt transcript', 'Screen response'],
    });

    expect(result.source).toBe('screen');
    expect(result.items[0].text).toBe('Screen prompt after corrupt transcript');
  });
});
