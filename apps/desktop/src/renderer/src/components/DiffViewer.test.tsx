import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DiffViewer } from './DiffViewer';
import { GitStatusView } from './GitStatusView';
import type { GitStatusResult, GitDiffResult } from '@spawnea/domain';

// Polyfill navigator.clipboard for jsdom
if (typeof navigator !== 'undefined' && !navigator.clipboard) {
  Object.assign(navigator, {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });
}

describe('DiffViewer Component', () => {
  const sampleDiffResult: GitDiffResult = {
    rawDiff: 'diff --git a/src/App.tsx b/src/App.tsx\n--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,2 +1,3 @@\n-old code\n+new code\n+extra line\n',
    files: [
      {
        path: 'src/App.tsx',
        additions: 2,
        deletions: 1,
        isBinary: false,
        isNew: false,
        isDeleted: false,
        isRenamed: false,
        hunks: [
          {
            header: '@@ -1,2 +1,3 @@',
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 3,
            lines: [
              { type: 'delete', content: 'old code', oldLineNumber: 1 },
              { type: 'add', content: 'new code', newLineNumber: 1 },
              { type: 'add', content: 'extra line', newLineNumber: 2 },
            ],
          },
        ],
      },
    ],
    totalAdditions: 2,
    totalDeletions: 1,
    totalFilesChanged: 1,
  };

  it('renders diff files, addition/deletion counters, and line contents', () => {
    render(<DiffViewer diffResult={sampleDiffResult} />);

    expect(screen.getByText('src/App.tsx')).toBeDefined();
    expect(screen.getByText('+2')).toBeDefined();
    expect(screen.getByText('-1')).toBeDefined();
    expect(screen.getByText('old code')).toBeDefined();
    expect(screen.getByText('new code')).toBeDefined();
    expect(screen.getByText('extra line')).toBeDefined();
  });

  it('copies raw diff to clipboard on button click', () => {
    const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText');
    render(<DiffViewer diffResult={sampleDiffResult} />);

    const copyBtn = screen.getByTestId('copy-diff-button');
    fireEvent.click(copyBtn);

    expect(writeTextSpy).toHaveBeenCalledWith(sampleDiffResult.rawDiff);
    expect(screen.getByText('Copied')).toBeDefined();
  });

  it('copies path:line reference to clipboard when clicking a line number', () => {
    const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText');
    render(<DiffViewer diffResult={sampleDiffResult} worktreePath="/workspace" />);

    // Click on new line number '2' for 'extra line'
    const lineNumCell = screen.getByTitle('Click to copy "/workspace/src/App.tsx:2"');
    expect(lineNumCell).toBeDefined();
    fireEvent.click(lineNumCell);

    expect(writeTextSpy).toHaveBeenCalledWith('/workspace/src/App.tsx:2');
  });

  it('renders empty clean state when diff has no changes', () => {
    render(
      <DiffViewer
        diffResult={{
          rawDiff: '',
          files: [],
          totalAdditions: 0,
          totalDeletions: 0,
          totalFilesChanged: 0,
        }}
      />
    );

    expect(screen.getByText('No Git changes detected')).toBeDefined();
  });
});

describe('GitStatusView Component', () => {
  const mockStatus: GitStatusResult = {
    isGitRepo: true,
    branch: 'feat/pilot3',
    trackingBranch: 'origin/feat/pilot3',
    ahead: 2,
    behind: 0,
    isClean: false,
    staged: [{ path: 'src/staged.ts', status: 'added', staged: true, statusCode: 'A' }],
    unstaged: [{ path: 'src/modified.ts', status: 'modified', staged: false, statusCode: 'M' }],
    untracked: [{ path: 'scratch.txt', status: 'untracked', staged: false, statusCode: '??' }],
    totalChanges: 3,
  };

  it('renders branch name, upstream tracking info, and ahead indicator', () => {
    render(
      <GitStatusView
        status={mockStatus}
        selectedFilePath={null}
        onSelectFile={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.getByText('feat/pilot3')).toBeDefined();
    expect(screen.getByText('origin/feat/pilot3')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
    expect(screen.getByText('3 changes')).toBeDefined();
  });

  it('categorizes staged, unstaged, and untracked files with status badges', () => {
    const onSelectFile = vi.fn();
    render(
      <GitStatusView
        status={mockStatus}
        selectedFilePath={null}
        onSelectFile={onSelectFile}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.getByText('Staged Changes')).toBeDefined();
    expect(screen.getByText('src/staged.ts')).toBeDefined();
    expect(screen.getByText('A')).toBeDefined();

    expect(screen.getByText('Unstaged Changes')).toBeDefined();
    expect(screen.getByText('src/modified.ts')).toBeDefined();
    expect(screen.getByText('M')).toBeDefined();

    expect(screen.getByText('Untracked Files')).toBeDefined();
    expect(screen.getByText('scratch.txt')).toBeDefined();
    expect(screen.getByText('??')).toBeDefined();

    // Clicking a file calls onSelectFile
    fireEvent.click(screen.getByText('src/modified.ts'));
    expect(onSelectFile).toHaveBeenCalledWith('src/modified.ts');
  });

  it('displays clean repository indicator when clean', () => {
    render(
      <GitStatusView
        status={{
          isGitRepo: true,
          branch: 'main',
          ahead: 0,
          behind: 0,
          isClean: true,
          staged: [],
          unstaged: [],
          untracked: [],
          totalChanges: 0,
        }}
        selectedFilePath={null}
        onSelectFile={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.getByText('Clean')).toBeDefined();
  });

  it('displays non-git repository banner when not a git repo', () => {
    render(
      <GitStatusView
        status={{
          isGitRepo: false,
          branch: '',
          ahead: 0,
          behind: 0,
          isClean: true,
          staged: [],
          unstaged: [],
          untracked: [],
          totalChanges: 0,
        }}
        selectedFilePath={null}
        onSelectFile={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.getByText('Not a Git repository')).toBeDefined();
  });
});
