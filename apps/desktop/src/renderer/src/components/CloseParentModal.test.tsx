import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CloseParentModal } from './CloseParentModal';
import type { Session } from '@spawnea/domain';

describe('CloseParentModal', () => {
  afterEach(() => {
    cleanup();
  });

  const mockParent: Session = {
    id: 'parent-1',
    name: 'Parent Root Session',
    serverId: 'srv-1',
    projectId: 'proj-1',
    agentId: 'agent-claude',
    task: 'Parent task',
    branch: 'main',
    worktreePath: '/workspace/spawnea',
    tmuxSessionName: 'spawnea-parent',
    status: 'working',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    lastActivityAt: new Date('2026-09-01T01:00:00Z'),
  };

  const mockChildren: Session[] = [
    {
      id: 'child-1',
      parentSessionId: 'parent-1',
      childAlias: 'child-1',
      name: 'Child One',
      serverId: 'srv-1',
      projectId: 'proj-1',
      agentId: 'agent-claude',
      task: 'Child task one',
      branch: 'main',
      worktreePath: '/workspace/spawnea',
      tmuxSessionName: 'spawnea-child-1',
      status: 'working',
      createdAt: new Date('2026-09-01T00:10:00Z'),
      lastActivityAt: new Date('2026-09-01T01:10:00Z'),
    },
    {
      id: 'child-2',
      parentSessionId: 'parent-1',
      childAlias: 'child-2',
      name: 'Child Two',
      serverId: 'srv-1',
      projectId: 'proj-1',
      agentId: 'agent-claude',
      task: 'Child task two',
      branch: 'spawnea/child-2',
      managedWorktree: true,
      worktreePath: '/workspace/spawnea__worktrees/child-2',
      tmuxSessionName: 'spawnea-child-2',
      status: 'done',
      createdAt: new Date('2026-09-01T00:20:00Z'),
      lastActivityAt: new Date('2026-09-01T01:20:00Z'),
    },
  ];

  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <CloseParentModal
        isOpen={false}
        parentSession={mockParent}
        childrenSessions={mockChildren}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when parentSession is null', () => {
    const { container } = render(
      <CloseParentModal
        isOpen={true}
        parentSession={null}
        childrenSessions={mockChildren}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders parent details and lists child sessions', () => {
    render(
      <CloseParentModal
        isOpen={true}
        parentSession={mockParent}
        childrenSessions={mockChildren}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    );

    expect(screen.getByTestId('close-parent-modal')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Parent Session Has Children' })).toBeDefined();
    expect(screen.getByText('Parent Root Session')).toBeDefined();
    expect(screen.getByText('child-1')).toBeDefined();
    expect(screen.getByText('Child One')).toBeDefined();
    expect(screen.getByText('child-2')).toBeDefined();
    expect(screen.getByText('Child Two')).toBeDefined();
  });

  it('invokes onConfirm with leave-children when leave button clicked', () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <CloseParentModal
        isOpen={true}
        parentSession={mockParent}
        childrenSessions={mockChildren}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />
    );

    fireEvent.click(screen.getByTestId('parent-close-leave-children-button'));
    expect(onConfirm).toHaveBeenCalledWith('leave-children');
  });

  it('invokes onConfirm with close-all when close all button clicked', () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <CloseParentModal
        isOpen={true}
        parentSession={mockParent}
        childrenSessions={mockChildren}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />
    );

    fireEvent.click(screen.getByTestId('parent-close-all-button'));
    expect(onConfirm).toHaveBeenCalledWith('close-all');
  });

  it('invokes onClose when cancel button clicked', () => {
    const onClose = vi.fn();
    render(
      <CloseParentModal
        isOpen={true}
        parentSession={mockParent}
        childrenSessions={mockChildren}
        onClose={onClose}
        onConfirm={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId('parent-close-cancel-button'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows finalization warning specifying Close All when children are dirty', () => {
    const dirtyChild = { ...mockChildren[0], managedWorktree: true };
    render(
      <CloseParentModal
        isOpen={true}
        parentSession={mockParent}
        childrenSessions={[dirtyChild]}
        gitDirtyBySessionId={{ [dirtyChild.id]: true }}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    );

    expect(
      screen.getByText('1 child has uncommitted changes and will prompt for finalization if you choose "Close All".')
    ).toBeDefined();
  });

  it('does not show finalization warning when no children have uncommitted changes', () => {
    render(
      <CloseParentModal
        isOpen={true}
        parentSession={mockParent}
        childrenSessions={mockChildren}
        gitDirtyBySessionId={{}}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    );

    expect(screen.queryByText(/will prompt for finalization/)).toBeNull();
  });
});
