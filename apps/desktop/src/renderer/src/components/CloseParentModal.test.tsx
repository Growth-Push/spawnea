import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CloseParentModal, isPossiblyDirtyChild } from './CloseParentModal';
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

  it('disables every action and Escape while closing, then offers retry for the failed action', () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    const props = { isOpen: true, parentSession: mockParent, childrenSessions: mockChildren, onClose, onConfirm };
    const { rerender } = render(<CloseParentModal {...props} isLoading />);
    expect(screen.getByRole('status').textContent).toContain('Closing sessions');
    for (const button of screen.getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
    }
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    rerender(<CloseParentModal {...props} error="Could not close session (busy)" retryAction="leave-children" />);
    expect(screen.getByRole('alert').textContent).toContain('(busy)');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onConfirm).toHaveBeenCalledWith('leave-children');
    fireEvent.click(screen.getByTestId('parent-close-cancel-button'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('traps focus including reverse Tab after pending deletion fails when focus is on modal container', () => {
    const props = {
      isOpen: true,
      parentSession: mockParent,
      childrenSessions: mockChildren,
      onClose: vi.fn(),
      onConfirm: vi.fn(),
      isLoading: true,
    };
    const { rerender } = render(<CloseParentModal {...props} />);
    const modal = screen.getByRole('dialog');
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(modal);

    rerender(<CloseParentModal {...props} isLoading={false} error="Deletion failed" />);
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

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
    const onClose = vi.fn();
    const { container } = render(
      <CloseParentModal
        isOpen={true}
        parentSession={null}
        childrenSessions={mockChildren}
        onClose={onClose}
        onConfirm={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
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

  it('traps Tab key navigation and prevents focus escape when loading', () => {
    render(
      <CloseParentModal
        isOpen={true}
        isLoading={true}
        parentSession={mockParent}
        childrenSessions={mockChildren}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    );

    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  describe('isPossiblyDirtyChild', () => {
    it('returns false when worktree is verified missing on disk', () => {
      const child = mockChildren[1]; // managedWorktree: true
      expect(isPossiblyDirtyChild(child, { [child.id]: true }, { [child.id]: true }, { [child.id]: true })).toBe(false);
    });

    it('returns true when worktree is managed and dirty', () => {
      const child = mockChildren[1];
      expect(isPossiblyDirtyChild(child, { [child.id]: true }, { [child.id]: false }, { [child.id]: false })).toBe(true);
    });

    it('returns false when worktree is not managed', () => {
      const child = mockChildren[0]; // managedWorktree: undefined
      expect(isPossiblyDirtyChild(child, { [child.id]: true }, { [child.id]: true }, {})).toBe(false);
    });
  });

  it('renders Worktree absent badge and hides uncommitted warning when worktree is absent', () => {
    render(
      <CloseParentModal
        isOpen={true}
        parentSession={mockParent}
        childrenSessions={mockChildren}
        gitDirtyBySessionId={{ 'child-2': false }}
        gitUnavailableBySessionId={{ 'child-2': false }}
        gitMissingBySessionId={{ 'child-2': true }}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    );

    expect(screen.getByText('Worktree absent')).toBeDefined();
    expect(screen.queryByText(/may have uncommitted changes/)).toBeNull();
  });

  it('renders branch mismatch badge and offers Close & Preserve Worktree button upon mismatch error', () => {
    const onConfirm = vi.fn();
    render(
      <CloseParentModal
        isOpen={true}
        parentSession={mockParent}
        childrenSessions={mockChildren}
        gitBranchMismatchBySessionId={{
          'child-2': { currentBranch: 'feature/divergent', recordedBranch: 'spawnea/task-2' },
        }}
        error="Managed worktree for child 'child-2' is checked out on 'feature/divergent', not recorded branch 'spawnea/task-2'. Destructive cleanup is blocked to protect uncommitted or divergent work."
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />
    );

    expect(screen.getByText('Branch mismatch (feature/divergent)')).toBeDefined();

    const preserveButton = screen.getByTestId('parent-close-preserve-mismatched-button');
    expect(preserveButton).toBeDefined();
    fireEvent.click(preserveButton);
    expect(onConfirm).toHaveBeenCalledWith('close-all-preserve-mismatched');

    const preserveAction = screen.getByTestId('parent-close-preserve-mismatched-action');
    expect(preserveAction).toBeDefined();
    fireEvent.click(preserveAction);
    expect(onConfirm).toHaveBeenCalledWith('close-all-preserve-mismatched');
  });
});
