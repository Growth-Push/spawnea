import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
      saveArtifactAs: vi.fn().mockResolvedValue(true),
      openArtifactInOs: vi.fn().mockResolvedValue(true),
    };
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
  });

  it('renders artifact cards and counts in filter chips', () => {
    render(<ArtifactGallery sessionId="sess-1" artifacts={mockArtifacts} />);

    expect(screen.getByText('All (2)')).toBeDefined();
    expect(screen.getByText('Inputs (1)')).toBeDefined();
    expect(screen.getByText('Outputs (1)')).toBeDefined();
    expect(screen.getByText('screenshot.png')).toBeDefined();
    expect(screen.getByText('TO_DELETE_README.md')).toBeDefined();
  });

  it('filters artifacts by direction', () => {
    render(<ArtifactGallery sessionId="sess-1" artifacts={mockArtifacts} />);

    fireEvent.click(screen.getByTestId('filter-artifacts-input'));
    expect(screen.getByText('screenshot.png')).toBeDefined();
    expect(screen.queryByText('TO_DELETE_README.md')).toBeNull();

    fireEvent.click(screen.getByTestId('filter-artifacts-output'));
    expect(screen.getByText('TO_DELETE_README.md')).toBeDefined();
    expect(screen.queryByText('screenshot.png')).toBeNull();
  });

  it('searches artifacts by filename', () => {
    render(<ArtifactGallery sessionId="sess-1" artifacts={mockArtifacts} />);

    const searchInput = screen.getByTestId('search-artifacts-input');
    fireEvent.change(searchInput, { target: { value: 'README' } });

    expect(screen.getByText('TO_DELETE_README.md')).toBeDefined();
    expect(screen.queryByText('screenshot.png')).toBeNull();
  });

  it('opens preview modal when clicking an artifact card', async () => {
    render(<ArtifactGallery sessionId="sess-1" artifacts={mockArtifacts} />);

    fireEvent.click(screen.getByTestId('artifact-card-art-2'));

    await waitFor(() => {
      expect(screen.getByTestId('artifact-preview-modal')).toBeDefined();
      expect(screen.getByText('Test Readme')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('close-artifact-modal-button'));
    expect(screen.queryByTestId('artifact-preview-modal')).toBeNull();
  });

  it('supports hiding and unhiding an artifact card', async () => {
    render(<ArtifactGallery sessionId="sess-1" artifacts={mockArtifacts} />);

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

    render(<ArtifactGallery sessionId="sess-1" artifacts={mockArtifacts} />);

    const card = screen.getByTestId('artifact-card-art-1');
    fireEvent.contextMenu(card, { clientX: 100, clientY: 100 });

    expect(screen.getByTestId('artifact-context-menu')).toBeDefined();
    expect(screen.getByText('Blacklist `screenshot.png`')).toBeDefined();

    fireEvent.click(screen.getByTestId('artifact-context-blacklist-exact'));
    expect(addBlacklistMock).toHaveBeenCalledWith('screenshot.png');
  });
});
