import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Artifact } from '@spawnea/domain';
import { ArtifactPreviewModal } from './ArtifactPreviewModal';

const artifact: Artifact = { id: 'one', sessionId: 'one', direction: 'output', remotePath: '/fixture/one.txt', filename: 'one.txt', mimeType: 'text/plain', sizeBytes: 4, createdAt: new Date() };

describe('ArtifactPreviewModal lifecycle', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('restarts copy feedback and clears it on close and reopen', () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    window.spawneaApi = {} as typeof window.spawneaApi;
    const view = render(<ArtifactPreviewModal artifact={artifact} sessionId="one" onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('copy-remote-path-button'));
    act(() => vi.advanceTimersByTime(1500));
    fireEvent.click(screen.getByTestId('copy-remote-path-button'));
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByTestId('copy-remote-path-button').textContent).toBe('Copied');
    view.rerender(<ArtifactPreviewModal artifact={null} sessionId="one" onClose={vi.fn()} />);
    view.rerender(<ArtifactPreviewModal artifact={artifact} sessionId="one" onClose={vi.fn()} />);
    expect(screen.getByTestId('copy-remote-path-button').textContent).toBe('Remote Path');
    view.unmount();
  });

  it('ignores a late save failure after switching artifacts', async () => {
    let rejectSave!: (error: Error) => void;
    window.spawneaApi = { saveArtifactAs: vi.fn().mockReturnValue(new Promise((_resolve, reject) => { rejectSave = reject; })) } as unknown as typeof window.spawneaApi;
    const view = render(<ArtifactPreviewModal artifact={artifact} sessionId="one" onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('save-artifact-button'));
    view.rerender(<ArtifactPreviewModal artifact={{ ...artifact, id: 'two', filename: 'two.txt' }} sessionId="two" onClose={vi.fn()} />);
    await act(async () => { rejectSave(new Error('old failure')); await Promise.resolve(); });
    expect(screen.queryByText('old failure')).toBeNull();
    expect((screen.getByTestId('save-artifact-button') as HTMLButtonElement).disabled).toBe(false);
    view.unmount();
  });

  it('consumes a rejected delete callback after closing', async () => {
    window.spawneaApi = {} as typeof window.spawneaApi;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onDelete = vi.fn().mockRejectedValue(new Error('delete failed'));
    const onClose = vi.fn();
    const view = render(<ArtifactPreviewModal artifact={artifact} sessionId="one" onDelete={onDelete} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('delete-artifact-button'));
    await act(async () => { await Promise.resolve(); });
    expect(onDelete).toHaveBeenCalledWith('one');
    expect(onClose).toHaveBeenCalled();
    view.unmount();
  });
});
