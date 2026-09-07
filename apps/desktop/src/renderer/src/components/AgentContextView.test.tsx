import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AgentContextView } from './AgentContextView';

it('loads compact turn output by default and raw output only on explicit selection', async () => {
  const getAgentContextTurn = vi.fn(async (_session, _turn, mode) => ({ output: `${mode} result` }));
  window.spawneaApi = {
    getAgentContext: vi.fn().mockResolvedValue({ rootSessionId: 'root', calls: [{
      id: 'call', operation: 'getTurn', status: 'completed', repeatCount: 1,
      request: [], response: { turnId: 'turn', sessionId: 'child' },
    }], volatileNotice: 'Volatile context' }), getAgentContextTurn,
  } as unknown as typeof window.spawneaApi;
  const view = render(<AgentContextView sessionId="root" />);
  await screen.findByText(/compact result/);
  expect(getAgentContextTurn).toHaveBeenCalledWith('root', 'turn', 'compact');
  expect(screen.getByText(/best-effort observations/)).toBeDefined();
  fireEvent.change(screen.getByRole('combobox', { name: 'Output mode' }), { target: { value: 'raw' } });
  await waitFor(() => expect(getAgentContextTurn).toHaveBeenCalledWith('root', 'turn', 'raw'));
  await screen.findByText(/raw result/);
  view.unmount();
});
