import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { ControlFinalizationRequest } from '@spawnea/domain';
import { ControlFinalizationModal } from './ControlFinalizationModal';

const request: ControlFinalizationRequest = {
  id: 'request-id',
  clientRequestId: 'client-request-id',
  sessionId: 'session-id',
  sessionName: 'Fix session',
  branch: 'spawnea/fix-session',
  baseBranch: 'main',
  worktreePath: '/repo/worktrees/fix-session',
  action: 'close',
  dirtyChanges: 'discard',
  mode: 'ui-confirmation',
  status: 'pending',
  createdAt: '2026-08-27T10:00:00.000Z',
};

describe('ControlFinalizationModal', () => {
  it('does not render for a validated MCP close', () => {
    const { container } = render(
      <ControlFinalizationModal
        request={{ ...request, mode: 'mcp-validated', status: 'completed' }}
        onDecision={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    expect(container.firstChild).toBeNull();
  });

  it('clearly says nothing ran and spells out permanent discard before approval', async () => {
    const onDecision = vi.fn().mockResolvedValue(undefined);
    render(<ControlFinalizationModal request={request} onDecision={onDecision} onDismiss={vi.fn()} />);

    expect(screen.getByText(/Nothing has been executed/)).toBeDefined();
    expect(screen.getByText(/permanently discard tracked and untracked local changes/)).toBeDefined();
    expect(screen.getByText('spawnea/fix-session')).toBeDefined();
    expect(screen.getByText('/repo/worktrees/fix-session')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm: Close worktree' }));
    await waitFor(() => expect(onDecision).toHaveBeenCalledWith('request-id', 'approve'));
  });

  it('offers an explicit rejection path', async () => {
    const onDecision = vi.fn().mockResolvedValue(undefined);
    render(<ControlFinalizationModal request={request} onDecision={onDecision} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reject request' }));
    await waitFor(() => expect(onDecision).toHaveBeenCalledWith('request-id', 'reject'));
  });
});
