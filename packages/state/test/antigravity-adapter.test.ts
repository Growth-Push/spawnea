import { describe, it, expect } from 'vitest';
import { AntigravityStatusAdapter } from '../src/adapters/antigravity-adapter.js';
import type { SessionSignals } from '@spawnea/domain';

describe('AntigravityStatusAdapter', () => {
  const adapter = new AntigravityStatusAdapter();

  it('detects disconnected when host is unreachable', () => {
    const signals: SessionSignals = {
      sessionId: 'antigravity-1',
      hostReachable: false,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('disconnected');
    expect(res.confidence).toBe(1.0);
  });

  it('detects done when tmux session no longer exists', () => {
    const signals: SessionSignals = {
      sessionId: 'antigravity-1',
      hostReachable: true,
      tmuxSessionExists: false,
      paneExists: false,
      paneDead: false,
      isPtyAttached: false,
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('done');
  });

  it('detects done on exit code 0 and error on non-zero exit', () => {
    const okSignals: SessionSignals = {
      sessionId: 'antigravity-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: true,
      exitCode: 0,
      isPtyAttached: true,
    };
    expect(adapter.evaluateStatus(okSignals).status).toBe('done');

    const errSignals: SessionSignals = {
      ...okSignals,
      exitCode: 1,
    };
    expect(adapter.evaluateStatus(errSignals).status).toBe('error');
  });

  it('detects working when Antigravity displays rotating Braille spinner (⣯ Analyzing...) and esc to cancel (screenshot case)', () => {
    const signals: SessionSignals = {
      sessionId: 'antigravity-artifact-auth-creations',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'agy',
      lastOutputAt: new Date(Date.now() - 3500),
      tailLines: [
        '• Search(Grep docs for DetectedOutputBanner)',
        '• Search(Grep docs for artifact)',
        '• Read(/workspace/spawnea/docs/architecture.md)',
        '• Read(/workspace/spawnea/apps/desktop/src/renderer/src/components/DetectedOutputBanner.tsx)',
        '• Find(Find test files in renderer)',
        '• Read(/workspace/spawnea/apps/desktop/src/renderer/src/components/DetectedOutputBanner.test.tsx) (ctrl+o to expand)',
        '',
        '• Thought for 5s, 657 tokens',
        '  Analyzing Tab Behavior',
        '',
        '• Read(/workspace/spawnea/apps/desktop/src/renderer/src/components/TerminalView.tsx) (ctrl+o to expand)',
        '⣯ Analyzing Banner Behavior...',
        '└ Tip: Use /skills to browse and manage agent skills.',
        '',
        '> []',
        'esc to cancel',
      ],
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('working');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toContain('Analyzing Banner Behavior...');
  });

  it('detects working when other Braille spinner states (⣾, ⣽, ⣻, ⢿, ⡿, ⣟, ⣷, ⠋, ⠙, ⠹, ⠸) are active', () => {
    const spinners = ['⣷', '⣯', '⣟', '⡿', '⢿', '⣻', '⣽', '⣾', '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    for (const spin of spinners) {
      const signals: SessionSignals = {
        sessionId: 'antigravity-1',
        hostReachable: true,
        tmuxSessionExists: true,
        paneExists: true,
        paneDead: false,
        isPtyAttached: true,
        paneCurrentCommand: 'agy',
        tailLines: [
          `${spin} Thinking about the architecture...`,
          '> []',
          'esc to cancel',
        ],
      };
    const res = adapter.evaluateStatus(signals);
      expect(res.status).toBe('working');
    }
  });

  it('detects needs_input when Antigravity displays interactive questionnaire menu', () => {
    const signals: SessionSignals = {
      sessionId: 'antigravity-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'agy',
      lastOutputAt: new Date(Date.now() - 4000),
      tailLines: [
        '? Which architectural approach would you like to proceed with for the refactor?',
        'Question',
        '',
        'Question 1/1: Which architectural approach would you like to proceed with?',
        '> 1. (Recommended) Approach 1: Modular Adapters',
        '  2. Approach 2: Monolithic Handler',
        '  3. Write-in...',
        '',
        '  ↑/↓ Navigate · enter Select · esc Skip',
        '  esc to cancel',
      ],
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('needs_input');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toContain('Question 1/1:');
  });

  it('detects needs_input when Antigravity displays file edit acceptance prompt (screenshot case)', () => {
    const signals: SessionSignals = {
      sessionId: 'antigravity-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'agy',
      lastOutputAt: new Date(Date.now() - 4000),
      tailLines: [
        '• Thought for 5s, 600 tokens',
        '  Adding Codex Working Rules',
        '• Edit(/workspace/spawnea/packages/state/src/rules/default-rules.ts) (ctrl+o to expand)',
        'Pending edit',
        '',
        '  shift+tab to auto-approve file edits',
        'Accept this file edit?',
        '> 1. Yes, accept this change',
        '  2. No, reject this change',
        '',
        '  ↑/↓ Navigate · tab Amend · f full diff',
        'esc to cancel',
      ],
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('needs_input');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toContain('Accept this file edit?');
  });

  it('detects needs_input when Antigravity displays tool execution permission request', () => {
    const signals: SessionSignals = {
      sessionId: 'antigravity-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'agy',
      lastOutputAt: new Date(Date.now() - 4000),
      tailLines: [
        'Requesting permission for:',
        '  git log -n 10 --oneline',
        '',
        'Do you want to proceed?',
        '> 1. Yes',
        '  2. Yes, and always allow in this conversation',
        '  3. No',
        '',
        '  ↑/↓ Navigate · tab Amend · ctrl+g edit',
        '  esc to cancel',
      ],
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('needs_input');
    expect(res.source).toBe('terminal_prompt');
  });

  it('detects idle when Antigravity finishes turn and displays prompt > without spinners or cancel footers', () => {
    const signals: SessionSignals = {
      sessionId: 'antigravity-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'agy',
      lastOutputAt: new Date(Date.now() - 3000),
      tailLines: [
        '• Read(/workspace/spawnea/packages/state/src/index.ts)',
        '• Search(Grep docs for state)',
        'All changes have been successfully committed.',
        '> ',
        '? for shortcuts',
      ],
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.source).toBe('terminal_prompt');
  });

  it('detects idle after multilingual Antigravity output when the harness is resting at its prompt', () => {
    const signals: SessionSignals = {
      sessionId: 'antigravity-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'agy',
      lastOutputAt: new Date(Date.now() - 3000),
      tailLines: [
        '  1. Reglas de detección específicas para Codex en default-rules.ts:',
        '      • codex-working-status: detecta • Working (1m 02s • esc to interrupt) y Working (...).',
        '      • codex-working-interrupt-footer: detecta el hint activo esc to interrupt.',
        '      • codex-working-bullets: detecta bullets en progreso (• Working, • Thinking, • Searching, • Running, • Executing).',
        '  2. **Reordenamiento de prioridad en prompt-detector.ts**:',
        '      • Orden: confirmation / choice / question (needs_input) -> working -> error -> idle_prompt / shell_prompt.',
        '      • Si la terminal muestra indicadores activos de trabajo, estos tienen precedencia sobre la barra fija de prompt inferior.',
        '  3. **Adaptador en tiempo real en codex-adapter.ts**:',
        '      • Prioriza la inspección de la terminal en vivo sobre eventos viejos de hooks:',
        '          1. Si solicita interacción ([y/N], menú de opciones) -> needs_input.',
        '          2. Si muestra • Working (...) o esc to interrupt -> working (confianza 0.98, fuente terminal_prompt).',
        '          3. Si la terminal no tiene trabajo activo y está en › Ask Codex to do anything -> idle.',
        '',
        '────────────────────────────────────────────────────────────',
        '> Accept-edits mode: file edits auto-approved (shift+tab to cycle)',
        '────────────────────────────────────────────────────────────',
        '? for shortcuts                                                                                                                   accept-edits · Gemini 3.7 Flash · high',
      ],
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.source).toBe('terminal_prompt');
  });

  it('falls back to idle for quiet attached Antigravity session', () => {
    const signals: SessionSignals = {
      sessionId: 'antigravity-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'agy',
      lastOutputAt: new Date(Date.now() - 10000),
      tailLines: [],
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.source).toBe('tmux');
  });

});
