import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FileBrowser } from './FileBrowser';
import type { FileEntry, FileContentResult } from '@spawnea/domain';

// Polyfill navigator.clipboard for jsdom
if (typeof navigator !== 'undefined' && !navigator.clipboard) {
  Object.assign(navigator, {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });
}

describe('FileBrowser Component', () => {
  const mockFiles: FileEntry[] = [
    { name: 'src', path: '/repo/src', isDirectory: true, isFile: false, size: 4096, modifiedAt: new Date() },
    { name: 'docs', path: '/repo/docs', isDirectory: true, isFile: false, size: 4096, modifiedAt: new Date() },
    { name: 'package.json', path: '/repo/package.json', isDirectory: false, isFile: true, size: 512, modifiedAt: new Date() },
    { name: 'README.md', path: '/repo/README.md', isDirectory: false, isFile: true, size: 1024, modifiedAt: new Date() },
  ];

  const mockFileContent: FileContentResult = {
    path: '/repo/package.json',
    content: '{\n  "name": "spawnea",\n  "version": "1.0.0"\n}',
    isBinary: false,
    isTruncated: false,
    sizeBytes: 512,
    mimeType: 'application/json',
  };

  beforeEach(() => {
    (window as any).spawneaApi = {
      listFiles: vi.fn().mockResolvedValue(mockFiles),
      readFile: vi.fn().mockResolvedValue(mockFileContent),
    };
  });

  it('renders directory contents and root breadcrumb', async () => {
    render(<FileBrowser sessionId="sess-1" worktreePath="/repo" />);

    await waitFor(() => {
      expect(screen.getByText('repo')).toBeDefined();
      expect(screen.getByText('src')).toBeDefined();
      expect(screen.getByText('docs')).toBeDefined();
      expect(screen.getByText('package.json')).toBeDefined();
      expect(screen.getByText('README.md')).toBeDefined();
    });
  });

  it('filters file list by search input', async () => {
    render(<FileBrowser sessionId="sess-1" worktreePath="/repo" />);

    await waitFor(() => {
      expect(screen.getByText('package.json')).toBeDefined();
    });

    const searchInput = screen.getByTestId('file-search-input');
    fireEvent.change(searchInput, { target: { value: 'READ' } });

    expect(screen.getByText('README.md')).toBeDefined();
    expect(screen.queryByText('package.json')).toBeNull();
  });

  it('navigates into subdirectories and updates breadcrumbs', async () => {
    const srcFiles: FileEntry[] = [
      { name: 'index.ts', path: '/repo/src/index.ts', isDirectory: false, isFile: true, size: 200, modifiedAt: new Date() },
    ];

    (window as any).spawneaApi.listFiles = vi.fn().mockImplementation((_sid, subPath) => {
      if (subPath === 'src') {
        return Promise.resolve(srcFiles);
      }
      return Promise.resolve(mockFiles);
    });

    render(<FileBrowser sessionId="sess-1" worktreePath="/repo" />);

    await waitFor(() => {
      expect(screen.getByText('src')).toBeDefined();
    });

    fireEvent.click(screen.getByText('src'));

    await waitFor(() => {
      expect((window as any).spawneaApi.listFiles).toHaveBeenCalledWith('sess-1', 'src');
      expect(screen.getByText('index.ts')).toBeDefined();
    });
  });

  it('opens preview panel and copies content when clicking a file', async () => {
    render(<FileBrowser sessionId="sess-1" worktreePath="/repo" />);

    await waitFor(() => {
      expect(screen.getByText('package.json')).toBeDefined();
    });

    fireEvent.click(screen.getByText('package.json'));

    await waitFor(() => {
      expect(screen.getByTestId('file-preview-panel')).toBeDefined();
      expect(screen.getByText('JSON')).toBeDefined();
    });

    // Verify copy button
    const copyBtn = screen.getByTestId('copy-file-content-button');
    expect(copyBtn).toBeDefined();

    // Verify click on line number copies path:line
    const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText');
    const lineNumCell = screen.getByTestId('code-line-num-2');
    expect(lineNumCell).toBeDefined();
    fireEvent.click(lineNumCell);
    expect(writeTextSpy).toHaveBeenCalledWith('/repo/package.json:2');
  });
});
