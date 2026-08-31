import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { WorkspaceTabs } from './WorkspaceTabs';
import type { Session, Artifact } from '@spawnea/domain';

// Polyfill matchMedia, ResizeObserver, Canvas
if (typeof window !== 'undefined') {
  window.matchMedia =
    window.matchMedia ||
    (() => ({
      matches: false,
      media: '',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

  global.ResizeObserver =
    global.ResizeObserver ||
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };

  HTMLCanvasElement.prototype.getContext =
    HTMLCanvasElement.prototype.getContext ||
    (() => ({
      fillRect: vi.fn(),
      clearRect: vi.fn(),
      getImageData: vi.fn(),
      putImageData: vi.fn(),
      createImageData: vi.fn(),
      setTransform: vi.fn(),
      drawImage: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      measureText: vi.fn().mockReturnValue({ width: 10 }),
    }));
}

describe('WorkspaceTabs Component', () => {
  const mockSession: Session = {
    id: 'sess-1',
    name: 'Feature Auth Session',
    serverId: 'srv-1',
    projectId: 'proj-1',
    agentId: 'agent-claude',
    task: 'Implement JWT authentication',
    worktreePath: '/srv/code/backend-api/worktrees/auth',
    branch: 'feat/jwt-auth',
    managedWorktree: true,
    tmuxSessionName: 'spawnea-auth',
    status: 'working',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastActivityAt: new Date('2026-01-01T01:00:00Z'),
  };

  const mockOutputArtifact: Artifact = {
    id: 'art-output-1',
    sessionId: 'sess-1',
    direction: 'output',
    remotePath: '/srv/code/backend-api/worktrees/auth/summary.md',
    filename: 'summary.md',
    mimeType: 'text/markdown',
    sizeBytes: 1024,
    createdAt: new Date(),
  };

  let artifactCreatedCb: (sessionId: string, artifact: Artifact) => void = () => {};

  beforeEach(() => {
    (window as any).spawneaApi = {
      getArtifacts: vi.fn().mockResolvedValue([]),
      getGitStatus: vi.fn().mockResolvedValue({
        isGitRepo: true,
        branch: 'feat/jwt-auth',
        ahead: 0,
        behind: 0,
        isClean: true,
        staged: [],
        unstaged: [],
        untracked: [],
        totalChanges: 0,
      }),
      getGitDiff: vi.fn().mockResolvedValue({
        rawDiff: '',
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
        totalFilesChanged: 0,
      }),
      listFiles: vi.fn().mockResolvedValue([]),
      getHostSystemInfo: vi.fn().mockResolvedValue(null),
      getHostConnectionState: vi.fn().mockResolvedValue({
        serverId: 'srv-1',
        status: 'connected',
        attempt: 0,
        maxAttempts: 5,
      }),
      retryHostConnection: vi.fn().mockResolvedValue({
        serverId: 'srv-1',
        status: 'connected',
        attempt: 0,
        maxAttempts: 5,
      }),
      onHostConnectionStateChanged: vi.fn().mockReturnValue(() => {}),
      onSessionReconnected: vi.fn().mockReturnValue(() => {}),
      attachSession: vi.fn().mockResolvedValue({ ptyChannelId: 'pty-1' }),
      onPtyData: vi.fn().mockReturnValue(() => {}),
      onPtyExit: vi.fn().mockReturnValue(() => {}),
      onArtifactCreated: vi.fn().mockImplementation((cb) => {
        artifactCreatedCb = cb;
        return () => {};
      }),
    };
  });

  it('renders DetectedOutputBanner only in terminal tab and not in files or diff tabs', async () => {
    const onTabChange = vi.fn();

    const { rerender } = render(
      <WorkspaceTabs
        session={mockSession}
        activeTab="terminal"
        onTabChange={onTabChange}
      />
    );

    // Initial state: no banner
    expect(screen.queryByTestId('detected-output-banner')).toBeNull();

    // Trigger artifactCreated event
    act(() => {
      artifactCreatedCb('sess-1', mockOutputArtifact);
    });

    // Banner is visible in terminal tab
    expect(screen.getByTestId('detected-output-banner')).toBeDefined();
    expect(screen.getByText('summary.md')).toBeDefined();

    // Switch to files tab -> banner should NOT be rendered
    rerender(
      <WorkspaceTabs
        session={mockSession}
        activeTab="files"
        onTabChange={onTabChange}
      />
    );
    expect(screen.queryByTestId('detected-output-banner')).toBeNull();

    // Switch to diff tab -> banner should NOT be rendered
    rerender(
      <WorkspaceTabs
        session={mockSession}
        activeTab="diff"
        onTabChange={onTabChange}
      />
    );
    expect(screen.queryByTestId('detected-output-banner')).toBeNull();

    // Switch back to terminal tab -> banner should be visible again
    rerender(
      <WorkspaceTabs
        session={mockSession}
        activeTab="terminal"
        onTabChange={onTabChange}
      />
    );
    expect(screen.getByTestId('detected-output-banner')).toBeDefined();
  });

  it('identifies managed worktrees in the session context', () => {
    render(
      <WorkspaceTabs
        session={mockSession}
        activeTab="terminal"
        onTabChange={vi.fn()}
      />
    );

    expect(screen.getByTestId('workspace-worktree-badge')).toBeDefined();
  });

  it('shows the MCP source badge from session metadata', () => {
    render(
      <WorkspaceTabs
        session={{ ...mockSession, creationSource: 'mcp' }}
        activeTab="terminal"
        onTabChange={vi.fn()}
      />
    );

    expect(screen.getByTestId('mcp-session-badge').textContent).toBe('MCP');
    expect(screen.getByRole('img', { name: 'Created through Spawnea MCP' })).toBeDefined();
  });

  it('does not show an MCP badge for a UI-created session', () => {
    render(
      <WorkspaceTabs
        session={{ ...mockSession, creationSource: 'ui' }}
        activeTab="terminal"
        onTabChange={vi.fn()}
      />
    );

    expect(screen.queryByTestId('mcp-session-badge')).toBeNull();
  });

  it('marks a managed worktree when it has uncommitted Git changes', () => {
    render(
      <WorkspaceTabs
        session={mockSession}
        activeTab="terminal"
        onTabChange={vi.fn()}
        hasUncommittedChanges
      />
    );

    const badge = screen.getByTestId('workspace-worktree-badge');
    expect(screen.getByTestId('workspace-worktree-dirty-indicator')).toBeDefined();
    expect(badge.getAttribute('title')).toContain('Uncommitted Git changes');
  });

  it('shows the same dirty indicator for a non-managed session', () => {
    const nonManagedSession = { ...mockSession, managedWorktree: false };

    render(
      <WorkspaceTabs
        session={nonManagedSession}
        activeTab="terminal"
        onTabChange={vi.fn()}
        hasUncommittedChanges
      />
    );

    expect(screen.queryByTestId('workspace-worktree-badge')).toBeNull();
    expect(screen.getByTestId('workspace-git-dirty-indicator')).toBeDefined();
    expect(screen.getByLabelText('Uncommitted Git changes')).toBeDefined();
  });

  it('does not show a dirty indicator for a clean managed worktree', () => {
    render(
      <WorkspaceTabs
        session={mockSession}
        activeTab="terminal"
        onTabChange={vi.fn()}
      />
    );

    expect(screen.getByTestId('workspace-worktree-badge')).toBeDefined();
    expect(screen.queryByLabelText('Uncommitted Git changes')).toBeNull();
  });

  it('navigates to artifacts tab and dismisses banner when Artifacts Tab button is clicked', async () => {
    const onTabChange = vi.fn();

    render(
      <WorkspaceTabs
        session={mockSession}
        activeTab="terminal"
        onTabChange={onTabChange}
      />
    );

    // Trigger artifactCreated event
    act(() => {
      artifactCreatedCb('sess-1', mockOutputArtifact);
    });

    expect(screen.getByTestId('detected-output-banner')).toBeDefined();

    // Click "Artifacts Tab" button
    fireEvent.click(screen.getByTestId('view-in-artifacts-button'));

    expect(onTabChange).toHaveBeenCalledWith('artifacts');
    expect(screen.queryByTestId('detected-output-banner')).toBeNull();
  });

  it('dismisses banner when close (X) button is clicked', async () => {
    const onTabChange = vi.fn();

    render(
      <WorkspaceTabs
        session={mockSession}
        activeTab="terminal"
        onTabChange={onTabChange}
      />
    );

    act(() => {
      artifactCreatedCb('sess-1', mockOutputArtifact);
    });

    expect(screen.getByTestId('detected-output-banner')).toBeDefined();

    // Click dismiss button
    fireEvent.click(screen.getByTestId('dismiss-detected-banner-button'));

    expect(screen.queryByTestId('detected-output-banner')).toBeNull();
  });

  it('clears banner when switching to artifacts tab', async () => {
    const onTabChange = vi.fn();

    const { rerender } = render(
      <WorkspaceTabs
        session={mockSession}
        activeTab="terminal"
        onTabChange={onTabChange}
      />
    );

    act(() => {
      artifactCreatedCb('sess-1', mockOutputArtifact);
    });

    expect(screen.getByTestId('detected-output-banner')).toBeDefined();

    // User switches to artifacts tab
    rerender(
      <WorkspaceTabs
        session={mockSession}
        activeTab="artifacts"
        onTabChange={onTabChange}
      />
    );

    expect(screen.queryByTestId('detected-output-banner')).toBeNull();

    // Returning to terminal tab afterwards should not show the banner anymore
    rerender(
      <WorkspaceTabs
        session={mockSession}
        activeTab="terminal"
        onTabChange={onTabChange}
      />
    );
    expect(screen.queryByTestId('detected-output-banner')).toBeNull();
  });
});
