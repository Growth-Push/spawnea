import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StateFeedbackModal } from './StateFeedbackModal';
import type { Session, Server, Agent, StateFeedbackSnapshot, StateFeedbackResult } from '@spawnea/domain';

describe('StateFeedbackModal (FG-4.2.5)', () => {
  const mockSession: Session = {
    id: 'sess-feedback-1',
    name: 'Refactor Attention Detector',
    serverId: 'dev-workstation',
    projectId: 'dev-workstation:spawnea',
    agentId: 'dev-workstation:claude',
    task: 'Refactor Attention Detector',
    worktreePath: '/workspace/spawnea',
    branch: 'feat/detector',
    tmuxSessionName: 'spawnea-sess-feedback-1',
    status: 'idle',
    createdAt: new Date('2026-08-20T10:00:00Z'),
    lastActivityAt: new Date('2026-08-20T10:00:00Z'),
  };

  const mockServer: Server = {
    id: 'dev-workstation',
    name: 'Example Workstation',
    host: 'example-host.invalid',
    sshPort: 22,
    enabled: true,
    createdAt: new Date('2026-08-20T10:00:00Z'),
  };

  const mockAgent: Agent = {
    id: 'dev-workstation:claude',
    name: 'Claude Code',
    harness: 'claude',
    command: 'claude',
    createdAt: new Date('2026-08-20T10:00:00Z'),
  };

  const mockSnapshot: StateFeedbackSnapshot = {
    sessionId: 'sess-feedback-1',
    sessionName: 'Refactor Attention Detector',
    harness: 'claude',
    worktreePath: '/workspace/spawnea',
    branch: 'feat/detector',
    capture: { status: 'captured' },
    detectedStatus: 'idle',
    confidence: 0.9,
    source: 'terminal_prompt',
    reason: 'Agent prompt ready/idle: >',
    detectedPrompt: '>',
    decision: { kind: 'rule', rule: { file: 'user', harness: 'claude', position: 2 } },
    rulesConfig: { source: 'merged' },
    tailLines: [
      'Reading workspace files...',
      'Suggested approach: implement custom matcher.',
      'Do you want to proceed? [y/N] ',
    ],
    capturedAt: new Date().toISOString(),
  };

  const mockSubmitResult: StateFeedbackResult = {
    success: true,
    filePath: '/tmp/spawnea-user-data/feedback/state-feedback-sess-feedback-1-12345.json',
    fixtureJson: JSON.stringify(
      {
        schemaVersion: '2.0.0',
        sessionId: 'sess-feedback-1',
        expectedStatus: 'needs_input',
        detectedStatus: 'idle',
      },
      null,
      2
    ),
  };

  beforeEach(() => {
    (window as any).spawneaApi = {
      getStateSnapshot: vi.fn().mockResolvedValue(mockSnapshot),
      submitStateFeedback: vi.fn().mockResolvedValue(mockSubmitResult),
    };
  });

  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <StateFeedbackModal
        isOpen={false}
        session={mockSession}
        onClose={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders snapshot details and tail lines when open', async () => {
    render(
      <StateFeedbackModal
        isOpen={true}
        session={mockSession}
        server={mockServer}
        agent={mockAgent}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('Report State Detection Feedback')).toBeDefined();

    await waitFor(() => {
      expect(screen.getByText(/Displayed Status/)).toBeDefined();
      expect(screen.getByText(/Detected Now/)).toBeDefined();
      expect(screen.getByText(/Agent prompt ready\/idle: >/)).toBeDefined();
      expect(screen.getByText(/Do you want to proceed\? \[y\/N\]/)).toBeDefined();
      expect(screen.getByTestId('terminal-tail-preview')).toBeDefined();
    });
  });

  it('allows selecting expected status and typing notes commentary', async () => {
    render(
      <StateFeedbackModal
        isOpen={true}
        session={mockSession}
        server={mockServer}
        agent={mockAgent}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('expected-status-needs_input')).toBeDefined();
    });

    // Select "Working / Busy"
    fireEvent.click(screen.getByTestId('expected-status-working'));
    expect(screen.getByTestId('expected-status-working').getAttribute('aria-checked')).toBe('true');

    // Type commentary notes
    const notesInput = screen.getByTestId('feedback-notes-input');
    fireEvent.change(notesInput, {
      target: { value: 'Claude was actually generating code output.' },
    });
    expect((notesInput as HTMLTextAreaElement).value).toBe(
      'Claude was actually generating code output.'
    );
  });

  it('submits feedback report and shows success card with copy fixture button', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    render(
      <StateFeedbackModal
        isOpen={true}
        session={mockSession}
        server={mockServer}
        agent={mockAgent}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('feedback-modal-submit-btn')).toBeDefined();
      expect(screen.getByTestId('feedback-sensitive-content-warning')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('expected-status-needs_input'));
    fireEvent.click(screen.getByTestId('feedback-modal-submit-btn'));

    await waitFor(() => {
      expect(window.spawneaApi.submitStateFeedback).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('feedback-success-card')).toBeDefined();
      expect(screen.getByText(/Feedback Fixture Saved Successfully!/)).toBeDefined();
      expect(
        screen.getByText('/tmp/spawnea-user-data/feedback/state-feedback-sess-feedback-1-12345.json')
      ).toBeDefined();
    });

    // Test Copy Fixture JSON button
    fireEvent.click(screen.getByTestId('copy-fixture-button'));
    expect(writeTextMock).toHaveBeenCalledWith(mockSubmitResult.fixtureJson);
  });

  it('handles error when submitting feedback fails', async () => {
    (window as any).spawneaApi.submitStateFeedback = vi
      .fn()
      .mockRejectedValue(new Error('Permission denied writing to feedback dir'));

    render(
      <StateFeedbackModal
        isOpen={true}
        session={mockSession}
        server={mockServer}
        agent={mockAgent}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('feedback-modal-submit-btn')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('feedback-modal-submit-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('feedback-submit-error')).toBeDefined();
      expect(
        screen.getByText('Permission denied writing to feedback dir')
      ).toBeDefined();
    });
  });

  it('calls onClose when cancel or close button is clicked', async () => {
    const onClose = vi.fn();
    render(
      <StateFeedbackModal
        isOpen={true}
        session={mockSession}
        server={mockServer}
        agent={mockAgent}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByTestId('feedback-modal-cancel-btn'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('shows the winning rule and the rules configuration in use', async () => {
    render(<StateFeedbackModal isOpen={true} session={mockSession} agent={mockAgent} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId('feedback-decision').textContent).toBe('Decided by: user rule claude #2');
      expect(screen.getByTestId('feedback-rules-config').textContent).toBe('Rules in use: User and factory rules');
    });
  });

  it('submits the observed status and decision from a captured snapshot', async () => {
    render(<StateFeedbackModal isOpen={true} session={{ ...mockSession, status: 'working' }} agent={mockAgent} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId('feedback-decision')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('expected-status-needs_input'));
    fireEvent.click(screen.getByTestId('feedback-modal-submit-btn'));

    await waitFor(() => {
      expect(window.spawneaApi.submitStateFeedback).toHaveBeenCalledTimes(1);
    });
    const report = (window.spawneaApi.submitStateFeedback as any).mock.calls[0][0];
    expect(report).toMatchObject({
      observedStatus: 'working',
      expectedStatus: 'needs_input',
      capture: { status: 'captured' },
      detectedStatus: 'idle',
      detectedSource: 'terminal_prompt',
      detectedConfidence: 0.9,
      decision: { kind: 'rule', rule: { file: 'user', harness: 'claude', position: 2 } },
      tailLines: mockSnapshot.tailLines,
    });
    expect(report).not.toHaveProperty('rulesConfig');
  });

  it('labels the activity fallback', async () => {
    (window as any).spawneaApi.getStateSnapshot = vi.fn().mockResolvedValue({
      ...mockSnapshot,
      decision: { kind: 'fallback' },
      rulesConfig: { source: 'user_invalid', error: { file: 'state-rules.yaml', harness: 'claude', position: 1 } },
    });
    render(<StateFeedbackModal isOpen={true} session={mockSession} agent={mockAgent} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId('feedback-decision').textContent).toBe('Decided by: No rule matched (activity fallback)');
      expect(screen.getByTestId('feedback-rules-config').textContent).toBe('Rules in use: Factory rules (user file invalid)');
    });
  });

  it('saves a report without guessed detection values when the main process could not capture', async () => {
    (window as any).spawneaApi.getStateSnapshot = vi.fn().mockResolvedValue({
      sessionId: 'sess-feedback-1',
      sessionName: 'Refactor Attention Detector',
      harness: 'claude',
      capture: { status: 'failed', reason: 'Host or tmux communication failed during capture' },
      rulesConfig: { source: 'factory' },
      tailLines: [],
      capturedAt: new Date().toISOString(),
    } satisfies StateFeedbackSnapshot);
    render(<StateFeedbackModal isOpen={true} session={mockSession} agent={mockAgent} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId('feedback-capture-failed').textContent).toContain('Host or tmux communication failed during capture');
    });
    expect(screen.queryByTestId('feedback-detected-status')).toBeNull();
    expect(screen.queryByTestId('feedback-decision')).toBeNull();
    expect(screen.queryByText(/Confidence:/)).toBeNull();

    fireEvent.click(screen.getByTestId('feedback-modal-submit-btn'));
    await waitFor(() => {
      expect(window.spawneaApi.submitStateFeedback).toHaveBeenCalledTimes(1);
    });
    const report = (window.spawneaApi.submitStateFeedback as any).mock.calls[0][0];
    expect(report.capture).toEqual({ status: 'failed', reason: 'Host or tmux communication failed during capture' });
    expect(report.observedStatus).toBe('idle');
    for (const key of ['detectedStatus', 'detectedSource', 'detectedConfidence', 'detectionReason', 'decision']) {
      expect(report).not.toHaveProperty(key);
    }
    expect(report.tailLines).toEqual([]);
  });

  it('saves a report without detection values when the snapshot request fails', async () => {
    (window as any).spawneaApi.getStateSnapshot = vi.fn().mockRejectedValue(new Error('IPC channel closed'));
    render(<StateFeedbackModal isOpen={true} session={mockSession} agent={mockAgent} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId('feedback-capture-failed').textContent).toContain('IPC channel closed');
    });
    expect((screen.getByTestId('feedback-modal-submit-btn') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('feedback-modal-submit-btn'));
    await waitFor(() => {
      expect(window.spawneaApi.submitStateFeedback).toHaveBeenCalledTimes(1);
    });
    const report = (window.spawneaApi.submitStateFeedback as any).mock.calls[0][0];
    expect(report.capture).toEqual({ status: 'failed', reason: 'Snapshot request to the desktop app failed' });
    expect(report).not.toHaveProperty('detectedConfidence');
    expect(report).not.toHaveProperty('detectedSource');
    expect(JSON.stringify(report)).not.toContain('IPC channel closed');
  });
});
