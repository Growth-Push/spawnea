import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilePreview } from './FilePreview';

const file = { path: '/example/a.txt', content: 'first\nsecond', isBinary: false, isTruncated: false, sizeBytes: 12 };

describe('FilePreview lifecycle', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('keeps repeated copy feedback visible for the latest action', () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const view = render(<FilePreview file={file} isLoading={false} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('copy-file-path-button'));
    act(() => vi.advanceTimersByTime(1500));
    fireEvent.click(screen.getByTestId('copy-file-path-button'));
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByTestId('copy-file-path-button').textContent).toContain('Copied Path');
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByTestId('copy-file-path-button').textContent).toBe('Path');
    view.unmount();
  });

  it('ignores a promotion result after switching files', async () => {
    let resolvePromotion!: () => void;
    window.spawneaApi = { promoteToArtifact: vi.fn().mockReturnValue(new Promise<void>((resolve) => { resolvePromotion = resolve; })) } as unknown as typeof window.spawneaApi;
    const view = render(<FilePreview file={file} sessionId="one" isLoading={false} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('promote-to-artifact-button'));
    view.rerender(<FilePreview file={{ ...file, path: '/example/b.txt' }} sessionId="two" isLoading={false} onClose={vi.fn()} />);
    await act(async () => { resolvePromotion(); await Promise.resolve(); });
    expect(screen.getByTestId('promote-to-artifact-button').textContent).toBe('Promote');
    view.unmount();
  });
});
