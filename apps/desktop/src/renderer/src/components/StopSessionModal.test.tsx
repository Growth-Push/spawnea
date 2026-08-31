import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StopSessionModal } from './StopSessionModal';
import type { Session, Server, Project, Agent } from '@spawnea/domain';

describe('StopSessionModal (FG-2.7.1, FG-2.7.2)', () => {
  const mockSession: Session = {
    id: 'sess-test-1',
    name: 'Implement OAuth Authentication',
    serverId: 'dev-workstation',
    projectId: 'dev-workstation:spawnea',
    agentId: 'dev-workstation:claude',
    task: 'Implement OAuth Authentication',
    worktreePath: '/workspace/spawnea',
    branch: 'feat/oauth',
    tmuxSessionName: 'spawnea-sess-test-1',
    status: 'working',
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

  const mockProject: Project = {
    id: 'dev-workstation:spawnea',
    serverId: 'dev-workstation',
    name: 'Spawnea Core',
    rootPath: '/workspace/spawnea',
    createdAt: new Date('2026-08-20T10:00:00Z'),
  };

  const mockAgent: Agent = {
    id: 'dev-workstation:claude',
    name: 'Claude Code',
    harness: 'claude',
    command: 'claude',
    createdAt: new Date('2026-08-20T10:00:00Z'),
  };

  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <StopSessionModal
        isOpen={false}
        session={mockSession}
        onClose={vi.fn()}
        onDetach={vi.fn()}
        onConfirmStop={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders active-work warning, session metadata, and choices when open (FG-2.7.1, FG-2.7.2)', () => {
    render(
      <StopSessionModal
        isOpen={true}
        session={mockSession}
        server={mockServer}
        project={mockProject}
        agent={mockAgent}
        onClose={vi.fn()}
        onDetach={vi.fn()}
        onConfirmStop={vi.fn()}
      />
    );

    // Title and warning banner
    expect(screen.getByText('Terminate Session Execution?')).toBeDefined();
    expect(screen.getByText('Active Work Warning')).toBeDefined();
    expect(screen.getByText(/Terminating will kill the remote persistent/)).toBeDefined();

    // Session details
    expect(screen.getByText('Implement OAuth Authentication')).toBeDefined();
    expect(screen.getByText('Example Workstation (example-host.invalid)')).toBeDefined();
    expect(screen.getByText('Spawnea Core')).toBeDefined();
    expect(screen.getByText('Claude Code')).toBeDefined();
    expect(screen.getByText('(spawnea-sess-test-1)')).toBeDefined();
    expect(screen.getByText('Working')).toBeDefined();

    // Detach vs Stop explanation
    expect(screen.getByText('Detach Instead:')).toBeDefined();
    expect(screen.getByText('Terminate:')).toBeDefined();

    // Buttons
    expect(screen.getByTestId('stop-modal-cancel')).toBeDefined();
    expect(screen.getByTestId('stop-modal-detach')).toBeDefined();
    expect(screen.getByTestId('stop-modal-confirm')).toBeDefined();
  });

  it('calls onClose when Cancel / Keep Running is clicked', () => {
    const onClose = vi.fn();
    const onDetach = vi.fn();
    const onConfirmStop = vi.fn();

    render(
      <StopSessionModal
        isOpen={true}
        session={mockSession}
        onClose={onClose}
        onDetach={onDetach}
        onConfirmStop={onConfirmStop}
      />
    );

    fireEvent.click(screen.getByTestId('stop-modal-cancel'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDetach).not.toHaveBeenCalled();
    expect(onConfirmStop).not.toHaveBeenCalled();
  });

  it('calls onDetach and closes modal when Detach Instead is clicked', async () => {
    const onClose = vi.fn();
    const onDetach = vi.fn().mockResolvedValue(undefined);
    const onConfirmStop = vi.fn();

    render(
      <StopSessionModal
        isOpen={true}
        session={mockSession}
        onClose={onClose}
        onDetach={onDetach}
        onConfirmStop={onConfirmStop}
      />
    );

    fireEvent.click(screen.getByTestId('stop-modal-detach'));

    await waitFor(() => {
      expect(onDetach).toHaveBeenCalledWith('sess-test-1');
      expect(onClose).toHaveBeenCalled();
      expect(onConfirmStop).not.toHaveBeenCalled();
    });
  });

  it('calls onConfirmStop when Terminate Session is clicked', () => {
    const onClose = vi.fn();
    const onDetach = vi.fn();
    const onConfirmStop = vi.fn();

    render(
      <StopSessionModal
        isOpen={true}
        session={mockSession}
        onClose={onClose}
        onDetach={onDetach}
        onConfirmStop={onConfirmStop}
      />
    );

    fireEvent.click(screen.getByTestId('stop-modal-confirm'));

    expect(onConfirmStop).toHaveBeenCalledWith('sess-test-1');
    expect(onDetach).not.toHaveBeenCalled();
  });

  it('displays error message when termination verification fails', () => {
    render(
      <StopSessionModal
        isOpen={true}
        session={mockSession}
        onClose={vi.fn()}
        onDetach={vi.fn()}
        onConfirmStop={vi.fn()}
        error="Host 'dev-workstation' is unreachable. Cannot verify termination."
      />
    );

    expect(screen.getByTestId('stop-modal-error')).toBeDefined();
    expect(
      screen.getByText("Host 'dev-workstation' is unreachable. Cannot verify termination.")
    ).toBeDefined();
  });

  it('shows loading state when isStopping is true', () => {
    render(
      <StopSessionModal
        isOpen={true}
        session={mockSession}
        onClose={vi.fn()}
        onDetach={vi.fn()}
        onConfirmStop={vi.fn()}
        isStopping={true}
      />
    );

    expect(screen.getByText('Terminating...')).toBeDefined();
    expect((screen.getByTestId('stop-modal-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('stop-modal-cancel') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('stop-modal-detach') as HTMLButtonElement).disabled).toBe(true);
  });
});
