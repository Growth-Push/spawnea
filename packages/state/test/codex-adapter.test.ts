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
});
