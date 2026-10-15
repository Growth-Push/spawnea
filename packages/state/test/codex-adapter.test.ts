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

  it('detects NEEDS_INPUT when Codex v0.160+ has queued follow-up questions awaiting shift+← to answer', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-muvnc5uv-e0wc',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      tailLines: [
        '',
        '  >_ OpenAI Codex (v0.160.0)',
        '     /workspace/project',
        '',
        '  Greetings, fellow tinkerer.',
        '',
        '',
        '› to run a test, please ask me a question and wait for the response. In Codex you press shift-left to answer',
        '',
        '',
        '• Which color do you prefer for this test?',
        '',
        '  • Blue',
        '  • Green',
        '  • Red',
        '',
        'Working (19s • esc to interrupt)',
        '',
        '• Queued follow-up inputs',
        '  ? 1 question · 14s',
        '    shift+← to answer',
        '',
        '',
        '› Ask Codex to do anything',
        '',
        '  GPT-6.1-Sol low · weekly 60% left · 258K window · 24.6K used · Fast off · Context 95% left · 24.6K in · 44 out · 0.160.0 · agents',
        '  ← for agents · ? for shortcuts                                                                                                                                                                                                           ⚠ 1 warning · f2 to view',
        '',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('needs_input');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toMatch(/shift\+← to answer|\? 1 question|Queued follow-up/i);
  });

  it('detects NEEDS_INPUT for queued follow-up inputs with shift-left variation', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-123',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: false,
      paneCurrentCommand: 'codex',
      tailLines: [
        'Working (10s • esc to interrupt)',
        '• Queued follow-up inputs',
        '  ? 1 question · 5s',
        '    shift-left to answer',
        '› Ask Codex to do anything',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('needs_input');
    expect(res.source).toBe('terminal_prompt');
  });

  it('detects NEEDS_INPUT when Codex v0.160+ question is opened via shift-left with option menu and footer', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-muvnc5uv-e0wc',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      tailLines: [
        '',
        '  >_ OpenAI Codex (v0.160.0)',
        '     /workspace/project',
        '',
        '  Greetings, fellow tinkerer.',
        '',
        '',
        '› to run a test, please ask me a question and wait for the response. In Codex you press shift-left to answer',
        '',
        '',
        '• Which color do you prefer for this test?',
        '',
        '  • Blue',
        '  • Green',
        '  • Red',
        '',
        'Working (1m 08s • esc to interrupt)',
        '',
        '• Queued follow-up inputs',
        '',
        '',
        '  Which color do you prefer for this test?',
        '',
        '  › 1. Blue',
        '    2. Green',
        '    3. Red',
        '    4. Other',
        '',
        '  enter submit   ctrl+] skip   shift+→ main prompt',
        '',
        '',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('needs_input');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toMatch(/Blue|submit|Queued follow-up/i);
  });

  it('detects NEEDS_INPUT for queued questions with minutes/hours duration and multiple questions', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-multi-q',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      tailLines: [
        'Working (3m 22s • esc to interrupt)',
        '• Queued follow-up inputs',
        '  ? 3 questions · 1h 15m',
        '    shift+← to answer',
        '› Ask Codex to do anything',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('needs_input');
    expect(res.source).toBe('terminal_prompt');
    expect(res.detectedPrompt).toMatch(/shift\+← to answer|\? 3 questions/i);
  });

  it('reports NEEDS_INPUT for background session (isPtyAttached: false) with queued follow-up questions', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-bg-q',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: false,
      paneCurrentCommand: 'codex',
      tailLines: [
        'Working (45s • esc to interrupt)',
        '• Queued follow-up inputs',
        '  ? 1 question · 30s',
        '    shift+← to answer',
        '› Ask Codex to do anything',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('needs_input');
    expect(res.status).not.toBe('disconnected');
    expect(res.status).not.toBe('idle');
    expect(res.source).toBe('terminal_prompt');
  });

  it('reports NEEDS_INPUT for background session (isPtyAttached: false) with open questionnaire menu', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-bg-menu',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: false,
      paneCurrentCommand: 'codex',
      tailLines: [
        'Working (1m 15s • esc to interrupt)',
        '• Queued follow-up inputs',
        '  Choose an option:',
        '    1. First',
        '  › 2. Second',
        '  enter submit   ctrl+] skip   shift+→ main prompt',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('needs_input');
    expect(res.status).not.toBe('disconnected');
    expect(res.status).not.toBe('idle');
    expect(res.source).toBe('terminal_prompt');
  });

  it('detects NEEDS_INPUT when question has bullet options in terminal transcript', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-bullet-q',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      tailLines: [
        '• Which environment would you like to configure?',
        '  • Local development',
        '  • Staging',
        '  • Production',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('needs_input');
    expect(res.source).toBe('terminal_prompt');
  });

  it('clears historical queued-input indicators after a completed turn', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-answered-queue',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      tailLines: [
        '• Queued follow-up inputs',
        '  ? 1 question · 14s',
        '    shift+← to answer',
        'Working (15s • esc to interrupt)',
        '─ Worked for 16s ─────────────────────────────',
        '',
        '› Ask Codex to do anything',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.status).not.toBe('needs_input');
  });

  it('does not trigger NEEDS_INPUT when prose mentions approving or applying a plan', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-neg-plan-prose',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      tailLines: [
        'Implemented the endpoint to approve the plan in production.',
        '─ Worked for 4s ─────────────────────────────',
        '',
        '› Ask Codex to do anything',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.status).not.toBe('needs_input');
  });

  it('does not trigger CHOICE when ready prompt is followed by navigation tips', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-neg-arrow-tips',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      tailLines: [
        '─ Worked for 2s ─────────────────────────────',
        '',
        '› Ask Codex to do anything',
        'Use arrow keys to navigate history',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.status).not.toBe('needs_input');
  });

  it('does not trigger NEEDS_INPUT when transcript prose mentions Allow and Deny', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-neg-allow-deny',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      tailLines: [
        'Updated the Allow list and Deny list in security policy.',
        '─ Worked for 12s ─────────────────────────────',
        '',
        '› Ask Codex to do anything',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.status).not.toBe('needs_input');
  });

  it('does not trigger NEEDS_INPUT when transcript prose mentions question counts without queued badge', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-neg-q-count',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      tailLines: [
        'Added 2 questions to the project documentation.',
        '─ Worked for 5s ─────────────────────────────',
        '',
        '› Ask Codex to do anything',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.status).not.toBe('needs_input');
  });

  it('does not trigger WORKING when prose mentions Reasoning without a header glyph', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-neg-reasoning',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      tailLines: [
        'Reasoning about the system architecture is now complete.',
        '─ Worked for 3s ─────────────────────────────',
        '',
        '› Ask Codex to do anything',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.status).not.toBe('working');
  });

  it('does not trigger NEEDS_INPUT when a numbered list exists in transcript followed by ready prompt', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-neg-numbered-list',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      tailLines: [
        'Completed tasks:',
        '1. Added schema validation.',
        '2. Added automated tests.',
        '─ Worked for 10s ─────────────────────────────',
        '',
        '› Ask Codex to do anything',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.status).not.toBe('needs_input');
  });

  it('does not trigger NEEDS_INPUT when tail ends at completion marker with historical confirmation above', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-comp-marker-end',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      tailLines: [
        'Do you want to proceed? [y/N]',
        'y',
        'Working (4s • esc to interrupt)',
        '─ Worked for 4s ─────────────────────────────',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.status).not.toBe('needs_input');
  });

  it('does not trigger NEEDS_INPUT for bullet questions when ready prompt is visible without queued follow-up', () => {
    const signals: SessionSignals = {
      sessionId: 'sess-bullet-answered',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: true,
      paneCurrentCommand: 'codex',
      tailLines: [
        '• Which environment would you like to configure?',
        '  • Local development',
        '  • Staging',
        '  • Production',
        'Staging',
        '',
        '› Ask Codex to do anything',
      ],
    };

    const res = adapter.evaluateStatus(signals);
    expect(res.status).toBe('idle');
    expect(res.status).not.toBe('needs_input');
  });
  describe('turn failures', () => {
    const capacityFailure = '■ Selected model is at capacity. Please try a different model.';
    const readyPrompt = ['› Ask Codex to do anything', '  gpt-model high · Context 80% left', '  ← for agents · ? for shortcuts'];
    const evaluate = (tailLines: string[]) => adapter.evaluateStatus({
      sessionId: 'sess-codex-failure',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: false,
      paneCurrentCommand: 'codex',
      tailLines,
    });

    it('reports the latest failure as ERROR although the ready prompt is redrawn', () => {
      const res = evaluate([
        '  Worked for 3m 10s • 10:10 AM',
        '› Check the release notes',
        '• Called example.list_items',
        '  └ Action completed.',
        capacityFailure,
        '',
        ...readyPrompt,
      ]);
      expect(res.status).toBe('error');
      expect(res.source).toBe('terminal_prompt');
      expect(res.detectedPrompt).toBe('Selected model is at capacity. Please try a different model.');
      expect(res.reason).toContain('Selected model is at capacity');
    });

    it('keeps ERROR while a retry is only an unsent draft', () => {
      const res = evaluate([capacityFailure, '› retry the request', '  ← for agents · ? for shortcuts']);
      expect(res.status).toBe('error');
    });

    it('clears a historical failure once the retry produces new activity', () => {
      const failedThenRetried = [capacityFailure, '› retry', '• Retrying the previous check.'];
      expect(evaluate([...failedThenRetried, '• Working (4s • esc to interrupt)', ...readyPrompt]).status).toBe('working');
      expect(evaluate([...failedThenRetried, '• Called example.list_items', '  └ Action completed.', ...readyPrompt]).status).toBe('idle');
      expect(evaluate([...failedThenRetried, '─ Worked for 12s ─────────', ...readyPrompt]).status).toBe('idle');
    });

    it('treats a submitted retry as superseding the failure', () => {
      expect(evaluate([capacityFailure, '› retry', ...readyPrompt]).status).toBe('idle');
    });

    it('recognizes a new failure after a recovered one', () => {
      const res = evaluate([
        capacityFailure,
        '› retry',
        '• Retrying the previous check.',
        '• Called example.list_items',
        '  └ Action completed.',
        capacityFailure,
        ...readyPrompt,
      ]);
      expect(res.status).toBe('error');
      expect(res.reason).toContain('Selected model is at capacity');
    });

    it.each([
      ['an active working line', '• Working (4s • esc to interrupt)'],
      ['an approval prompt', 'Do you want to proceed? [y/N]'],
    ])('lets the latest failure outrank %s from before it', (_label, olderLine) => {
      const res = evaluate([olderLine, capacityFailure, ...readyPrompt]);
      expect(res.status).toBe('error');
      expect(res.reason).toContain('Selected model is at capacity');
    });

    it('keeps newer input requests after a submitted retry', () => {
      const res = evaluate([capacityFailure, '› retry', 'Do you want to proceed? [y/N]', ...readyPrompt]);
      expect(res.status).toBe('needs_input');
    });

    it('ignores a failure quoted inside the editable draft', () => {
      const res = evaluate(['› Explain this message:', `  ${capacityFailure}`, '  gpt-model high · Context 80% left']);
      expect(res.status).not.toBe('error');
    });

    it.each([
      ['an indented bullet', ['› Explain:', '  • Example text']],
      ['quoted prompt glyphs', ['› Compare these lines:', '  › first quoted prompt', '  › second quoted prompt']],
    ])('does not treat a draft with %s as recovery', (_label, draft) => {
      const res = evaluate([capacityFailure, ...draft, '  gpt-model high · Context 80% left']);
      expect(res.status).toBe('error');
    });

    it('does not treat an indented square bullet in the transcript as a failure', () => {
      const res = evaluate(['• The documentation uses the following list:', '  ■ Supported platforms', ...readyPrompt]);
      expect(res.status).toBe('idle');
    });

    it('keeps the failure when its wrapped text contains an indented bullet', () => {
      const res = evaluate([capacityFailure, '  • Please try again later', ...readyPrompt]);
      expect(res.status).toBe('error');
    });

    it.each(['› Ask Codex to do anything', '›', '› '])('clears the failure after a submitted retry and the ready prompt %j', (prompt) => {
      const res = evaluate([capacityFailure, '› retry', prompt]);
      expect(res.status).toBe('idle');
    });

    it.each([
      ['a completion marker', '  Worked for 12s'],
      ['an active working line', '  • Working (4s • esc to interrupt)'],
      ['an approval prompt', '  Do you want to proceed? [y/N]'],
    ])('keeps ERROR when an unsent draft quotes %s', (_label, quoted) => {
      const res = evaluate([capacityFailure, '› Explain this log:', quoted, '  gpt-model high · Context 80% left']);
      expect(res.status).toBe('error');
      expect(res.reason).toContain('Selected model is at capacity');
    });

    it('keeps ERROR when the first draft line quotes an approval prompt', () => {
      expect(evaluate([capacityFailure, '› Do you want to proceed? [y/N]']).status).toBe('error');
    });

    it('still honors an indented completion marker in the transcript', () => {
      expect(evaluate([capacityFailure, '› retry', '• Done.', '  Worked for 12s • 10:10 AM', ...readyPrompt]).status).toBe('idle');
      expect(evaluate(['• Working (4s • esc to interrupt)', '  Worked for 3m 10s • 10:10 AM', ...readyPrompt]).status).toBe('idle');
    });

    it('reports ERROR for a submitted prompt followed by a failure before the composer is redrawn', () => {
      const res = evaluate(['› run tests', capacityFailure]);
      expect(res.status).toBe('error');
      expect(res.reason).toContain('Selected model is at capacity');
      expect(evaluate(['› run tests', capacityFailure, ...readyPrompt]).status).toBe('error');
      expect(evaluate(['› run tests', capacityFailure, '› retry the request']).status).toBe('error');
      expect(evaluate(['› run tests', capacityFailure, '› retry', '• Retrying the check.', ...readyPrompt]).status).toBe('idle');
      expect(evaluate(['› run tests', '• Ran pnpm test', '  └ ok', ...readyPrompt]).status).toBe('idle');
    });

    it('does not report an interrupted turn as ERROR', () => {
      const res = evaluate([
        '■ Conversation interrupted - tell the model what to do differently.',
        ...readyPrompt,
      ]);
      expect(res.status).toBe('idle');
    });
  });
  describe('quoted tool output', () => {
    const evaluate = (tailLines: string[]) => adapter.evaluateStatus({
      sessionId: 'sess-codex-tool-output',
      hostReachable: true,
      tmuxSessionExists: true,
      paneExists: true,
      paneDead: false,
      isPtyAttached: false,
      paneCurrentCommand: 'codex',
      tailLines,
    });
    const toolOutput = [
      '• Ran a status regression probe',
      '  └ {"name":"draft quoting working","status":"working","reason":"• Working (4s • esc to interrupt)"}',
      '    {"name":"draft quoting completion","status":"idle","reason":"Worked for 12s"}',
      '    {"name":"later confirmation","status":"needs_input","reason":"Do you want to proceed? [y/N]"}',
      '    + 2 lines (^t to expand)',
      '• The review found one remaining issue.',
    ];
    const readyPrompt = [
      '› Ask Codex to do anything',
      '  gpt-model xhigh · Context 75% left · example-project',
      '  ← for agents · ? for shortcuts                ⚠ 1 warning · f2 to view',
    ];

    it('reports WORKING from the live status line, not quoted input requests', () => {
      const res = evaluate([...toolOutput, 'Working (1h 06m 15s • esc to interrupt)', '  └ Tip: Use /archive to archive the current session.', ...readyPrompt]);
      expect(res.status).toBe('working');
      expect(res.detectedPrompt).toBe('Working (1h 06m 15s • esc to interrupt)');
    });

    it('reports IDLE once the turn is finished', () => {
      const res = evaluate([...toolOutput, ...readyPrompt]);
      expect(res.status).toBe('idle');
      expect(res.detectedPrompt).toBe('› Ask Codex to do anything');
    });

    it('keeps a genuine later input request and points at it, not the footer', () => {
      const res = evaluate([...toolOutput, 'Working (5s • esc to interrupt)', 'Do you want to proceed? [y/N]', ...readyPrompt]);
      expect(res.status).toBe('needs_input');
      expect(res.detectedPrompt).toBe('Do you want to proceed? [y/N]');
    });

    it('keeps an indented approval dialog that follows a submitted prompt', () => {
      const res = evaluate([
        '› run tests',
        '  Would you like to run the following command?',
        '  $ pnpm test',
        '  › 1. Yes, proceed (y)',
        '    2. No, and tell Codex what to do differently (esc)',
        '  Press enter to confirm',
      ]);
      expect(res.status).toBe('needs_input');
      expect(res.detectedPrompt).toBe('› 1. Yes, proceed (y)');
    });

    it('treats an approval dialog quoted in a draft above the footer as the draft', () => {
      const quotedDialog = ['› Explain this dialog:', '  › 1. Yes, proceed (y)', '    2. No', '  Press enter to confirm', ...readyPrompt.slice(1)];
      expect(evaluate(quotedDialog).status).toBe('idle');
      expect(evaluate(['■ Selected model is at capacity. Please try a different model.', ...quotedDialog]).status).toBe('error');
    });

    it.each([2, 35])('keeps a quoted confirmation inside a %i-row tool block quoted', (rows) => {
      const res = evaluate([
        '• Ran a diagnostic',
        '  └ Diagnostic output',
        ...Array(rows).fill('    Ordinary tool output'),
        '    Do you want to proceed? [y/N]',
        'Working (4s • esc to interrupt)',
        ...readyPrompt,
      ]);
      expect(res.status).toBe('working');
    });

    it('does not treat a quoted confirmation in the tool command as input', () => {
      const header = ["• Ran printf 'Do you want to proceed? [y/N]'", '  └ Do you want to proceed? [y/N]'];
      expect(evaluate([...header, 'Working (4s • esc to interrupt)', ...readyPrompt]).status).toBe('working');
      expect(evaluate([...header, ...readyPrompt]).status).toBe('idle');
      expect(evaluate(["• Ran printf 'line one", "  │ Do you want to proceed? [y/N]'", '  └ line one', ...readyPrompt]).status).toBe('idle');
    });

    it.each([
      '• Running (5s • esc to interrupt)',
      '• Running pnpm test (5s • esc to interrupt)',
      "• Running printf 'Do you want to proceed? [y/N]' (5s • esc to interrupt)",
    ])('keeps the live activity of a running tool: %s', (activity) => {
      const res = evaluate([activity, ...readyPrompt]);
      expect(res.status).toBe('working');
      expect(res.detectedPrompt).toBe('• Running (5s • esc to interrupt)');
    });

    it('does not treat an interrupt hint quoted inside a command as live activity', () => {
      expect(evaluate(["• Ran printf '(5s • esc to interrupt)'", ...readyPrompt]).status).toBe('idle');
      expect(evaluate(["• Ran printf '(5s • esc to interrupt)' && echo done", ...readyPrompt]).status).toBe('idle');
    });

    it('keeps a genuine input request after a running tool and recovers to idle', () => {
      const running = '• Running pnpm test (5s • esc to interrupt)';
      const input = evaluate([running, 'Do you want to proceed? [y/N]', ...readyPrompt]);
      expect(input.status).toBe('needs_input');
      expect(input.detectedPrompt).toBe('Do you want to proceed? [y/N]');
      expect(evaluate(["• Ran pnpm test", '  └ ok', '─ Worked for 12s ─────────', ...readyPrompt]).status).toBe('idle');
    });

    it('still counts a tool entry as recovery after a failure', () => {
      const res = evaluate(['■ Selected model is at capacity. Please try a different model.', '› retry', '• Ran pnpm test', '  └ ok', ...readyPrompt]);
      expect(res.status).toBe('idle');
      expect(evaluate(['■ Selected model is at capacity. Please try a different model.', '• Ran pnpm test', '  └ ok', ...readyPrompt]).status).toBe('idle');
    });

    it('keeps a genuine approval menu that replaces the input prompt', () => {
      const res = evaluate([...toolOutput, 'Approval required: Codex wants to execute the following command:', '  git push origin main', '❯ 1. Allow once', '  2. Deny']);
      expect(res.status).toBe('needs_input');
    });
  });
});
