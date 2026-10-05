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

it('copies agent skill prompt to clipboard when copy button is clicked', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, {
    clipboard: { writeText },
  });

  window.spawneaApi = {
    getAgentContext: vi.fn().mockResolvedValue({
      rootSessionId: 'root-session-123',
      calls: [],
      volatileNotice: 'Volatile context notice',
    }),
  } as unknown as typeof window.spawneaApi;

  const view = render(<AgentContextView sessionId="root-session-123" />);
  const copyBtn = await screen.findByTestId('copy-agent-prompt-button');
  expect(copyBtn).toBeDefined();

  fireEvent.click(copyBtn);
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  expect(writeText.mock.calls[0][0]).toContain('Spawnea Agent Orchestration');
  expect(copyBtn.textContent).toContain('Copied');

  view.unmount();
});
