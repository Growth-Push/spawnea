import { describe, it, expect } from 'vitest';
import { detectAgentSessionId } from '../src/agent-session-detector.js';

describe('detectAgentSessionId', () => {
  it('returns undefined for empty or non-matching lines', () => {
    expect(detectAgentSessionId([])).toBeUndefined();
    expect(detectAgentSessionId(['Starting agent...', 'Working on prompt...'])).toBeUndefined();
  });

  it('detects codex resume identifier from banner or prompt output', () => {
    const tail = [
      'Welcome to Codex CLI',
      'To resume this session later, run: codex resume 0192-abcde-9876',
      'What would you like to build?',
    ];
    expect(detectAgentSessionId(tail)).toBe('0192-abcde-9876');
  });

  it('detects generic Session ID key-value header', () => {
    const tail = [
      'Welcome to Agent Terminal',
      'Session ID: claude-sess-998811',
      'Type /help for help.',
    ];
    expect(detectAgentSessionId(tail)).toBe('claude-sess-998811');
  });

  it('detects claude resume identifier with claude harness', () => {
    const tail1 = [
      'Welcome to Claude Code',
      'claude resume claude-sess-998811',
      'Type /help for help.',
    ];
    expect(detectAgentSessionId(tail1, { harness: 'claude' })).toBe('claude-sess-998811');

    const tail2 = [
      'Welcome to Claude Code',
      'claude --resume claude-sess-998822',
      'Type /help for help.',
    ];
    expect(detectAgentSessionId(tail2, { harness: 'claude' })).toBe('claude-sess-998822');

    const tail3 = [
      'Welcome to Claude Code',
      'claude -r claude-sess-998833',
      'Type /help for help.',
    ];
    expect(detectAgentSessionId(tail3, { harness: 'claude' })).toBe('claude-sess-998833');
  });

  it('recognizes agy and antigravity as aliases', () => {
    const tail = [
      'Antigravity session started',
      'agy --resume agy-sess-445566',
    ];
    expect(detectAgentSessionId(tail, { harness: 'antigravity' })).toBe('agy-sess-445566');
    expect(detectAgentSessionId(tail, { harness: 'agy' })).toBe('agy-sess-445566');
  });

  it('detects antigravity conversation ID with ANSI escape codes', () => {
    const tail = [
      '\u001b[32mAntigravity initialized\u001b[0m',
      '\u001b[34mConversation ID: 4fb09261-5781-4221-8cc8-dbf4a291a6a4\u001b[0m',
      'Waiting for instructions...',
    ];
    expect(detectAgentSessionId(tail)).toBe('4fb09261-5781-4221-8cc8-dbf4a291a6a4');
  });

  it('detects hermes run or resume ID', () => {
    const tail = [
      'Hermes agent runner',
      'hermes resume run-2026-task-01',
    ];
    expect(detectAgentSessionId(tail)).toBe('run-2026-task-01');
  });

  it('prioritizes most recent line if multiple IDs exist', () => {
    const tail = [
      'codex resume old-id-1111',
      'Later in session:',
      'codex resume newer-id-2222',
    ];
    expect(detectAgentSessionId(tail)).toBe('newer-id-2222');
  });

  it('ignores bare session labels such as tmux session: spawnea-x', () => {
    const tail = [
      'tmux session: spawnea-hsny7',
      'host session: spawnea-sess-1234',
      'Regular terminal line',
    ];
    expect(detectAgentSessionId(tail)).toBeUndefined();
  });

  it('ignores unrelated run_id and thread_id in build or script logs', () => {
    const tail = [
      'CI step started: run_id=build123456',
      'Worker thread_id: thread-998877',
      'Compilation finished successfully.',
    ];
    expect(detectAgentSessionId(tail)).toBeUndefined();
  });

  it('restricts detection to specified harness resume pattern when harness option is provided', () => {
    const tail = [
      'Session ID: claude-sess-998811',
      'Some background task finished',
    ];
    // Known harness 'codex' should only match 'codex resume ...', ignoring other harness outputs
    expect(detectAgentSessionId(tail, { harness: 'codex' })).toBeUndefined();

    const codexTail = [
      'Session ID: claude-sess-998811',
      'To resume later: codex resume 0192-codex-res-id',
    ];
    expect(detectAgentSessionId(codexTail, { harness: 'codex' })).toBe('0192-codex-res-id');
  });

  it('normalizes absolute path and platform executable suffixes in harness option', () => {
    const tail = [
      'Welcome to Codex CLI',
      'To resume this session later, run: codex resume 0192-norm-path-999',
    ];
    expect(detectAgentSessionId(tail, { harness: '/usr/local/bin/codex' })).toBe('0192-norm-path-999');
    expect(detectAgentSessionId(tail, { harness: 'C:\\tools\\codex.exe' })).toBe('0192-norm-path-999');
    expect(detectAgentSessionId(tail, { harness: './bin/codex.sh' })).toBe('0192-norm-path-999');
  });

  it('falls back to generic session headers when harness resume banner is not present', () => {
    const tail = [
      'Custom Agent Runner',
      'Conversation ID: b6a9c1e2-3456-7890-abcd-ef0123456789',
    ];
    expect(detectAgentSessionId(tail, { harness: '/usr/bin/custom-agent' })).toBe('b6a9c1e2-3456-7890-abcd-ef0123456789');
  });

  it('strips trailing periods and colons from candidate IDs', () => {
    const tail1 = ['To resume this session later, run: codex resume 0192-punct-id.'];
    expect(detectAgentSessionId(tail1)).toBe('0192-punct-id');

    const tail2 = ['Session ID: claude-sess-punct:'];
    expect(detectAgentSessionId(tail2)).toBe('claude-sess-punct');
  });

  it('rejects candidate IDs starting with a hyphen such as CLI flags', () => {
    expect(detectAgentSessionId(['codex resume --last'])).toBeUndefined();
    expect(detectAgentSessionId(['claude resume -r'])).toBeUndefined();
  });

  it('rejects plain dictionary words without an ID-like shape', () => {
    expect(detectAgentSessionId(['I will add claude resume support'])).toBeUndefined();
    expect(detectAgentSessionId(['codex resume command'])).toBeUndefined();
  });

  it('rejects cookie-style or assignment session_id output without proper header label', () => {
    expect(detectAgentSessionId(['Set-Cookie: session_id=abc123xyz456; Path=/; HttpOnly'])).toBeUndefined();
    expect(detectAgentSessionId(['session_id=987654321'])).toBeUndefined();
    expect(detectAgentSessionId(['user-session-id: 987654321'])).toBeUndefined();
  });
});
