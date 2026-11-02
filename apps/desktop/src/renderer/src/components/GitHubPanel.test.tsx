import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Session, GitHubCiResult } from '@spawnea/domain';
import { GitHubPanel } from './GitHubPanel';

const session = { id: 'one', projectId: 'p', originIssueUrl: 'https://github.com/example/repo/issues/1' } as Session;
const result = (sha: string): GitHubCiResult => ({ state: 'successful', sha, repository: 'example/repo', fetchedAt: 'now', checks: [] });

describe('GitHub panel', () => {
  it('blocks overlapping changes and preserves both capabilities including CI opt-out', async () => {
    let finish!: () => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; })).mockResolvedValue(undefined);
    window.spawneaApi = { getGitHubSettings: vi.fn().mockResolvedValue({ trackerEnabled: false, ciEnabled: true }), getSessionLinks: vi.fn().mockResolvedValue([]), setGitHubSettings: save } as never;
    render(<GitHubPanel session={session} mode="links" />);
    const metadata = screen.getByLabelText('GitHub issue metadata for this project') as HTMLInputElement;
    const ci = screen.getByLabelText('GitHub CI for this project') as HTMLInputElement;
    await waitFor(() => expect(ci.checked).toBe(true));
    fireEvent.click(ci);
    await waitFor(() => expect(save).toHaveBeenCalledWith('p', { trackerEnabled: false, ciEnabled: false }));
    expect(metadata.disabled).toBe(true);
    expect(ci.disabled).toBe(true);
    fireEvent.click(metadata);
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(ci.checked).toBe(false);
    expect(metadata.disabled).toBe(false);
    fireEvent.click(metadata);
    await waitFor(() => expect(save).toHaveBeenLastCalledWith('p', { trackerEnabled: true, ciEnabled: false }));
    await waitFor(() => expect(metadata.checked).toBe(true));
    expect(ci.checked).toBe(false);
  });

  it('shows a rejected save and allows a retry without changing the other setting', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
    window.spawneaApi = { getGitHubSettings: vi.fn().mockResolvedValue({ trackerEnabled: true, ciEnabled: false }), getSessionLinks: vi.fn().mockResolvedValue([]), setGitHubSettings: save } as never;
    render(<GitHubPanel session={session} mode="links" />);
    const metadata = screen.getByLabelText('GitHub issue metadata for this project') as HTMLInputElement;
    const ci = screen.getByLabelText('GitHub CI for this project') as HTMLInputElement;
    await waitFor(() => expect(metadata.checked).toBe(true));
    fireEvent.click(ci);
    expect((await screen.findByRole('alert')).textContent).toBe('Could not save GitHub settings.');
    expect(ci.disabled).toBe(false);
    expect(ci.checked).toBe(false);
    fireEvent.click(ci);
    await waitFor(() => expect(ci.checked).toBe(true));
    expect(metadata.checked).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ignores a late save after switching sessions and on unmount', async () => {
    let finish!: () => void;
    const save = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    window.spawneaApi = { getGitHubSettings: vi.fn().mockResolvedValue({ trackerEnabled: false, ciEnabled: false }), getSessionLinks: vi.fn().mockResolvedValue([]), setGitHubSettings: save } as never;
    const view = render(<GitHubPanel session={session} mode="links" />);
    const metadata = screen.getByLabelText('GitHub issue metadata for this project') as HTMLInputElement;
    await waitFor(() => expect(metadata.disabled).toBe(false));
    fireEvent.click(metadata);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    view.rerender(<GitHubPanel session={{ ...session, id: 'two', projectId: 'other' }} mode="links" />);
    await waitFor(() => expect(metadata.disabled).toBe(false));
    await act(async () => finish());
    expect(metadata.checked).toBe(false);
    expect(metadata.disabled).toBe(false);
    fireEvent.click(metadata);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    view.unmount();
    await act(async () => finish());
  });

  it('waits for an old panel save before loading the same project in a new panel', async () => {
    let finish!: () => void;
    let saved = { trackerEnabled: false, ciEnabled: true };
    const save = vi.fn().mockImplementation((_project, next) => new Promise<void>((resolve) => { finish = () => { saved = next; resolve(); }; }));
    const read = vi.fn().mockImplementation(async () => ({ ...saved }));
    window.spawneaApi = { getGitHubSettings: read, getSessionLinks: vi.fn().mockResolvedValue([]), setGitHubSettings: save } as never;
    const view = render(<GitHubPanel session={session} mode="links" />);
    const ci = screen.getByLabelText('GitHub CI for this project') as HTMLInputElement;
    await waitFor(() => expect(ci.checked).toBe(true));
    fireEvent.click(ci);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    view.unmount();
    render(<GitHubPanel session={{ ...session, id: 'another' }} mode="links" />);
    const metadata = screen.getByLabelText('GitHub issue metadata for this project') as HTMLInputElement;
    expect(metadata.disabled).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await waitFor(() => expect(metadata.disabled).toBe(false));
    expect((screen.getByLabelText('GitHub CI for this project') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(metadata);
    await waitFor(() => expect(save).toHaveBeenLastCalledWith('p', { trackerEnabled: true, ciEnabled: false }));
    await act(async () => finish());
  });

  it('reloads a concurrently mounted panel instead of sending its stale settings', async () => {
    let finish!: () => void;
    let saved = { trackerEnabled: false, ciEnabled: true };
    const save = vi.fn().mockImplementation((_project, next) => new Promise<void>((resolve) => { finish = () => { saved = next; resolve(); }; }));
    window.spawneaApi = { getGitHubSettings: vi.fn().mockImplementation(async () => ({ ...saved })), getSessionLinks: vi.fn().mockResolvedValue([]), setGitHubSettings: save } as never;
    const first = render(<GitHubPanel session={session} mode="links" />);
    const second = render(<GitHubPanel session={{ ...session, id: 'two' }} mode="links" />);
    const ci = within(first.container).getByLabelText('GitHub CI for this project') as HTMLInputElement;
    const metadata = within(second.container).getByLabelText('GitHub issue metadata for this project') as HTMLInputElement;
    await waitFor(() => expect(ci.checked && !metadata.disabled).toBe(true));
    fireEvent.click(ci);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    fireEvent.click(metadata);
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(await within(second.container).findByRole('alert')).toBeTruthy();
    expect((within(second.container).getByLabelText('GitHub CI for this project') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(metadata);
    await waitFor(() => expect(save).toHaveBeenLastCalledWith('p', { trackerEnabled: true, ciEnabled: false }));
    await act(async () => finish());
  });
  it('keeps shortcuts available without a provider and opens only on an explicit action', async () => {
    const openExternalUrl = vi.fn();
    window.spawneaApi = { getGitHubSettings: vi.fn().mockResolvedValue({ trackerEnabled: false, ciEnabled: false }), getSessionLinks: vi.fn().mockResolvedValue([{ url: 'https://github.com/example/repo/pull/2', kind: 'pull', source: 'output' }]), openExternalUrl, writeClipboardText: vi.fn() } as never;
    render(<GitHubPanel session={session} mode="links" />);
    expect(await screen.findByText(/Metadata disabled/)).toBeTruthy();
    expect(await screen.findByText(/pull\/2/)).toBeTruthy();
    expect(openExternalUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByText('Open')[0]);
    expect(openExternalUrl).toHaveBeenCalledWith(session.originIssueUrl);
  });

  it('discards older responses after the target changes', async () => {
    let resolveFirst!: (value: GitHubCiResult) => void;
    const first = new Promise<GitHubCiResult>((resolve) => { resolveFirst = resolve; });
    const getGitHubCi = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(result('new'));
    const cancelGitHubCi = vi.fn().mockResolvedValue(undefined);
    window.spawneaApi = { getGitHubSettings: vi.fn().mockResolvedValue({ trackerEnabled: false, ciEnabled: true }), getSessionLinks: vi.fn().mockResolvedValue([{ url: 'https://github.com/example/repo/pull/2', kind: 'pull', source: 'output' }]), getGitHubCi, cancelGitHubCi, openExternalUrl: vi.fn(), writeClipboardText: vi.fn() } as never;
    render(<GitHubPanel session={session} mode="ci" />);
    await waitFor(() => expect(getGitHubCi).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('CI target'), { target: { value: 'https://github.com/example/repo/pull/2' } });
    expect(await screen.findByText(/Checked commit: new/)).toBeTruthy();
    expect(cancelGitHubCi).toHaveBeenCalledWith(getGitHubCi.mock.calls[0][2]);
    await act(async () => resolveFirst(result('old')));
    expect(screen.queryByText(/Checked commit: old/)).toBeNull();
  });

  it('lets slow refreshes finish across automatic polling ticks', async () => {
    vi.useFakeTimers();
    try {
      const getGitHubCi = vi.fn().mockImplementation(() => new Promise<GitHubCiResult>((resolve) => {
        setTimeout(() => resolve(result('slow')), 65000);
      }));
      const cancelGitHubCi = vi.fn().mockResolvedValue(undefined);
      window.spawneaApi = { getGitHubSettings: vi.fn().mockResolvedValue({ trackerEnabled: false, ciEnabled: true }), getSessionLinks: vi.fn().mockResolvedValue([]), getGitHubCi, cancelGitHubCi, openExternalUrl: vi.fn(), writeClipboardText: vi.fn() } as never;
      const view = render(<GitHubPanel session={session} mode="ci" />);
      await act(async () => {});
      expect(getGitHubCi).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(65000); });
      expect(getGitHubCi).toHaveBeenCalledTimes(1);
      expect(cancelGitHubCi).not.toHaveBeenCalled();
      expect(screen.getByText(/Checked commit: slow/)).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(125000); });
      expect(getGitHubCi).toHaveBeenCalledTimes(2);
      expect(cancelGitHubCi).not.toHaveBeenCalled();
      expect(screen.getByText(/Checked commit: slow/)).toBeTruthy();
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still cancels an in-flight request on an explicit manual refresh', async () => {
    const getGitHubCi = vi.fn().mockImplementationOnce(() => new Promise<GitHubCiResult>(() => {})).mockResolvedValueOnce(result('manual'));
    const cancelGitHubCi = vi.fn().mockResolvedValue(undefined);
    window.spawneaApi = { getGitHubSettings: vi.fn().mockResolvedValue({ trackerEnabled: false, ciEnabled: true }), getSessionLinks: vi.fn().mockResolvedValue([]), getGitHubCi, cancelGitHubCi, openExternalUrl: vi.fn(), writeClipboardText: vi.fn() } as never;
    render(<GitHubPanel session={session} mode="ci" />);
    await waitFor(() => expect(getGitHubCi).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh CI' }));
    expect(await screen.findByText(/Checked commit: manual/)).toBeTruthy();
    expect(cancelGitHubCi).toHaveBeenCalledWith(getGitHubCi.mock.calls[0][2]);
  });
});
