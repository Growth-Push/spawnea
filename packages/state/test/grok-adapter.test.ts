import { describe, it, expect } from 'vitest';
import { GrokStatusAdapter } from '../src/adapters/grok-adapter.js';
import { StateDetector } from '../src/state-detector.js';
import type { SessionSignals } from '@spawnea/domain';
import { loadStateRules } from '../src/rules/load-state-rules.js';

function userRules(yaml: string) {
  return loadStateRules({ userFilePath: '/fictional/user-data/state-rules.yaml', readFile: () => yaml }).ruleSet;
}

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
    expect(res.matchedRule).toMatchObject({ file: 'factory', harness: 'grok' });
  });

  it('lets a user rule decide the question card before the factory rules', () => {
    const rules = userRules("harnesses:\n  grok:\n    rules:\n      - state: needs_input\n        patterns: ['Tab:next answer']\n");
    const res = adapter.evaluateStatus(
      signals([
        '   ◆ Waiting on answers for Which status does Spawnea show?',
        '  ┃  1 (○) Needs attention',
        '  Tab:next answer  │  Esc:scrollback  │  Shift+x:dismiss',
      ]),
      { rules }
    );
    expect(res.status).toBe('needs_input');
    expect(res.matchedRule).toEqual({ file: 'user', harness: 'grok', position: 1 });
    expect(res.detectedPrompt).toContain('Tab:next answer');
  });

  it('lets a user rule override the ready composer', () => {
    const rules = userRules("harnesses:\n  grok:\n    rules:\n      - state: needs_input\n        patterns: ['Grok\\s+\\d+(?:\\.\\d+)?']\n");
    const res = adapter.evaluateStatus(signals(readyComposer(['     Worked for 7.8s'])), { rules });
    expect(res.status).toBe('needs_input');
    expect(res.matchedRule).toEqual({ file: 'user', harness: 'grok', position: 1 });
    expect(res.detectedPrompt).toContain('Grok 4.7');
  });

  it('resolves user harness keys case-insensitively', () => {
    const rules = userRules("harnesses:\n  Grok:\n    rules:\n      - state: needs_input\n        patterns: ['Grok\\s+\\d']\n");
    const res = adapter.evaluateStatus(signals(readyComposer(['     Worked for 7.8s'])), { rules });
    expect(res.status).toBe('needs_input');
    expect(res.matchedRule?.file).toBe('user');
  });

  it('ignores user rules that target another harness', () => {
    const rules = userRules("harnesses:\n  hermes:\n    rules:\n      - state: error\n        patterns: ['Grok\\s+\\d']\n");
    const res = adapter.evaluateStatus(signals(readyComposer(['     Worked for 7.8s'])), { rules });
    expect(res.status).toBe('idle');
    expect(res.matchedRule?.file).toBe('factory');
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
    expect(res.matchedRule).toMatchObject({ file: 'factory', harness: 'grok' });
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
    expect(res.detectedPrompt).toContain('Worked for');
  });

  it('keeps working when a new tool line follows the completion marker', () => {
    const res = adapter.evaluateStatus(
      signals(readyComposer(['     Worked for 7.8s', '     ◆ Run pnpm test']))
    );
    expect(res.status).toBe('working');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toContain('◆ Run pnpm test');
  });

  it('detects a spinner surrounded by TUI borders as working', () => {
    const res = adapter.evaluateStatus(
      signals(readyComposer(['     Worked for 7.8s', '│ ⠋ │']))
    );
    expect(res.status).toBe('working');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toContain('⠋');
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
    expect(res.matchedRule).toMatchObject({ file: 'factory', harness: 'grok' });
  });

  it('treats the live Grok welcome artwork as idle when the composer is ready', () => {
    const res = adapter.evaluateStatus(signals([
      '│  ⠀⠀⠀⠀⠀⠀⣀⣀⡀⠀⠀⠀⢀⠄   Grok Build  1.0.46  │',
      '│  ⠀⠀⣼⡟⠁⠀⠀⠀⢀⡴⠻⣿⡀⠀   Grok 4.7 is here!  │',
      '│  New worktree  ctrl+w  │',
      'Update: v1.0.50 available, press ctrl+u to restart',
      '╭────────────────────────────────────────────╮',
      '│ ❯                                          │',
      '╰──────── Grok 4.7 (xhigh) ─╯',
    ]));
    expect(res.status).toBe('idle');
    expect(res.source).toBe('terminal_prompt');
  });

  it('does not report idle when new work follows a prior completion marker', () => {
    const res = adapter.evaluateStatus(signals(readyComposer([
      'Worked for 7.8s',
      'Reading files',
    ])));
    expect(res.status).toBe('working');
    expect(res.source).toBe('terminal_prompt');
  });

  it('does not report idle when new work replaces welcome content', () => {
    const res = adapter.evaluateStatus(signals(readyComposer([
      'Grok Build 1.0.46',
      'Reading files',
    ])));
    expect(res.status).toBe('working');
  });

  it('does not treat model text mentioning a welcome action as welcome chrome', () => {
    const res = adapter.evaluateStatus(signals(readyComposer([
      '│ Grok Build 1.0.46 │',
      'Please Quit the command before editing this file.',
    ])));
    expect(res.status).toBe('working');
  });

  it('reports an active Grok entry as working when the ready composer is not on screen', () => {
    const res = adapter.evaluateStatus(
      signals(['Reading packages/state/src/adapters/grok-adapter.ts', '◆ Run vitest'], {
        lastOutputAt: new Date(),
        recentOutputBytes: 4000,
      })
    );
    expect(res.status).toBe('working');
    expect(res.source).toBe('terminal_prompt');
  });

  it('resolves the grok harness through the state detector', () => {
    const detector = new StateDetector();
    const res = detector.detectStatus(signals(readyComposer(['     Worked for 7.8s'])), 'grok');
    expect(res.status).toBe('idle');
    expect(res.source).toBe('terminal_prompt');
  });

  it('detects idle with confidence 0.96 and cleaned prompt from capture with trailing scrollbar', () => {
    const tailLines: string[] = [
      '  main ~/workspace/project                                                                                                                                           20K / 256K │ [Dashboard]',
      '     ❯ quiero probar una cosa de la app donde te estoy corriendo. me podes hacer una pregunta como si necesitaras de mi desicion?                                                    2:54 PM',
      '     ◆ Thought for 1.6s',
      '     Voy a hacerte una pregunta con opciones para que veas cómo se presenta la decisión.                                                                                             2:54 PM',
      '     ◆ Ask Para probar esta función, ¿qué querés que haga después de que elijas?',
      '     Recibí tu elección: Confirmar y seguir.                                                                                                                                         2:55 PM   █',
      '     La pregunta con opciones funcionó. La app me devolvió esa respuesta y pude continuar a partir de ella.                                                                                    █',
      '     Worked for 9.1s                                                                                                                                                                           █',
      ...Array.from({ length: 42 }, () => '                                                                                                                                                                                                                              █'),
      '  ╭─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮',
      '  │ ❯                                                                                                                                                                                                                       │',
      '  ╰───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── Grok 4.7 (xhigh) · always-approve ─╯',
      '  Shift+Tab:mode  │  Ctrl+x:shortcuts',
    ];

    const res = adapter.evaluateStatus(signals(tailLines));
    expect(res.status).toBe('idle');
    expect(res.matchedRule?.harness).toBe('grok');
    expect(res.detectedPrompt).toBe('Worked for 9.1s');
    expect(res.detectedPrompt).toBe('Worked for 9.1s');
  });

  it('detects idle when historical Ask is followed by resolved Worked for with trailing scrollbar', () => {
    const res = adapter.evaluateStatus(
      signals([
        '     ◆ Ask Para probar esta función, ¿qué querés que haga después de que elijas?',
        '     Recibí tu elección: Confirmar y seguir.                                                                                                                                                                        2:55 PM   █',
        '     Worked for 9.1s                                                                                                                                                                                                          █',
        ...readyComposer(),
      ])
    );
    expect(res.status).toBe('idle');
    expect(res.matchedRule?.harness).toBe('grok');
    expect(res.detectedPrompt).toBe('Worked for 9.1s');
    expect(res.detectedPrompt).toBe('Worked for 9.1s');
  });

  it('detects working when substantive active work follows Worked for with trailing scrollbar', () => {
    const res = adapter.evaluateStatus(
      signals([
        '     Worked for 9.1s                                                                                                                                                                                                          █',
        '     ◆ Run pnpm test',
        ...readyComposer(),
      ])
    );
    expect(res.status).toBe('working');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toContain('◆ Run pnpm test');
  });

  it('preserves needs_input when an active question card is present after a previous completed turn', () => {
    const res = adapter.evaluateStatus(
      signals([
        '     Worked for 9.1s                                                                                                                                                                                                          █',
        '   ◆ Waiting on answers for Which action to take?  15s [stop]',
        '  ┃',
        '  ┃  Which action to take?',
        '  ┃  1 (○) Approve (Recommended)',
        '  ┃  2 (○) Reject',
        '  ┃  Tab:next answer  │  Esc:scrollback',
      ])
    );
    expect(res.status).toBe('needs_input');
    expect(res.matchedRule?.harness).toBe('grok');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toContain('Waiting on answers');
    expect(res.matchedRule).toMatchObject({ file: 'factory', harness: 'grok' });
  });

  it('detects idle when Grok turn completion includes a Recap summary block', () => {
    const res = adapter.evaluateStatus(
      signals([
        '     ◆ Ask Para probar esta función, ¿qué querés que haga después de que elijas?',
        '     Recibí tu elección: Confirmar y seguir.                                                                                                                                                                        2:55 PM   █',
        '     Worked for 9.1s                                                                                                                                                                                                          █',
        '  ┃  ◆ Recap                                                                                                                                                                                                                  █',
        '  ┃                                                                                                                                                                                                                           █',
        '  ┃  Pediste comprobar que funciono y que te hiciera una pregunta de decisión: elegiste Confirmar y seguir, la app devolvió esa respuesta y continué.                                                                        █',
        ...readyComposer(),
      ])
    );
    expect(res.status).toBe('idle');
    expect(res.matchedRule?.harness).toBe('grok');
    expect(res.detectedPrompt).toBe('Worked for 9.1s');
    expect(res.detectedPrompt).toBe('Worked for 9.1s');
  });

  it('keeps working when new active work mentioning Recap follows completion', () => {
    const res = adapter.evaluateStatus(
      signals([
        '     Worked for 9.1s                                                                                                                                                                                                          █',
        '     ◆ Run rg Recap .',
        ...readyComposer(),
      ])
    );
    expect(res.status).toBe('working');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toContain('◆ Run rg Recap .');
  });
});
