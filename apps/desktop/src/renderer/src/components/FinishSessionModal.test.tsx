import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { FinishSessionModal } from './FinishSessionModal';
import type { Session } from '@spawnea/domain';

describe('FinishSessionModal (Task 6.2.1)', () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, 'spawneaApi');
  });

  const mockWorktreeSession: Session = {
    id: 'sess-worktree-1',
    name: 'Implement feature X',
    serverId: 'srv-1',
    projectId: 'proj-1',
    agentId: 'agent-claude',
    task: 'Implement feature X',
    worktreePath: '/workspace/demo__worktrees/feature-x',
    branch: 'spawnea/feature-x-12345',
    baseBranch: 'main',
    managedWorktree: true,
    tmuxSessionName: 'spawnea-feature-x',
    status: 'done',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastActivityAt: new Date('2026-01-01T01:00:00Z'),
  };

  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <FinishSessionModal
        isOpen={false}
        session={mockWorktreeSession}
        onClose={vi.fn()}
        onFinish={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders session details and finalization options', () => {
    render(
      <FinishSessionModal
        isOpen={true}
        session={mockWorktreeSession}
        onClose={vi.fn()}
        onFinish={vi.fn()}
      />
    );

    expect(screen.getByText('Finish Worktree Session')).toBeDefined();
    expect(screen.getByText('spawnea/feature-x-12345')).toBeDefined();
    expect(screen.getByText('/workspace/demo__worktrees/feature-x')).toBeDefined();
    expect(screen.getByText(/Integrate into/)).toBeDefined();
    expect(screen.getByText('Close Worktree (Discard Changes, Keep Task Branch)')).toBeDefined();
    expect(screen.getByText('Ignore / Keep Working')).toBeDefined();
  });

  it('submits integrate action by default', async () => {
    const onFinish = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(
      <FinishSessionModal
        isOpen={true}
        session={mockWorktreeSession}
        onClose={onClose}
        onFinish={onFinish}
      />
    );

    const submitBtn = screen.getByRole('button', { name: /Integrate & Clean Up/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(onFinish).toHaveBeenCalledWith('sess-worktree-1', 'integrate');
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('allows selecting Close Worktree option and submits close action', async () => {
    const onFinish = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(
      <FinishSessionModal
        isOpen={true}
        session={mockWorktreeSession}
        onClose={onClose}
        onFinish={onFinish}
      />
    );

    fireEvent.click(screen.getByText('Close Worktree (Discard Changes, Keep Task Branch)'));
    fireEvent.click(screen.getByTestId('finish-close-confirm-checkbox'));
    const submitBtn = screen.getByRole('button', { name: /Close Worktree/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(onFinish).toHaveBeenCalledWith('sess-worktree-1', 'close', { stashChanges: false });
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('allows saving changes in a named stash before closing', async () => {
    const onFinish = vi.fn().mockResolvedValue(undefined);

    render(
      <FinishSessionModal
        isOpen={true}
        session={mockWorktreeSession}
        onClose={vi.fn()}
        onFinish={onFinish}
      />
    );

    fireEvent.click(screen.getByText('Close Worktree (Discard Changes, Keep Task Branch)'));
    fireEvent.click(screen.getByTestId('finish-stash-changes-checkbox'));
    fireEvent.click(screen.getByTestId('finish-close-confirm-checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Close Worktree/i }));

    await waitFor(() => {
      expect(onFinish).toHaveBeenCalledWith('sess-worktree-1', 'close', { stashChanges: true });
    });
  });

  it('shows an integrated worktree and defaults to closing it', async () => {
    const onFinish = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'spawneaApi', {
      configurable: true,
      value: {
        inspectWorktree: vi.fn().mockResolvedValue({
          state: 'integrated',
          currentBranch: 'main',
          isClean: true,
          message: "Task branch 'spawnea/feature-x-12345' is already integrated into 'main'.",
        }),
      },
    });

    render(
      <FinishSessionModal
        isOpen={true}
        session={mockWorktreeSession}
        onClose={vi.fn()}
        onFinish={onFinish}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('finish-worktree-integrated-banner')).toBeDefined();
      expect(screen.getByText('Worktree already integrated')).toBeDefined();
      expect(screen.getByText(/Select Close Worktree to remove the folder\./)).toBeDefined();
      expect((screen.getByRole('button', { name: 'Close Worktree' }) as HTMLButtonElement).disabled).toBe(true);
    });

    expect(screen.queryByTestId('finish-stash-changes-checkbox')).toBeNull();

    fireEvent.click(screen.getByTestId('finish-close-confirm-checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Close Worktree' }));

    await waitFor(() => {
      expect(onFinish).toHaveBeenCalledWith('sess-worktree-1', 'close', { stashChanges: false });
    });
  });

  it('hides stash and discard warnings for a clean worktree', async () => {
    const onFinish = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'spawneaApi', {
      configurable: true,
      value: {
        inspectWorktree: vi.fn().mockResolvedValue({
          state: 'active',
          currentBranch: mockWorktreeSession.branch,
          isClean: true,
          message: 'Worktree is on its recorded task branch.',
        }),
      },
    });

    render(
      <FinishSessionModal
        isOpen={true}
        session={mockWorktreeSession}
        onClose={vi.fn()}
        onFinish={onFinish}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Close Worktree (Keep Task Branch)')).toBeDefined();
    });
    fireEvent.click(screen.getByText('Close Worktree (Keep Task Branch)'));

    expect(screen.queryByTestId('finish-stash-changes-checkbox')).toBeNull();
    expect(screen.getAllByText(/No local Git changes were detected\./)).toHaveLength(2);

    fireEvent.click(screen.getByTestId('finish-close-confirm-checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Close Worktree' }));

    await waitFor(() => {
      expect(onFinish).toHaveBeenCalledWith('sess-worktree-1', 'close', { stashChanges: false });
    });
  });

  it('keeps stash preservation available for a dirty worktree', async () => {
    Object.defineProperty(window, 'spawneaApi', {
      configurable: true,
      value: {
        inspectWorktree: vi.fn().mockResolvedValue({
          state: 'active',
          currentBranch: mockWorktreeSession.branch,
          isClean: false,
          message: 'Worktree is on its recorded task branch.',
        }),
      },
    });

    render(
      <FinishSessionModal
        isOpen={true}
        session={mockWorktreeSession}
        onClose={vi.fn()}
        onFinish={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText('Close Worktree (Discard Changes, Keep Task Branch)'));
    await waitFor(() => {
      expect(screen.getByTestId('finish-stash-changes-checkbox')).toBeDefined();
    });
  });

  it('blocks finalization controls while the worktree inspection is pending', async () => {
    Object.defineProperty(window, 'spawneaApi', {
      configurable: true,
      value: {
        inspectWorktree: vi.fn().mockImplementation(() => new Promise(() => {})),
      },
    });

    render(
      <FinishSessionModal
        isOpen={true}
        session={mockWorktreeSession}
        onClose={vi.fn()}
        onFinish={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('finish-inspection-loading')).toBeDefined();
      expect((screen.getByRole('button', { name: 'Integrate & Clean Up' }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it('shows a conservative warning when the pre-check fails', async () => {
    Object.defineProperty(window, 'spawneaApi', {
      configurable: true,
      value: {
        inspectWorktree: vi.fn().mockRejectedValue(new Error('offline')),
      },
    });

    render(
      <FinishSessionModal
        isOpen={true}
        session={mockWorktreeSession}
        onClose={vi.fn()}
        onFinish={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('finish-inspection-warning')).toBeDefined();
    });
    fireEvent.click(screen.getByText('Close Worktree (Discard Changes, Keep Task Branch)'));
    expect(screen.getByTestId('finish-stash-changes-checkbox')).toBeDefined();
  });

  it('selecting Ignore dismisses dialog without calling onFinish', async () => {
    const onFinish = vi.fn();
    const onClose = vi.fn();

    render(
      <FinishSessionModal
        isOpen={true}
        session={mockWorktreeSession}
        onClose={onClose}
        onFinish={onFinish}
      />
    );

    fireEvent.click(screen.getByText('Ignore / Keep Working'));
    const submitBtn = screen.getByRole('button', { name: /Dismiss/i });
    fireEvent.click(submitBtn);

    expect(onClose).toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('displays safety error banner when finalization fails', async () => {
    const onFinish = vi.fn().mockRejectedValue(new Error('Worktree contains uncommitted tracked changes'));
    const onClose = vi.fn();

    render(
      <FinishSessionModal
        isOpen={true}
        session={mockWorktreeSession}
        onClose={onClose}
        onFinish={onFinish}
      />
    );

    const submitBtn = screen.getByRole('button', { name: /Integrate & Clean Up/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText(/Worktree contains uncommitted tracked changes/)).toBeDefined();
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
