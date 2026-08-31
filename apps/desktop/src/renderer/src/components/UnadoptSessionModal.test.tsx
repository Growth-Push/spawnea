import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UnadoptSessionModal } from './UnadoptSessionModal';
import type { Session, Server, Project, Agent } from '@spawnea/domain';

describe('UnadoptSessionModal (FG-7.2.3)', () => {
  const mockSession: Session = {
    id: 'sess-adopted-1',
    name: 'Adopted Shell Session',
    serverId: 'srv-1',
    projectId: 'proj-1',
    agentId: 'agent-terminal',
    task: 'Adopted Shell Session',
    worktreePath: '/workspace/demo',
    branch: 'main',
    tmuxSessionName: 'manual-tmux-session',
    status: 'working',
    isExternal: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastActivityAt: new Date('2026-01-01T01:00:00Z'),
  };

  const mockServer: Server = {
    id: 'srv-1',
    name: 'Local Workstation',
    host: 'localhost',
    sshPort: 22,
    enabled: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };

  const mockProject: Project = {
    id: 'proj-1',
    serverId: 'srv-1',
    name: 'Demo Project',
    rootPath: '/workspace/demo',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };

  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <UnadoptSessionModal
        isOpen={false}
        session={mockSession}
        onClose={vi.fn()}
        onConfirmUnadopt={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders non-destructive release warning and session details', () => {
    render(
      <UnadoptSessionModal
        isOpen={true}
        session={mockSession}
        server={mockServer}
        project={mockProject}
        onClose={vi.fn()}
        onConfirmUnadopt={vi.fn()}
      />
    );

    expect(screen.getByText('Release / Un-adopt Session')).toBeDefined();
    expect(screen.getByText('Non-Destructive Release')).toBeDefined();
    expect(screen.getByText(/continue running uninterrupted/)).toBeDefined();
    expect(screen.getAllByText('manual-tmux-session').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Adopted Shell Session')).toBeDefined();
    expect(screen.getByText('Local Workstation (localhost)')).toBeDefined();
    expect(screen.getByText('Demo Project')).toBeDefined();
  });

  it('calls onConfirmUnadopt when Release button is clicked', () => {
    const onConfirmUnadopt = vi.fn();
    const onClose = vi.fn();

    render(
      <UnadoptSessionModal
        isOpen={true}
        session={mockSession}
        server={mockServer}
        project={mockProject}
        onClose={onClose}
        onConfirmUnadopt={onConfirmUnadopt}
      />
    );

    fireEvent.click(screen.getByTestId('unadopt-modal-confirm'));
    expect(onConfirmUnadopt).toHaveBeenCalledWith('sess-adopted-1');
  });

  it('calls onClose when Cancel button is clicked', () => {
    const onConfirmUnadopt = vi.fn();
    const onClose = vi.fn();

    render(
      <UnadoptSessionModal
        isOpen={true}
        session={mockSession}
        server={mockServer}
        project={mockProject}
        onClose={onClose}
        onConfirmUnadopt={onConfirmUnadopt}
      />
    );

    fireEvent.click(screen.getByTestId('unadopt-modal-cancel'));
    expect(onClose).toHaveBeenCalled();
    expect(onConfirmUnadopt).not.toHaveBeenCalled();
  });
});
