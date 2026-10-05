import { describe, it, expect } from 'vitest';
import { CodexStatusAdapter } from '../src/adapters/codex-adapter.js';
import type { SessionSignals } from '@spawnea/domain';

describe('CodexStatusAdapter', () => {
  const adapter = new CodexStatusAdapter();

  it('falls back to terminal prompt heuristics for WAITING_INPUT when interactive prompt is displayed', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-abc',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      tailLines: [
        'I am about to delete old files.',
        'Do you want to proceed? [y/N]',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('needs_input');
    expect(res.confidence).toBeGreaterThanOrEqual(0.85);
    expect(res.source).toBe('terminal_prompt');
  });

  it('detects NEEDS_INPUT for the Codex Plan mode questionnaire UI', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-abc',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      tailLines: [
        'Question 2/2 (1 unanswered)',
        'Should ignored-only files count as local changes for showing the stash option?',
        '› 1. No, match Git view (Recommended)  Only tracked or untracked changes trigger the choices.',
        '  2. Yes, include ignored  Ignored files also trigger the stash choice.',
        '  3. None of the above  Optionally, add details in notes (Tab).',
        'tab to add notes | enter to submit all | ←/→ to navigate questions | esc to interrupt',
      ],
    };

    const res = adapter.evaluateStatus(signals);

    expect(res.status).toBe('needs_input');
    expect(res.confidence).toBe(0.98);
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toContain('Question 2/2');
  });

  it('detects IDLE when ready prompt is rendered in terminal tail without recent events', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-abc',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      tailLines: [
        '› Ask Codex to do anything',
        'gpt-5.6-luna medium · weekly 100% left',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.source).toBe('terminal_prompt');
  });

  it('detects WORKING in multilingual terminal output when the active status appears above the prompt bar', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-abc',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      tailLines: [
        '› entiendo. ellos tampoco tienen domain, asi que tailscale puede ser suficiente',
        '',
        '• Perfecto: entonces no voy a crear Cloudflare Tunnel, DNS ni Access. La arquitectura queda:',
        '  usuario autorizado → Tailscale → Caddy :80 → app productiva :8000',
        '',
        '• Explored',
        '  └ Read deploy.sh, decision_log.md, compose.sh, env.example, README.md',
        '',
        '• Working (1m 02s • esc to interrupt)',
        '',
        '› Ask Codex to do anything',
        '  gpt-5.6-sol medium · weekly 93% left · 258K window · 176K used · Fast off · Context 45% left',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('working');
    expect(res.confidence).toBe(0.98);
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toContain('Working');
  });

  it('detects WORKING for Codex approval review status with the interrupt footer', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-abc',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      tailLines: [
        '• Reviewing approval request (11s • esc to interrupt)',
        '',
        '› Ask Codex to do anything',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('working');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toContain('Reviewing approval request');
  });

  it('detects WORKING from active terminal tail even when previous turn emitted agent-turn-complete hook event', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-abc',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      tailLines: [
        '• Explored',
        '  └ Read deploy.sh, README.md',
        '',
        '• Working (45s • esc to interrupt)',
        '',
        '› Ask Codex to do anything',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('working');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toContain('Working');
  });

  it('detects IDLE after multilingual terminal output when no active Working line exists', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-abc',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      tailLines: [
        '• Perfecto: entonces no voy a crear Cloudflare Tunnel, DNS ni Access.',
        '• Explored',
        '  └ Read deploy.sh, README.md',
        '• Updated Caddyfile to route to port 8000',
        '',
        '› Ask Codex to do anything',
        '  gpt-5.6-sol medium · weekly 93% left · 258K window · 176K used',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.source).toBe('terminal_prompt');
  });

  it('detects IDLE when a stale Working line remains above the ready prompt', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-abc',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      tailLines: [
        '• Working (1m 02s)',
        '• Finished the requested changes.',
        '',
        '› Ask Codex to do anything',
        '  gpt-5.6-luna medium · weekly 77% left · 258K window · 1.04M used',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toContain('Ask Codex to do anything');
  });

  it('does not treat a transcript mention of esc to interrupt as active work', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-abc',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      tailLines: [
        'The previous status was Working and showed esc to interrupt.',
        '',
        '› Ask Codex to do anything',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.detectedPrompt).toContain('Ask Codex to do anything');
  });

  it('detects IDLE from Codex turn completion marker before the ready prompt', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-abc',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      tailLines: [
        '• Reviewing approval request (11s • esc to interrupt)',
        '',
        '─ Worked for 2m 49s ─────────────────────────────',
        '',
        '› Ask Codex to do anything',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toContain('Ask Codex to do anything');
  });

  it('detects DISCONNECTED when host is unreachable', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-abc',
      hostReachable: false,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: false,
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('disconnected');
    expect(res.confidence).toBe(1.0);
  });

  it('reports IDLE for background session when unselected in UI (isPtyAttached: false) with live tmux session', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-abc',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: false,
      paneCurrentCommand: 'codex',
      tailLines: ['Unstructured history output from previous build...'],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.status).not.toBe('disconnected');
    expect(res.source).toBe('tmux');
  });

  it('prevents status flapping between IDLE and DISCONNECTED when switching tabs (isPtyAttached true -> false -> true)', () => {
    const baseSignals: SessionSignals = {
      sessionId: 'sess-abc',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      tailLines: [
        '─ Worked for 1m 05s ─────────────────────────────',
        '❯ Ask anything, or type / for commands',
      ],
    };

    // Tab selected (active)
    const activeRes = adapter.evaluateStatus(baseSignals);
    expect(activeRes.status).toBe('idle');

    // Tab unselected (background polling, isPtyAttached: false)
    const backgroundRes1 = adapter.evaluateStatus({
      ...baseSignals,
      isPtyAttached: false,
    });
    expect(backgroundRes1.status).toBe('idle');
    expect(backgroundRes1.status).not.toBe('disconnected');

    // 10s supervisor poll in background with quiet unstructured output
    const backgroundRes2 = adapter.evaluateStatus({
      ...baseSignals,
      isPtyAttached: false,
      tailLines: ['Some quiet log output without recognized prompt'],
    });
    expect(backgroundRes2.status).toBe('idle');
    expect(backgroundRes2.status).not.toBe('disconnected');

    // Tab reselected (PTY re-attached)
    const reconnectedRes = adapter.evaluateStatus({
      ...baseSignals,
      isPtyAttached: true,
    });
    expect(reconnectedRes.status).toBe('idle');
  });

  it('detects WORKING for modern Codex CLI (v0.160+) with Braille spinner', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-abc',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: false,
      paneCurrentCommand: 'codex',
      tailLines: [
        'Inspecting source files...',
        '⠋ Thinking... (12s)',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('working');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toContain('Thinking');
  });

  it('detects WORKING for modern Codex CLI (v0.160+) active reasoning blocks', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-abc',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      tailLines: [
        '┌ Reasoning ───────────────────────────────',
        '• Searching codebase for prompt patterns (4s)',
        '• Analyzing token consumption and output buffer',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('working');
    expect(res.source).toBe('terminal_prompt');
  });

  it('detects NEEDS_INPUT for modern Codex tool approval (Allow / Deny)', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-abc',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: false,
      paneCurrentCommand: 'codex',
      tailLines: [
        'Approval required: Codex wants to execute the following command:',
        '  git push origin main',
        '',
        '❯ 1. Allow once',
        '  2. Always allow for this session',
        '  3. Deny',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('needs_input');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toMatch(/Allow|Approval/i);
  });

  it('detects NEEDS_INPUT for modern Codex interactive questionnaires with ❯ arrow selector', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-abc',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      tailLines: [
        'Select an integration strategy:',
        '❯ 1. Clean worktree branch (Recommended)',
        '  2. Rebase onto current HEAD',
        '  3. Abort integration',
        '↑/↓ to navigate · Enter to select',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('needs_input');
    expect(res.source).toBe('terminal_prompt');
  });

  it('detects NEEDS_INPUT for modern Codex plan confirmation', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-abc',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: false,
      paneCurrentCommand: 'codex',
      tailLines: [
        'Please review the proposed plan above.',
        'Do you want to proceed with this plan?',
        '❯ Approve plan',
        '  Reject plan',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('needs_input');
    expect(res.source).toBe('terminal_prompt');
  });

  it('detects IDLE for modern Codex CLI (v0.160+) idle input bar', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-abc',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: false,
      paneCurrentCommand: 'codex',
      tailLines: [
        '─ Worked for 45s ─────────────────────────────',
        '',
        '❯ Ask anything, or type / for commands',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.source).toBe('terminal_prompt');
  });
});
