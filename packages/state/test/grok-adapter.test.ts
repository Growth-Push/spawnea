import { describe, it, expect } from 'vitest';
import { GrokStatusAdapter } from '../src/adapters/grok-adapter.js';
import { StateDetector } from '../src/state-detector.js';
import type { SessionSignals } from '@spawnea/domain';

function readyComposer(extraBefore: string[] = []): string[] {
  const scrollbar = `${' '.repeat(40)}█`;
  return [
    ...extraBefore,
    ...Array.from({ length: 20 }, () => scrollbar),
    `  ╭${'─'.repeat(24)}╮`,
    `  │ ❯${' '.repeat(40)}│`,
    `  ╰${'─'.repeat(4)} Grok 4.7 (xhigh) · always-approve ─╯`,
    '  Shift+Tab:mode  │  Ctrl+.:shortcuts',
  ];
}

describe('GrokStatusAdapter', () => {
  const adapter = new GrokStatusAdapter();

  function signals(tailLines: string[], overrides: Partial<SessionSignals> = {}): SessionSignals {
    return {
      sessionId: 'grok-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'grok',
      lastOutputAt: new Date(),
      recentOutputBytes: 95362,
      tailLines,
      ...overrides,
    };
  }

  it('detects needs_input from a Grok question card under the scrollbar', () => {
    const block = `${' '.repeat(80)}█`;
    const res = adapter.evaluateStatus(
      signals([
        '     ❯ ask a question so the badge can be checked',
        '     ◆ Thought for 15.2s',
        '     ◆ Ask Which status does Spawnea show for this session?',
        block,
        block,
        '   ◆ Waiting on answers for Which status does Spawnea show for this session?  20s [stop]',
        '  ┃',
        '  ┃  Which status does Spawnea show for this session?',
        '  ┃',
        '  ┃  1 (○) Needs attention (Recommended)  The badge says needs input. █',
        '  ┃  2 (○) Working  The badge still says working. █',
        '  ┃  3 (○) Idle  The badge says the turn is finished. █',
        '  ┃  z (○) Type your answer here',
        '  ┃  ↑/↓ navigate · y copy                                                                 Enter:submit',
        '  ┃',
        '  Tab:next answer  │  Esc:scrollback  │  Shift+x:dismiss',
      ], { recentOutputBytes: 71332 })
    );
    expect(res.status).toBe('needs_input');
    expect(res.source).toBe('terminal_prompt');
    expect(res.reason).toContain('waiting for an answer');
  });

  it('lets a custom confirmation rule supply the question card result', () => {
    const res = adapter.evaluateStatus(
      signals([
        '   ◆ Waiting on answers for Which status does Spawnea show?',
        '  ┃  1 (○) Needs attention',
        '  Tab:next answer  │  Esc:scrollback  │  Shift+x:dismiss',
      ]),
      {
        customRules: [{
          id: 'custom-confirm-card',
          name: 'Custom confirmation card',
          category: 'confirmation',
          pattern: /Tab:next answer/,
          confidence: 0.42,
        }],
      }
    );
    expect(res.status).toBe('needs_input');
    expect(res.confidence).toBe(0.42);
    expect(res.detectedPrompt).toContain('Tab:next answer');
    expect(res.reason).toContain('Terminal prompt requires user input');
  });

  it('lets a custom error rule override the ready composer', () => {
    const res = adapter.evaluateStatus(signals(readyComposer(['     Worked for 7.8s'])), {
      customRules: [{
        id: 'custom-composer-error',
        name: 'Custom composer error',
        category: 'error',
        pattern: /Grok\s+\d+(?:\.\d+)?/,
        confidence: 0.77,
      }],
    });
    expect(res.status).toBe('error');
    expect(res.confidence).toBe(0.77);
    expect(res.detectedPrompt).toContain('Grok 4.7');
    expect(res.reason).toContain('Execution error detected');
  });

  it('lets a grok-scoped global rule override the ready composer', () => {
    const res = adapter.evaluateStatus(signals(readyComposer(['     Worked for 7.8s'])), {
      customRules: [{
        id: 'grok-scoped-error',
        name: 'Grok scoped error',
        category: 'error',
        harness: 'Grok',
        pattern: /Grok\s+\d+(?:\.\d+)?/g,
        confidence: 0.33,
      }],
    });
    expect(res.status).toBe('error');
    expect(res.confidence).toBe(0.33);
    expect(res.detectedPrompt).toContain('Grok 4.7');
    expect(res.reason).toContain('Execution error detected');
  });

  it('ignores custom rules that target another harness', () => {
    const res = adapter.evaluateStatus(signals(readyComposer(['     Worked for 7.8s'])), {
      customRules: [{
        id: 'hermes-only-error',
        name: 'Hermes only error',
        category: 'error',
        harness: 'hermes',
        pattern: /Grok\s+\d/,
        confidence: 0.99,
      }],
    });
    expect(res.status).toBe('idle');
  });

  it('detects needs_input while a question card is waiting, even if the TUI is repainting', () => {
    const scrollbar = `${' '.repeat(40)}█`;
    const res = adapter.evaluateStatus(
      signals([
        '     ❯ ask a question so we can see the badge',
        '     ◆ Thought for 15.2s',
        '     ◆ Ask Which status does Spawnea show?',
        ...Array.from({ length: 8 }, () => scrollbar),
        '   ◆ Waiting on answers for Which status does Spawnea show?  20s ⇣162k [stop]',
        '  ┃',
        '  ┃  Which status does Spawnea show?',
        '  ┃  1 (○) Needs attention (Recommended)  The badge says needs input.',
        '  ┃  2 (○) Working',
        '  ┃  3 (○) Idle',
        '  ┃  z (○) Type your answer here',
        '  ┃  ↑/↓ navigate · y copy                                                                                                                                      Enter:submit',
        '  Tab:next answer  │  Esc:scrollback  │  Shift+x:dismiss',
      ])
    );
    expect(res.status).toBe('needs_input');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toContain('Waiting on answers');
    expect(res.reason).toContain('waiting for an answer');
  });

  it('returns to idle after a question card is replaced by the finished composer', () => {
    const res = adapter.evaluateStatus(
      signals(
        readyComposer([
          '   ◆ Waiting on answers for Which status does Spawnea show?',
          '  Tab:next answer  │  Esc:scrollback  │  Shift+x:dismiss',
          '     Worked for 4.2s',
        ])
      )
    );
    expect(res.status).toBe('idle');
    expect(res.source).toBe('terminal_prompt');
  });

  it('detects idle when a finished turn still repaints the ready composer', () => {
    const res = adapter.evaluateStatus(signals(readyComposer(['     Worked for 7.8s'])));
    expect(res.status).toBe('idle');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toBe('Worked for 7.8s');
    expect(res.reason).toContain('Grok turn finished');
  });

  it('keeps working when a new tool line follows the completion marker', () => {
    const res = adapter.evaluateStatus(
      signals(readyComposer(['     Worked for 7.8s', '     ◆ Run pnpm test']))
    );
    expect(res.status).toBe('working');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toContain('◆ Run pnpm test');
  });

  it('ignores tool lines that belong to the finished turn', () => {
    const res = adapter.evaluateStatus(
      signals(readyComposer(['     ◆ Run git status', '     Worked for 7.8s']))
    );
    expect(res.status).toBe('idle');
    expect(res.source).toBe('terminal_prompt');
  });

  it('detects idle for a ready composer before the first turn', () => {
    const res = adapter.evaluateStatus(signals(readyComposer()));
    expect(res.status).toBe('idle');
    expect(res.source).toBe('terminal_prompt');
    expect(res.reason).toContain('ready composer');
  });

  it('keeps recent PTY output as working when the ready composer is not on screen', () => {
    const res = adapter.evaluateStatus(
      signals(['Reading packages/state/src/adapters/grok-adapter.ts', '◆ Run vitest'], {
        lastOutputAt: new Date(),
        recentOutputBytes: 4000,
      })
    );
    expect(res.status).toBe('working');
    expect(res.source).toBe('pty_activity');
  });

  it('resolves the grok harness through the state detector', () => {
    const detector = new StateDetector();
    const res = detector.detectStatus(signals(readyComposer(['     Worked for 7.8s'])), 'grok');
    expect(res.status).toBe('idle');
    expect(res.source).toBe('terminal_prompt');
  });
});
