import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger, SessionSignals } from '@spawnea/domain';
import { initializeStateRules } from './state-rules.js';

const FRESH_CLAUDE_TAIL = [
  ' ▐▛███▛█   Claude Code',
  '────────────────────────────────────────',
  '❯ Try "fix lint errors"',
  '────────────────────────────────────────',
  '  ⏵⏵ auto mode on (shift+tab to cycle)',
];

function signals(tailLines: string[]): SessionSignals {
  return {
    sessionId: 'session-1',
    hostReachable: true,
    tmuxSessionExists: true,
    paneExists: true,
    paneDead: false,
    paneCurrentCommand: 'claude',
    isPtyAttached: false,
    tailLines,
  };
}

function createLogger(): Logger & { error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger as unknown as Logger & { error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
}

const USER_RULE_REVIEW = `
harnesses:
  claude:
    rules:
      - state: needs_input
        patterns: ['Try "fix lint errors"']
`;

describe('initializeStateRules', () => {
  let userDataDir: string;

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'spawnea-state-rules-'));
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it('uses the factory rules when the user file does not exist', () => {
    const logger = createLogger();
    const runtime = initializeStateRules(userDataDir, logger);

    expect(runtime.status).toEqual({ source: 'factory', userFilePath: join(userDataDir, 'state-rules.yaml') });
    const result = runtime.detector.detectStatus(signals(FRESH_CLAUDE_TAIL), 'claude');
    expect(result.status).toBe('idle');
    expect(result.matchedRule?.file).toBe('factory');
  });

  it('evaluates user rules before factory rules for the same harness', () => {
    writeFileSync(join(userDataDir, 'state-rules.yaml'), USER_RULE_REVIEW);
    const runtime = initializeStateRules(userDataDir, createLogger());

    expect(runtime.status.source).toBe('merged');
    const result = runtime.detector.detectStatus(signals(FRESH_CLAUDE_TAIL), 'claude');
    expect(result.status).toBe('needs_input');
    expect(result.matchedRule).toEqual({ file: 'user', harness: 'claude', position: 1 });
  });

  it('does not change detection when the file is edited while running, only after a restart', () => {
    const filePath = join(userDataDir, 'state-rules.yaml');
    writeFileSync(filePath, USER_RULE_REVIEW);
    const readFile = vi.fn((path: string) => readFileSync(path, 'utf8'));
    const running = initializeStateRules(userDataDir, createLogger(), readFile);
    expect(running.detector.detectStatus(signals(FRESH_CLAUDE_TAIL), 'claude').status).toBe('needs_input');

    // Edit the file while Spawnea is running: remove the user rule.
    writeFileSync(filePath, 'harnesses:\n  claude:\n    rules:\n      - state: error\n        patterns: [\'never matches this\']\n');
    for (let i = 0; i < 3; i++) {
      expect(running.detector.detectStatus(signals(FRESH_CLAUDE_TAIL), 'claude').status).toBe('needs_input');
    }
    expect(readFile).toHaveBeenCalledTimes(1);

    // A restart loads the edited file.
    const restarted = initializeStateRules(userDataDir, createLogger());
    expect(restarted.detector.detectStatus(signals(FRESH_CLAUDE_TAIL), 'claude').status).toBe('idle');
  });

  it('ignores an invalid user file completely, reports its location, and logs it', () => {
    writeFileSync(join(userDataDir, 'state-rules.yaml'), `
harnesses:
  claude:
    rules:
      - state: needs_input
        patterns: ['Try "fix lint errors"']
      - state: busy
        patterns: ['anything']
`);
    const logger = createLogger();
    const runtime = initializeStateRules(userDataDir, logger);

    expect(runtime.status.source).toBe('user_invalid');
    expect(runtime.status.error).toMatchObject({ file: 'state-rules.yaml', harness: 'claude', position: 2, line: 7 });
    // The valid first rule is not applied either: the whole file is ignored.
    const result = runtime.detector.detectStatus(signals(FRESH_CLAUDE_TAIL), 'claude');
    expect(result.status).toBe('idle');
    expect(result.matchedRule?.file).toBe('factory');
    expect(logger.error).toHaveBeenCalledWith(
      'Ignoring invalid user state rules; using factory rules',
      expect.objectContaining({ harness: 'claude', position: 2 })
    );
  });
});
