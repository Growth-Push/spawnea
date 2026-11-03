import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionLinkButtons } from './SessionLinkButtons';

describe('session link buttons', () => {
  it('renders nothing without references and shows deduplicated contextual buttons with explicit opening', async () => {
    const openExternalUrl = vi.fn().mockResolvedValue(undefined);
    const getSessionLinks = vi.fn().mockResolvedValue([]);
    window.spawneaApi = { getSessionLinks, openExternalUrl } as never;
    const view = render(<SessionLinkButtons sessionId="one" active />);
    await waitFor(() => expect(getSessionLinks).toHaveBeenCalled());
    expect(view.container.firstChild).toBeNull();
    getSessionLinks.mockResolvedValue([
      { url: 'https://github.com/example/repo/issues/1', kind: 'issue', source: 'task' },
      { url: 'https://github.com/example/repo/issues/1', kind: 'issue', source: 'output' },
      { url: 'https://github.com/example/repo/pull/2', kind: 'pull', source: 'prompt' },
      { url: 'https://github.com/example/my_repo', kind: 'repository', source: 'task' },
      { url: 'https://github.com.evil/example/repo', kind: 'repository', source: 'task' },
    ]);
    view.rerender(<SessionLinkButtons sessionId="two" originIssueUrl="https://github.com/Example/Repo/issues/1?x=y" active />);
    expect(await screen.findByRole('button', { name: 'PR #2 · example/repo' })).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(3);
    const origin = screen.getByRole('button', { name: 'Origin · Issue #1 · example/repo' });
    expect(screen.getByRole('button', { name: 'Repository · example/my_repo' })).toBeTruthy();
    expect(openExternalUrl).not.toHaveBeenCalled();
    origin.focus();
    expect(document.activeElement).toBe(origin);
    fireEvent.click(origin);
    expect(openExternalUrl).toHaveBeenCalledWith('https://github.com/example/repo/issues/1');
    fireEvent.click(screen.getByRole('button', { name: 'PR #2 · example/repo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Repository · example/my_repo' }));
    expect(openExternalUrl).toHaveBeenCalledWith('https://github.com/example/repo/pull/2');
    expect(openExternalUrl).toHaveBeenCalledWith('https://github.com/example/my_repo');
  });

  it('refreshes automatically and ignores responses from an old session or after unmount', async () => {
    vi.useFakeTimers();
    try {
      let oldResolve!: (value: unknown[]) => void;
      let lateResolve!: (value: unknown[]) => void;
      const getSessionLinks = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { oldResolve = resolve; }))
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ url: 'https://github.com/example/repo', kind: 'repository', source: 'output' }])
        .mockImplementationOnce(() => new Promise((resolve) => { lateResolve = resolve; }));
      window.spawneaApi = { getSessionLinks, openExternalUrl: vi.fn() } as never;
      const view = render(<SessionLinkButtons sessionId="one" active />);
      view.rerender(<SessionLinkButtons sessionId="two" active />);
      await act(async () => oldResolve([{ url: 'https://github.com/example/old/pull/1', kind: 'pull', source: 'output' }]));
      expect(view.container.firstChild).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
      expect(screen.getByRole('button', { name: 'Repository · example/repo' })).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
      view.unmount();
      await act(async () => lateResolve([{ url: 'https://github.com/example/other', kind: 'repository', source: 'output' }]));
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
