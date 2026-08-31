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
    const res = adapter.evaluateStatus(signals, []);
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
    const res = adapter.evaluateStatus(signals, []);
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
    expect(adapter.evaluateStatus(okSignals, []).status).toBe('done');

    const errSignals: SessionSignals = {
      ...okSignals,
      exitCode: 1,
    };
    expect(adapter.evaluateStatus(errSignals, []).status).toBe('error');
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
    const res = adapter.evaluateStatus(signals, []);
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
    const res = adapter.evaluateStatus(signals, []);
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
    const res = adapter.evaluateStatus(signals, []);
    expect(res.status).toBe('needs_input');
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
    const res = adapter.evaluateStatus(signals, []);
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
    const res = adapter.evaluateStatus(signals, []);
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
    const res = adapter.evaluateStatus(signals, []);
    expect(res.status).toBe('idle');
    expect(res.source).toBe('tmux');
  });

  it('handles structured lifecycle events when present', () => {
    const signals: SessionSignals = {
      sessionId: 'hermes-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
    };

    const turnCompleteEvt = {
      sessionId: 'hermes-1',
      harness: 'hermes',
      eventType: 'turn_complete',
      timestamp: new Date().toISOString(),
      summary: 'Changes published to git',
    };

    const res = adapter.evaluateStatus(signals, [turnCompleteEvt]);
    expect(res.status).toBe('idle');
    expect(res.source).toBe('native_hook');
    expect(res.reason).toContain('Changes published to git');
  });
});
