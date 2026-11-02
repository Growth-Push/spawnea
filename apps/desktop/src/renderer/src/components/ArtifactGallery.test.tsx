import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ArtifactGallery } from './ArtifactGallery';
import type { Artifact } from '@spawnea/domain';

// Polyfill navigator.clipboard
if (typeof navigator !== 'undefined' && !navigator.clipboard) {
  Object.assign(navigator, {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });
}

describe('ArtifactGallery Component', () => {
  const mockArtifacts: Artifact[] = [
    {
      id: 'art-1',
      sessionId: 'sess-1',
      direction: 'input',
      remotePath: '/repo/.spawnea/artifacts/screenshot.png',
      cachedLocalPath: '/cache/sess-1/screenshot.png',
      filename: 'screenshot.png',
      mimeType: 'image/png',
      sizeBytes: 10240,
      createdAt: new Date('2026-08-24T12:00:00Z'),
    },
    {
      id: 'art-2',
      sessionId: 'sess-1',
      direction: 'output',
      remotePath: '/repo/TO_DELETE_README.md',
      cachedLocalPath: '/cache/sess-1/TO_DELETE_README.md',
      filename: 'TO_DELETE_README.md',
      mimeType: 'text/markdown',
      sizeBytes: 2048,
      createdAt: new Date('2026-08-24T12:05:00Z'),
    },
  ];

  beforeEach(() => {
    (window as any).spawneaApi = {
      getArtifacts: vi.fn().mockResolvedValue(mockArtifacts),
      getArtifactContent: vi.fn().mockResolvedValue({
        path: '/repo/TO_DELETE_README.md',
        content: '# Test Readme',
        isBinary: false,
        isTruncated: false,
        sizeBytes: 2048,
        mimeType: 'text/markdown',
      }),
      deleteArtifact: vi.fn().mockResolvedValue(true),
      clearArtifacts: vi.fn().mockResolvedValue(2),
      saveArtifactAs: vi.fn().mockResolvedValue(true),
      openArtifactInOs: vi.fn().mockResolvedValue({ opened: true, temporaryCopy: false }),
    };
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
  });

  it('ignores a late clear result after changing sessions', async () => {
    let resolveClear!: (count: number) => void;
    window.spawneaApi.clearArtifacts = vi.fn().mockReturnValue(new Promise<number>((resolve) => { resolveClear = resolve; }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onRefresh = vi.fn();
    const view = render(<ArtifactGallery sessionId="sess-1" artifacts={mockArtifacts} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByTestId('clear-artifacts-button'));
    view.rerender(<ArtifactGallery sessionId="sess-2" artifacts={[]} onRefresh={onRefresh} />);
    await act(async () => { resolveClear(2); await Promise.resolve(); });
    expect(onRefresh).not.toHaveBeenCalled();
    expect(screen.queryByTestId('artifact-gallery-toast')).toBeNull();
    view.unmount();
    vi.restoreAllMocks();
  });

  it('handles a failed deletion started from the preview', async () => {
    window.spawneaApi.deleteArtifact = vi.fn().mockRejectedValue(new Error('delete failed'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const view = render(<ArtifactGallery sessionId="sess-1" artifacts={mockArtifacts} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByTestId('artifact-card-art-2'));
    const modal = await screen.findByTestId('artifact-preview-modal');
    fireEvent.click(within(modal).getByTitle('Delete artifact'));
    await screen.findByText('Unable to delete artifact: delete failed');
    view.unmount();
    vi.restoreAllMocks();
  });

  it('finishes API uploads for the original session after navigation during the first file read', async () => {
    let finishRead!: (value: ArrayBuffer) => void;
    const first = Object.assign(new File(['a'], 'a.txt'), { arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => { finishRead = resolve; }) });
    const second = Object.assign(new File(['b'], 'b.txt'), { arrayBuffer: async () => new Uint8Array([2]).buffer });
    const upload = vi.fn().mockResolvedValue(undefined);
    const newUpload = vi.fn().mockResolvedValue(undefined);
    window.spawneaApi.uploadArtifactData = upload;
    const oldRefresh = vi.fn();
    const newRefresh = vi.fn();
    const view = render(<ArtifactGallery sessionId="sess-1" artifacts={[]} onRefresh={oldRefresh} />);
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [first, second] } });
    view.rerender(<ArtifactGallery sessionId="sess-2" artifacts={[]} onRefresh={newRefresh} />);
    window.spawneaApi.uploadArtifactData = newUpload;
    const timer = vi.spyOn(globalThis, 'setTimeout');
    await act(async () => { finishRead(new Uint8Array([1]).buffer); await Promise.resolve(); });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls.map((call) => [call[0], call[2]])).toEqual([['sess-1', 'a.txt'], ['sess-1', 'b.txt']]);
    expect(newUpload).not.toHaveBeenCalled();
    expect(oldRefresh).not.toHaveBeenCalled();
    expect(newRefresh).not.toHaveBeenCalled();
    expect(screen.queryByTestId('artifact-gallery-toast')).toBeNull();
    expect(timer.mock.calls.some(([, delay]) => delay === 2000 || delay === 3000)).toBe(false);
    view.unmount();
    timer.mockRestore();
  });

  it('resets the input on acceptance and permits the same files in the next session', async () => {
    let finishFirst!: () => void;
    const upload = vi.fn().mockReturnValueOnce(new Promise<void>((resolve) => { finishFirst = resolve; })).mockResolvedValue(undefined);
    window.spawneaApi.uploadArtifactData = upload;
    const file = Object.assign(new File(['a'], 'same.txt'), { arrayBuffer: async () => new Uint8Array([1]).buffer });
    const view = render(<ArtifactGallery sessionId="sess-1" artifacts={[]} onRefresh={vi.fn()} />);
    const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    const setValue = vi.spyOn(input, 'value', 'set');
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
    expect(setValue).toHaveBeenCalledTimes(1);
    expect(setValue).toHaveBeenLastCalledWith('');
    expect(upload).toHaveBeenCalledTimes(1);
    view.rerender(<ArtifactGallery sessionId="sess-2" artifacts={[]} onRefresh={vi.fn()} />);
    expect(view.container.querySelector('input[type="file"]')).toBe(input);
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
    expect(setValue).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls.map((call) => [call[0], call[2]])).toEqual([['sess-1', 'same.txt'], ['sess-2', 'same.txt']]);
    await act(async () => { finishFirst(); await Promise.resolve(); });
    expect(setValue).toHaveBeenCalledTimes(2);
    view.unmount();
    setValue.mockRestore();
  });

  it('continues the original upload callback after unmount between files', async () => {
    let finishFirst!: () => void;
    const upload = vi.fn().mockReturnValueOnce(new Promise<void>((resolve) => { finishFirst = resolve; })).mockResolvedValue(undefined);
    const nextUpload = vi.fn().mockResolvedValue(undefined);
    const refresh = vi.fn();
    const view = render(<ArtifactGallery sessionId="sess-1" artifacts={[]} onRefresh={refresh} onUploadFile={upload} />);
    const files = [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')];
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files } });
    expect(upload).toHaveBeenCalledTimes(1);
    view.rerender(<ArtifactGallery sessionId="sess-2" artifacts={[]} onRefresh={vi.fn()} onUploadFile={nextUpload} />);
    view.unmount();
    const timer = vi.spyOn(globalThis, 'setTimeout');
    await act(async () => { finishFirst(); await Promise.resolve(); });
    expect(upload.mock.calls.map(([file]) => file.name)).toEqual(['a.txt', 'b.txt']);
    expect(nextUpload).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(timer.mock.calls.some(([, delay]) => delay === 2000 || delay === 3000)).toBe(false);
    timer.mockRestore();
  });

  it('continues an API upload batch after unmount between files', async () => {
    let finishFirst!: () => void;
    const upload = vi.fn().mockReturnValueOnce(new Promise<void>((resolve) => { finishFirst = resolve; })).mockResolvedValue(undefined);
    window.spawneaApi.uploadArtifactData = upload;
    const refresh = vi.fn();
    const view = render(<ArtifactGallery sessionId="sess-1" artifacts={[]} onRefresh={refresh} />);
    const file = (name: string) => Object.assign(new File(['x'], name), { arrayBuffer: async () => new Uint8Array([1]).buffer });
    await act(async () => { fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [file('a.txt'), file('b.txt')] } }); });
    expect(upload).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => { finishFirst(); await Promise.resolve(); });
    expect(upload.mock.calls.map((call) => [call[0], call[2]])).toEqual([['sess-1', 'a.txt'], ['sess-1', 'b.txt']]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('handles an upload rejection after unmount without stale refresh or feedback', async () => {
    let rejectUpload!: (error: Error) => void;
    const upload = vi.fn().mockReturnValue(new Promise<void>((_resolve, reject) => { rejectUpload = reject; }));
    const refresh = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = render(<ArtifactGallery sessionId="sess-1" artifacts={[]} onRefresh={refresh} onUploadFile={upload} />);
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(['a'], 'a.txt')] } });
    view.unmount();
    const timer = vi.spyOn(globalThis, 'setTimeout');
    await act(async () => { rejectUpload(new Error('upload failed')); await Promise.resolve(); });
    expect(refresh).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(timer.mock.calls.some(([, delay]) => delay === 2000 || delay === 3000)).toBe(false);
    timer.mockRestore();
    error.mockRestore();
  });

  it('renders artifact cards and counts in filter chips', () => {
    render(<ArtifactGallery sessionId="sess-1" artifacts={mockArtifacts} onRefresh={vi.fn()} />);

    expect(screen.getByText('All (2)')).toBeDefined();
    expect(screen.getByText('Inputs (1)')).toBeDefined();
    expect(screen.getByText('Outputs (1)')).toBeDefined();
    expect(screen.getByText('screenshot.png')).toBeDefined();
    expect(screen.getByText('TO_DELETE_README.md')).toBeDefined();
  });

  it('filters artifacts by direction', () => {
    render(<ArtifactGallery sessionId="sess-1" artifacts={mockArtifacts} onRefresh={vi.fn()} />);

    fireEvent.click(screen.getByTestId('filter-artifacts-input'));
    expect(screen.getByText('screenshot.png')).toBeDefined();
    expect(screen.queryByText('TO_DELETE_README.md')).toBeNull();

    fireEvent.click(screen.getByTestId('filter-artifacts-output'));
    expect(screen.getByText('TO_DELETE_README.md')).toBeDefined();
    expect(screen.queryByText('screenshot.png')).toBeNull();
  });

  it('searches artifacts by filename', () => {
    render(<ArtifactGallery sessionId="sess-1" artifacts={mockArtifacts} onRefresh={vi.fn()} />);

    const searchInput = screen.getByTestId('search-artifacts-input');
    fireEvent.change(searchInput, { target: { value: 'README' } });

    expect(screen.getByText('TO_DELETE_README.md')).toBeDefined();
    expect(screen.queryByText('screenshot.png')).toBeNull();
  });

  it('opens preview modal when clicking an artifact card', async () => {
    render(<ArtifactGallery sessionId="sess-1" artifacts={mockArtifacts} onRefresh={vi.fn()} />);

    fireEvent.click(screen.getByTestId('artifact-card-art-2'));

    await waitFor(() => {
      expect(screen.getByTestId('artifact-preview-modal')).toBeDefined();
      expect(screen.getByText('Test Readme')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('close-artifact-modal-button'));
    expect(screen.queryByTestId('artifact-preview-modal')).toBeNull();
  });

  it('supports hiding and unhiding an artifact card', async () => {
    render(<ArtifactGallery sessionId="sess-1" artifacts={mockArtifacts} onRefresh={vi.fn()} />);

    expect(screen.getByText('screenshot.png')).toBeDefined();

    // Find the hide button specifically on the screenshot card (art-1)
    const cardArt1 = screen.getByTestId('artifact-card-art-1');
    const hideButton = within(cardArt1).getByTitle('Hide artifact');

    // Hide screenshot.png
    fireEvent.click(hideButton);

    // screenshot.png should now be hidden from the default view
    expect(screen.queryByText('screenshot.png')).toBeNull();
    expect(screen.getByText('Hidden (1)')).toBeDefined();

    // Toggle show hidden
    fireEvent.click(screen.getByTestId('filter-artifacts-hidden'));
    expect(screen.getByText('screenshot.png')).toBeDefined();
    expect(screen.getByText('Showing (1) Hidden')).toBeDefined();
  });

  it('opens context menu on right-click and supports blacklisting', async () => {
    const addBlacklistMock = vi.fn().mockResolvedValue(['package-lock.json', 'screenshot.png']);
    (window as any).spawneaApi.addArtifactToBlacklist = addBlacklistMock;

    render(<ArtifactGallery sessionId="sess-1" artifacts={mockArtifacts} onRefresh={vi.fn()} />);

    const card = screen.getByTestId('artifact-card-art-1');
    fireEvent.contextMenu(card, { clientX: 100, clientY: 100 });

    expect(screen.getByTestId('artifact-context-menu')).toBeDefined();
    expect(screen.getByText('Blacklist `screenshot.png`')).toBeDefined();

    fireEvent.click(screen.getByTestId('artifact-context-blacklist-exact'));
    expect(addBlacklistMock).toHaveBeenCalledWith('screenshot.png');
  });

  it('closes a reference preview on session switch without requesting its path for the new session', async () => {
    const getLocalReferenceContent = vi.fn().mockResolvedValue({ path: '/repo/TO_DELETE_README.md', content: 'preview', isBinary: false, isTruncated: false, sizeBytes: 7, mimeType: 'text/plain' });
    window.spawneaApi.getLocalReferenceContext = vi.fn().mockResolvedValue({ workspacePath: '/repo', homePath: '/fictional-host-home', persistedWorkspacePath: '/repo' });
    window.spawneaApi.getArtifactContent = vi.fn();
    window.spawneaApi.getLocalReferenceContent = getLocalReferenceContent;
    const { rerender } = render(<ArtifactGallery sessionId="sess-1" artifacts={mockArtifacts} onRefresh={vi.fn()} />);
    fireEvent.contextMenu(screen.getByTestId('artifact-card-art-2'), { clientX: 100, clientY: 100 });
    await screen.findByRole('menuitem', { name: 'Open in Artifact Preview' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in Artifact Preview' }));
    await screen.findByTestId('artifact-preview-modal');
    await waitFor(() => expect(getLocalReferenceContent).toHaveBeenCalledWith('sess-1', '/repo/TO_DELETE_README.md'));
    const requestCount = getLocalReferenceContent.mock.calls.length;
    rerender(<ArtifactGallery sessionId="sess-2" artifacts={[]} onRefresh={vi.fn()} />);
    expect(screen.queryByTestId('artifact-preview-modal')).toBeNull();
    expect(getLocalReferenceContent).toHaveBeenCalledTimes(requestCount);
  });

  it('requires confirmation before clearing and refreshes after accepting', async () => {
    const confirmMock = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirmMock);
    const refresh = vi.fn();
    localStorage.setItem('spawnea:hiddenArtifacts:sess-1', JSON.stringify(['art-1']));
    render(<ArtifactGallery sessionId="sess-1" artifacts={mockArtifacts} onRefresh={refresh} />);

    fireEvent.click(screen.getByTestId('clear-artifacts-button'));
    expect(confirmMock).toHaveBeenCalledWith(
      'Clear all 2 artifacts from this session? Remote files will not be deleted.'
    );
    expect(window.spawneaApi.clearArtifacts).not.toHaveBeenCalled();

    confirmMock.mockReturnValue(true);
    fireEvent.click(screen.getByTestId('clear-artifacts-button'));
    await waitFor(() => {
      expect(window.spawneaApi.clearArtifacts).toHaveBeenCalledWith('sess-1');
      expect(refresh).toHaveBeenCalledTimes(1);
    });
    expect(localStorage.getItem('spawnea:hiddenArtifacts:sess-1')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('uses a dense responsive grid for many artifacts', () => {
    render(<ArtifactGallery sessionId="sess-1" artifacts={mockArtifacts} onRefresh={vi.fn()} />);
    expect(screen.getByTestId('artifact-grid').className).toContain('xl:grid-cols-6');
  });

  it('reports when the clear bridge is unavailable', async () => {
    const confirmMock = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirmMock);
    const clearArtifacts = window.spawneaApi.clearArtifacts;
    delete (window.spawneaApi as Partial<Window['spawneaApi']>).clearArtifacts;

    render(<ArtifactGallery sessionId="sess-1" artifacts={mockArtifacts} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByTestId('clear-artifacts-button'));

    await waitFor(() => {
      expect(screen.getByText('Artifact clearing is unavailable in this app version')).toBeDefined();
    });
    expect(confirmMock).toHaveBeenCalledTimes(1);
    (window.spawneaApi as Window['spawneaApi']).clearArtifacts = clearArtifacts;
    vi.unstubAllGlobals();
  });
});
