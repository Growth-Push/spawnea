import { describe, it, expect } from 'vitest';
import { HermesStatusAdapter } from '../src/adapters/hermes-adapter.js';
import type { SessionSignals } from '@spawnea/domain';

describe('HermesStatusAdapter', () => {
  const adapter = new HermesStatusAdapter();

  it('detects disconnected when host is unreachable', () => {
    const signals: SessionSignals = {
      sessionId: 'hermes-1',
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
      sessionId: 'hermes-1',
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
      sessionId: 'hermes-1',
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

  it('detects working when Hermes displays interrupt footer bar in terminal tail', () => {
    const signals: SessionSignals = {
      sessionId: 'hermes-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'python3',
      lastOutputAt: new Date(Date.now() - 5000), // even if quiet for a few seconds
      tailLines: [
        '⚡ gpt-5.6-sol | 53.9K/128K | [|||||||||||] 42% | 9 1 | 1h 15m | 98s',
        '> msg=interrupt · /queue · /bg · /steer · Ctrl+C cancel',
      ],
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('working');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toContain('msg=interrupt');
  });

  it('detects working when Hermes displays progress verbs (formulating, pondering, etc.)', () => {
    const signals: SessionSignals = {
      sessionId: 'hermes-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'python3',
      lastOutputAt: new Date(Date.now() - 4000),
      tailLines: [
        '┌ Reasoning ───────────────────────────────',
        '(｡•́︿•̀｡) formulating...',
        '⚡ gpt-5.6-sol | 76.3K/128K | [|||||||||] 60% | 9 1 | 1',
      ],
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('working');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toContain('formulating...');
  });

  it('detects needs_input when Hermes displays a multilingual choice selection menu', () => {
    const signals: SessionSignals = {
      sessionId: 'hermes-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'python3',
      lastOutputAt: new Date(Date.now() - 5000),
      tailLines: [
        '┌ Hermes needs your input ─────────────────────────',
        'Which strategy should we use to retire the old integration and organize the existing worktrees?',
        '❯ 1. Limpieza completa y segura: revisar la rama Task 2b...',
        '  2. Limpieza conservadora: eliminar sólo los 3 worktrees ya integrados...',
        '  3. Minimal change: remove the old integration config...',
        '  4. Do not change anything yet...',
        '  5. Other (type your answer)',
        '└──────────────────────────────────────────────────',
        '? ¿Qué estrategia querés aplicar? ( 0708 · ↓ 486 tok)',
        '↑/↓ to select, Enter to confirm (112s)',
        '⚡ gpt-5.6-sol | 54.8K/128K | [|||||||||||] 43% | 9 1 | 1h 87m | 0202s',
        '? >',
      ],
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('needs_input');
    expect(res.source).toBe('terminal_prompt');
  });

  it('detects needs_input when Hermes displays a consultation question (❓ Q3 — ...) even with turn metrics bar', () => {
    const signals: SessionSignals = {
      sessionId: 'hermes-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'python3',
      lastOutputAt: new Date(Date.now() - 5000),
      tailLines: [
        '╭─ ⚕ Hermes ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮',
        'Decisión actualizada',
        '',
        'La tabla debe vivir en algo similar a HarnessLaunchRegistry, consumido por el application service. Así UI, MCP y una futura CLI obtendrían exactamente la misma resolución.',
        '',
        '❓ Q3 — Precedencia del modelo: si el harness ya tiene un modelo dentro de sus args configurados y el MCP también envía model, ¿cuál debe prevalecer?',
        '',
        '➡️ Recomiendo que el model explícito de la solicitud reemplace el argumento de modelo configurado para esa sesión únicamente. Si no viene model, se conservan los args originales. Esto evita flags duplicados y hace que el resultado sea determinista sin modificar la configuración permanente del harness.',
        '╰───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯',
        ' ⚕ gpt-5.6-sol │ 112K/272K │ [████░░░░░░] 41% │ ◎ 79.4% │ ◷ 15.2s │ ↑ 44 t/s │ 31m │ ⏲ 36s │ ✓ 0s                                                                                                             ─ Adjust model self-identif...',
        '─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
        '❯ Ask anything, or type / for commands…',
      ],
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('needs_input');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toContain('❓ Q3 — Precedencia del modelo');
  });

  it('detects working when active progress indicators follow an older consultation question in tailLines', () => {
    const signals: SessionSignals = {
      sessionId: 'hermes-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'python3',
      lastOutputAt: new Date(Date.now() - 1000),
      tailLines: [
        '❓ Q3 — Precedencia del modelo: si el harness ya tiene un modelo...',
        'User answered: Usar la opción B.',
        'formulating...',
        '> msg=interrupt · /queue · /bg · /steer · Ctrl+C cancel',
      ],
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('working');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toContain('msg=interrupt');
  });

  it('ignores consultation questions outside the detector inspection window', () => {
    const signals: SessionSignals = {
      sessionId: 'hermes-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'python3',
      lastOutputAt: new Date(Date.now() - 5000),
      tailLines: [
        '❓ Q1 — Stale question from an older turn',
        ...Array.from({ length: 20 }, (_, index) => `Historical output ${index + 1}`),
        'Current unrelated output',
      ],
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.source).toBe('tmux');
  });

  it('detects idle when an answered question is followed by a user response and completed turn metrics', () => {
    const signals: SessionSignals = {
      sessionId: 'hermes-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'python3',
      lastOutputAt: new Date(Date.now() - 3000),
      tailLines: [
        '❓ Q3 — Precedencia del modelo: si el harness ya tiene un modelo...',
        'User answered: Usar la opción B.',
        'Done! Applied configuration changes cleanly.',
        ' ⚕ gpt-5.6-sol │ 81K/128K │ [██████░░░░] 63% │ 🗜️ 1 │ 2h │ ⏲ 30s │ ✓ 4m',
        '❯ Ask anything, or type / for commands…',
      ],
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.source).toBe('terminal_prompt');
  });

  it('detects needs_input when a second newer question appears after an older question and working output', () => {
    const signals: SessionSignals = {
      sessionId: 'hermes-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'python3',
      lastOutputAt: new Date(Date.now() - 3000),
      tailLines: [
        '❓ Q1 — Old question',
        'User answered: Proceed.',
        '> msg=interrupt · /queue · /bg · /steer · Ctrl+C cancel',
        '❓ Q2 — Newer question: which database port to bind?',
        ' ⚕ gpt-5.6-sol │ 112K/272K │ ✓ 0s',
        '❯ Ask anything, or type / for commands…',
      ],
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('needs_input');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toContain('❓ Q2 — Newer question');
  });

  it('detects error when a fatal error occurs in a subsequent turn after an older question', () => {
    const signals: SessionSignals = {
      sessionId: 'hermes-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'python3',
      lastOutputAt: new Date(Date.now() - 3000),
      tailLines: [
        '❓ Q1 — Old question',
        'custom-profile > Proceed with migrations',
        'Traceback (most recent call last):',
        '  File "main.py", line 10, in <module>',
        'Exit status 1',
      ],
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('error');
    expect(res.source).toBe('terminal_prompt');
  });

  it('detects idle when working footer remains in history but a newer turn completion checkmark followed', () => {
    const signals: SessionSignals = {
      sessionId: 'hermes-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'python3',
      lastOutputAt: new Date(Date.now() - 3000),
      tailLines: [
        '❓ Q3 — Question?',
        'User answered: option B',
        'formulating...',
        '> msg=interrupt · /queue · /bg · /steer · Ctrl+C cancel',
        'Done!',
        ' ⚕ gpt-5.6-sol │ 81K/128K │ ✓ 4m',
        '❯ Ask anything, or type / for commands…',
      ],
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.source).toBe('terminal_prompt');
  });

  it('detects working from active PTY streaming when answered question has fresh ordinary output', () => {
    const signals: SessionSignals = {
      sessionId: 'hermes-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'python3',
      lastOutputAt: new Date(Date.now() - 100),
      recentOutputBytes: 50,
      tailLines: [
        '❓ Q3 — Question?',
        'User answered: option B',
        'Reading package metadata',
      ],
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('working');
    expect(res.source).toBe('pty_activity');
  });

  it('detects working from active PTY streaming when answered question is followed by profile-prefixed user echo and fresh output', () => {
    const signals: SessionSignals = {
      sessionId: 'hermes-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'python3',
      lastOutputAt: new Date(Date.now() - 100),
      recentOutputBytes: 50,
      tailLines: [
        '❓ Q3 — Question?',
        'gp-dev > Use option B',
        'Reading package metadata',
      ],
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('working');
    expect(res.source).toBe('pty_activity');
  });

  it('detects needs_input when answered question is followed by a new question-category prompt', () => {
    const signals: SessionSignals = {
      sessionId: 'hermes-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'python3',
      lastOutputAt: new Date(Date.now() - 5000),
      tailLines: [
        '❓ Q3 — Question?',
        'gp-dev > Use option B',
        'Enter value: ',
      ],
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('needs_input');
    expect(res.source).toBe('terminal_prompt');
  });

  it('does not treat answered text with question marks as a new prompt', () => {
    const signals: SessionSignals = {
      sessionId: 'hermes-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'python3',
      lastOutputAt: new Date(),
      recentOutputBytes: 50,
      tailLines: ['❓ Q3 — Should the subprocess continue?', 'gp-dev > Yes, continue?'],
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('working');
    expect(res.source).toBe('pty_activity');
  });

  it('treats completed turn with informational emoji question heading as idle rather than consultation question', () => {
    const signals: SessionSignals = {
      sessionId: 'hermes-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'python3',
      lastOutputAt: new Date(Date.now() - 3000),
      tailLines: [
        '❓ Why did this happen?',
        'Here is the explanation for the previous behavior.',
        ' ⚕ gpt-5.6-sol │ 81K/128K │ ✓ 4m',
        '❯ Ask anything, or type / for commands…',
      ],
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.source).toBe('terminal_prompt');
  });

  it('detects idle when an answered question is followed by a user response with an arbitrary profile prefix', () => {
    const signals: SessionSignals = {
      sessionId: 'hermes-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'python3',
      lastOutputAt: new Date(Date.now() - 3000),
      tailLines: [
        '❓ Q3 — Question?',
        'arbitrary-agent-profile > Use option B',
        ' ⚕ gpt-5.6-sol │ 81K/128K │ [██████░░░░] 63% │ ✓ 4m',
        '❯ Ask anything, or type / for commands…',
      ],
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.source).toBe('terminal_prompt');
  });

  it('detects idle after multilingual output when the metrics bar contains a completion checkmark (| ✓ 4m)', () => {
    const signals: SessionSignals = {
      sessionId: 'hermes-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'python3',
      lastOutputAt: new Date(Date.now() - 2000),
      tailLines: [
        'Listo, persistido y publicado.',
        '- Commit: df04ea3 chore: remove the retired integration',
        '- Push: main → origin/main',
        'Checks previos: 269 tests pasaron, 1 skipped y 4 subtests pasaron.',
        '╰───────────────────────────────────────────────────────────────────╯',
        ' ⚕ gpt-5.6-sol │ 81K/128K │ [██████░░░░] 63% │ 🗜️ 1 │ 2h │ ⏲ 30s │ ✓ 4m',
        '─────────────────────────────────────────────────────────────────────',
        'gp-dev > Draft a reply to the last email in my inbox',
      ],
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.source).toBe('terminal_prompt');
  });

  it('detects idle when context prompt (gp-dev >) is present without working indicators', () => {
    const signals: SessionSignals = {
      sessionId: 'hermes-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'python3',
      lastOutputAt: new Date(Date.now() - 4000),
      tailLines: [
        'All work completed.',
        'gp-dev >',
      ],
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.source).toBe('terminal_prompt');
  });

  it('falls back to idle for quiet attached Hermes session even if paneCurrentCommand is python3', () => {
    const signals: SessionSignals = {
      sessionId: 'hermes-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'python3',
      lastOutputAt: new Date(Date.now() - 10000), // quiet for 10s
      tailLines: ['Some unstructured general logs...'],
    };
    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.source).toBe('tmux');
  });

});
