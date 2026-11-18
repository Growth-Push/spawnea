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
    expect(await screen.findByRole('button', { name: /PR #2 · example\/repo/ })).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(3);
    const origin = screen.getByRole('button', { name: /Origin · Issue #1 · example\/repo/ });
    expect(screen.getByRole('button', { name: 'Repository · example/my_repo' })).toBeTruthy();
    expect(openExternalUrl).not.toHaveBeenCalled();
    origin.focus();
    expect(document.activeElement).toBe(origin);
    fireEvent.click(origin);
    expect(openExternalUrl).toHaveBeenCalledWith('https://github.com/example/repo/issues/1');
    fireEvent.click(screen.getByRole('button', { name: /PR #2 · example\/repo/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Repository · example/my_repo' }));
    expect(openExternalUrl).toHaveBeenCalledWith('https://github.com/example/repo/pull/2');
    expect(openExternalUrl).toHaveBeenCalledWith('https://github.com/example/my_repo');
  });

  it('shows independent PR and CI states, and ignores status from a departed session', async () => {
    const url = 'https://github.com/example/long-repository-name/pull/2';
    let resolveOld!: (value: unknown) => void;
    const getSessionLinkStatuses = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ [url]: { freshness: 'fresh', state: 'merged', ci: 'failed', expiresAt: Date.now() + 60_000 } });
    const openExternalUrl = vi.fn().mockResolvedValue(undefined);
    const cancelSessionLinkStatuses = vi.fn().mockResolvedValue(undefined);
    window.spawneaApi = {
      getSessionLinks: vi.fn().mockResolvedValue([{ url, kind: 'pull', source: 'task' }]),
      getSessionLinkStatuses, cancelSessionLinkStatuses, openExternalUrl,
    } as never;

    const view = render(<SessionLinkButtons sessionId="one" active />);
    const oldRequestId = getSessionLinkStatuses.mock.calls[0][1];
    view.rerender(<SessionLinkButtons sessionId="two" active />);
    expect(cancelSessionLinkStatuses).toHaveBeenCalledWith('one', oldRequestId);
    expect(getSessionLinkStatuses.mock.calls[1]).toEqual(['two', expect.any(Number)]);
    expect(getSessionLinkStatuses.mock.calls[1][1]).not.toBe(oldRequestId);
    const accessibleName = 'PR #2 · example/long-repository-name · Merged · CI failed';
    const button = await screen.findByRole('button', { name: accessibleName });
    expect(button.getAttribute('title')).toBe(accessibleName);
    expect([...button.children].slice(0, 2).map((icon) => icon.tagName)).toEqual(['svg', 'svg']);
    expect(button.lastElementChild?.textContent).toBe('example/long-repository-name');
    await act(async () => resolveOld({ [url]: { freshness: 'fresh', state: 'open', ci: 'passed', expiresAt: Date.now() + 60_000 } }));
    expect(screen.getByRole('button', { name: accessibleName })).toBe(button);
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(openExternalUrl).toHaveBeenCalledWith(url);
  });

  it.each([['visibility', 61_000], ['activation', 59_000]] as const)(
    'expires CI at its original deadline after %s resumes with a lookup still pending',
    async (resume, elapsed) => {
      vi.useFakeTimers();
      let visibility: DocumentVisibilityState = 'visible';
      const visibilitySpy = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
      try {
        const now = Date.now();
        const url = 'https://github.com/example/repo/pull/2';
        let resolveNext!: (value: unknown) => void;
        const getSessionLinkStatuses = vi.fn()
          .mockResolvedValueOnce({ [url]: { freshness: 'fresh', state: 'open', ci: 'passed', expiresAt: now + 60_000 } })
          .mockImplementationOnce(() => new Promise((resolve) => { resolveNext = resolve; }));
        window.spawneaApi = {
          getSessionLinks: vi.fn().mockResolvedValue([{ url, kind: 'pull', source: 'task' }]),
          getSessionLinkStatuses, openExternalUrl: vi.fn(),
        } as never;

        const view = render(<SessionLinkButtons sessionId="one" active />);
        await act(async () => {});
        expect(screen.getByRole('button', { name: /Open · CI passed$/ })).toBeTruthy();
        if (resume === 'visibility') {
          visibility = 'hidden';
          fireEvent(document, new Event('visibilitychange'));
        } else {
          view.rerender(<SessionLinkButtons sessionId="one" active={false} />);
        }
        vi.setSystemTime(now + elapsed);
        if (resume === 'visibility') {
          visibility = 'visible';
          await act(async () => { fireEvent(document, new Event('visibilitychange')); });
        } else {
          view.rerender(<SessionLinkButtons sessionId="one" active />);
        }
        expect(getSessionLinkStatuses).toHaveBeenCalledTimes(2);
        if (elapsed < 60_000) {
          expect(screen.getByRole('button', { name: /Open · CI passed$/ })).toBeTruthy();
          await act(async () => { await vi.advanceTimersByTimeAsync(60_000 - elapsed); });
        }
        expect(screen.getByRole('button', { name: /CI passed · GitHub status is stale$/ })).toBeTruthy();

        await act(async () => resolveNext({ [url]: { freshness: 'fresh', state: 'open', ci: 'pending', expiresAt: Date.now() + 60_000 } }));
        expect(screen.getByRole('button', { name: /Open · CI pending or in progress$/ })).toBeTruthy();
        view.unmount();
      } finally {
        visibilitySpy.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it.each(['hide', 'deactivate'] as const)('cancels a pending request on %s and ignores it after resuming the same session', async (action) => {
    let visibility: DocumentVisibilityState = 'visible';
    const visibilitySpy = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const url = 'https://github.com/example/repo/pull/2';
    let resolveOld!: (value: unknown) => void;
    let resolveNew!: (value: unknown) => void;
    const getSessionLinkStatuses = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve; }));
    const cancelSessionLinkStatuses = vi.fn().mockResolvedValue(undefined);
    window.spawneaApi = {
      getSessionLinks: vi.fn().mockResolvedValue([{ url, kind: 'pull', source: 'task' }]),
      getSessionLinkStatuses, cancelSessionLinkStatuses, openExternalUrl: vi.fn(),
    } as never;

    const view = render(<SessionLinkButtons sessionId="one" active />);
    try {
      const firstId = getSessionLinkStatuses.mock.calls[0][1];
      if (action === 'hide') {
        visibility = 'hidden';
        fireEvent(document, new Event('visibilitychange'));
      } else {
        view.rerender(<SessionLinkButtons sessionId="one" active={false} />);
      }
      expect(cancelSessionLinkStatuses).toHaveBeenCalledExactlyOnceWith('one', firstId);

      if (action === 'hide') {
        visibility = 'visible';
        fireEvent(document, new Event('visibilitychange'));
      } else {
        view.rerender(<SessionLinkButtons sessionId="one" active />);
      }
      expect(getSessionLinkStatuses).toHaveBeenCalledTimes(2);
      expect(getSessionLinkStatuses.mock.calls[1][1]).not.toBe(firstId);
      await act(async () => resolveOld({ [url]: { freshness: 'fresh', state: 'open', ci: 'passed', expiresAt: Date.now() + 60_000 } }));
      expect(screen.queryByRole('button', { name: /CI passed/ })).toBeNull();
      await act(async () => resolveNew({ [url]: { freshness: 'fresh', state: 'open', ci: 'pending', expiresAt: Date.now() + 60_000 } }));
      expect(screen.getByRole('button', { name: /Open · CI pending or in progress$/ })).toBeTruthy();
    } finally {
      view.unmount();
      visibilitySpy.mockRestore();
    }
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
