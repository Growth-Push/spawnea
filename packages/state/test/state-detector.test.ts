import { describe, it, expect } from 'vitest';
import { StateDetector } from '../src/state-detector.js';
import type { SessionSignals } from '@spawnea/domain';

describe('StateDetector', () => {
  const detector = new StateDetector({ activeOutputWindowMs: 3000 });

  it('detects disconnected when host is unreachable', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-1',
      hostReachable: false,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: false,
    };
    const res = detector.detectStatus(signals);
    expect(res.status).toBe('disconnected');
    expect(res.confidence).toBe(1.0);
    expect(res.source).toBe('tmux');
  });

  it('detects done when tmux session has ended on reachable host', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-1',
      hostReachable: true,
      tmuxSessionExists: false,
      paneExists: false,
      paneDead: false,
      isPtyAttached: false,
    };
    const res = detector.detectStatus(signals);
    expect(res.status).toBe('done');
    expect(res.confidence).toBe(1.0);
    expect(res.source).toBe('tmux');
  });

  it('detects done on exit code 0', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: true,
      isPtyAttached: true,
      exitCode: 0,
    };
    const res = detector.detectStatus(signals);
    expect(res.status).toBe('done');
    expect(res.confidence).toBe(1.0);
    expect(res.source).toBe('process_exit');
  });

  it('detects error on non-zero exit code or dead pane', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: true,
      isPtyAttached: true,
      exitCode: 127,
    };
    const res = detector.detectStatus(signals);
    expect(res.status).toBe('error');
    expect(res.confidence).toBe(1.0);
    expect(res.source).toBe('process_exit');
  });

  it('detects needs_input when tail buffer contains confirmation prompt', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'claude',
      tailLines: [
        'I am ready to edit packages/state/src/index.ts',
        'Do you want to proceed? [y/N]',
      ],
    };
    const res = detector.detectStatus(signals);
    expect(res.status).toBe('needs_input');
    expect(res.confidence).toBeGreaterThanOrEqual(0.85);
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toContain('Do you want to proceed? [y/N]');
  });

  it('detects needs_input for the canonical Antigravity interactive questionnaire', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'agy',
      lastOutputAt: new Date(Date.now() - 5000), // paused 5s ago
      tailLines: [
        '? Which architectural approach would you like to proceed with for the database migration refactor?',
        'Question',
        'Question 1/1: Which architectural approach would you like to proceed with for the database migration refactor?',
        '> 1. (Recommended) Approach 1: Domain-Driven Modular Schemas',
        '  2. Approach 2: Linear Expand-Contract Schema',
        '  3. Write-in...',
        '  ↑/↓ Navigate · enter Select · esc Skip',
        '  esc to cancel',
      ],
    };
    const res = detector.detectStatus(signals, 'antigravity');
    expect(res.status).toBe('needs_input');
    expect(res.source).toBe('terminal_prompt');
  });

  it('detects working for the canonical Antigravity when Braille spinner is rotating', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'agy',
      lastOutputAt: new Date(Date.now() - 4000),
      tailLines: [
        '• Thought for 2s, 401 tokens',
        '  Analyzing the Architecture',
        '• Read(/workspace/spawnea/apps/desktop/src/renderer/src/components/TerminalView.tsx) (ctrl+o to expand)',
        '⣯ Analyzing Banner Behavior...',
        '└ Tip: Use /skills to browse and manage agent skills.',
        '> []',
        'esc to cancel',
      ],
    };
    const res = detector.detectStatus(signals, 'antigravity');
    expect(res.status).toBe('working');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toContain('Analyzing Banner Behavior...');
  });

  it('detects needs_input for Codex choice question', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      lastOutputAt: new Date(Date.now() - 4000),
      tailLines: [
        'Please confirm one option:',
        '- A: Clean reproducible dependencies and artifacts only.',
        '- B: Clean those plus .references/.',
        '- C: Make no changes.',
        '> Ask Codex to do anything',
      ],
    };
    const res = detector.detectStatus(signals, 'codex');
    expect(res.status).toBe('needs_input');
    expect(res.source).toBe('terminal_prompt');
  });

  it('detects idle when Codex or Antigravity displays ready input prompt', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      lastOutputAt: new Date(Date.now() - 4000),
      recentOutputBytes: 12400, // historical output bytes must not block idle detection
      tailLines: [
        'Task completed.',
        '› Ask Codex to do anything',
        'gpt-5.6-luna medium · weekly 100% left · 258K window · 31.4K used',
      ],
    };
    const res = detector.detectStatus(signals, 'codex');
    expect(res.status).toBe('idle');
    expect(res.source).toBe('terminal_prompt');
  });

  it('detects idle when Codex returned to prompt bar even if subcommands had non-zero exit in history', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      lastOutputAt: new Date(), // even with current attached pty stream
      recentOutputBytes: 4500,
      tailLines: [
        '• Ran pnpm --filter @spawnea/non-existent test',
        '  That exits with code 1 because no project matches the filter.',
        '',
        '› Ask Codex to do anything',
        'gpt-5.6-luna medium · weekly 100% left · 258K window · 31.4K used',
        ' 1 codex  2 zsh',
      ],
    };
    const res = detector.detectStatus(signals, 'codex');
    expect(res.status).toBe('idle');
    expect(res.source).toBe('terminal_prompt');
  });

  it('detects error when command execution fails in terminal', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      lastOutputAt: new Date(Date.now() - 4000),
      tailLines: [
        'Running pnpm test...',
        'ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL @spawnea/desktop test failed',
        'Exit status 1',
      ],
    };
    const res = detector.detectStatus(signals, 'codex');
    expect(res.status).toBe('error');
    expect(res.source).toBe('terminal_prompt');
  });

  it('detects Claude turn completion despite a live process and recent PTY output', () => {
    const res = detector.detectStatus({
      sessionId: 'sess-claude',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'claude',
      lastOutputAt: new Date(),
      recentOutputBytes: 1024,
      tailLines: [
        '● Finished the requested changes.',
        '✻ Brewed for 18s · done 11:42 AM',
        '────────────────────────',
        '❯\u00a0merge the pull request',
        '────────────────────────',
        '⏵⏵ auto mode on (shift+tab to cycle) · PR #7 · ← for agents',
      ],
    }, 'claude');
    expect(res.status).toBe('idle');
    expect(res.source).toBe('terminal_prompt');
    expect(res.matchedRule).toMatchObject({ file: 'factory', harness: 'claude' });
  });

  it('detects a new Claude turn from an interrupt footer before its spinner appears', () => {
    const res = detector.detectStatus({
      sessionId: 'sess-claude',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'claude',
      lastOutputAt: new Date(),
      tailLines: [
        '✻ Brewed for 27s · done 12:16 PM',
        '❯ Start another task',
        '❯',
        '⏵⏵ auto mode on · esc to interrupt',
      ],
    }, 'claude');
    expect(res.status).toBe('working');
    expect(res.source).toBe('terminal_prompt');
  });

  describe('Claude turns with background shells and a status line', () => {
    const inputBox = (draft = '') => [
      '────────────────────────',
      `❯ ${draft}`,
      '────────────────────────',
      '   user  …/projects/example  main  model-name  ctx 12%',
      '  ⏵⏵ auto mode on · 1 shell · ← for agents',
    ];
    const detect = (tailLines: string[]) => detector.detectStatus({
      sessionId: 'sess-claude',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: false,
      paneCurrentCommand: 'claude',
      tailLines,
    }, 'claude');
    const resumedAfterBackgroundResult = [
      '● The full suite is running in the background.',
      '✻ Baked for 3m 49s · done 11:07 AM · 1 shell still running',
      '● Background command "pnpm test" completed (exit code 0)',
      '  Running node scripts/check.mjs… · 41s',
    ];

    it.each(['·', '✢', '*', '✳', '✶', '✻', '✽'])('detects working on the %s spinner frame after a background result', (glyph) => {
      const res = detect([
        ...resumedAfterBackgroundResult,
        `${glyph} Hyperspacing… (53s · ↓ 1.3k tokens)`,
        '  ⎿  Tip: Use /btw to ask a quick side question',
        ...inputBox(),
      ]);
      expect(res.status).toBe('working');
      expect(res.source).toBe('terminal_prompt');
      expect(res.detectedPrompt).toContain('Hyperspacing');
    });

    it('detects idle when the turn ends with a background shell, an unsent draft, and a status line', () => {
      const res = detect([
        '● Report updated.',
        '✻ Crunched for 8s · done 11:35 AM · 1 shell still running',
        ...inputBox('make check'),
      ]);
      expect(res.status).toBe('idle');
      expect(res.source).toBe('terminal_prompt');
      expect(res.detectedPrompt).toContain('done 11:35 AM');
    });

    it('does not keep completion evidence after a newer background result', () => {
      const res = detect([
        '✻ Crunched for 8s · done 11:35 AM · 1 shell still running',
        '● Background command "pnpm test" completed (exit code 0)',
        '· Hyperspacing… (2s)',
        ...inputBox(),
      ]);
      expect(res.status).toBe('working');
    });

    it('detects working from an interrupt footer below the status line', () => {
      const res = detect([
        '✻ Crunched for 8s · done 11:35 AM',
        ...inputBox().slice(0, 4),
        '  ⏵⏵ auto mode on · esc to interrupt',
      ]);
      expect(res.status).toBe('working');
    });
  });

  it('detects working when active PTY output was received recently', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'claude',
      lastOutputAt: new Date(Date.now() - 500), // 500ms ago
      recentOutputBytes: 1024,
      tailLines: ['Compiling TypeScript source files...'],
    };
    const res = detector.detectStatus(signals);
    expect(res.status).toBe('working');
    expect(res.confidence).toBe(0.75);
    expect(res.source).toBe('pty_activity');
  });

  it('detects working when tail contains active progress verbs like generating, reading file, working', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      lastOutputAt: new Date(Date.now() - 4000), // even if paused
      tailLines: [
        'Inspecting project structure...',
        'Reading file packages/state/src/state-detector.ts',
        'Generating implementation plan...',
      ],
    };
    const res = detector.detectStatus(signals, 'codex');
    expect(res.status).toBe('working');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toContain('Generating implementation plan...');
  });

  it('detects idle when shell prompt returned and no active work is running', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'bash',
      tailLines: ['developer@server:~/repo$ '],
    };
    const res = detector.detectStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.source).toBe('terminal_prompt');
    expect(res.matchedRule).toMatchObject({ file: 'factory', harness: 'generic' });
  });

  it('reports idle for background sessions (isPtyAttached: false) with live tmux session and healthy process', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-1',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: false,
      paneCurrentCommand: 'bash',
      tailLines: [],
    };
    const res = detector.detectStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.status).not.toBe('disconnected');
  });
});
