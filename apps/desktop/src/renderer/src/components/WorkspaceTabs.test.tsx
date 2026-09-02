import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { WorkspaceTabs } from './WorkspaceTabs';
import type { Session, Server, Artifact, HostConnectionEndpoint } from '@spawnea/domain';

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
  let originalClipboardDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
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
      getHostConnectionEndpoint: vi.fn().mockResolvedValue({
        transport: 'local',
        hostname: '127.0.0.1',
        port: 0,
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

  afterEach(() => {
    if (originalClipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
    } else {
      delete (navigator as { clipboard?: Clipboard }).clipboard;
    }
  });

  function mockClipboardReadText(readText: () => Promise<string>): void {
    const originalClipboard = navigator.clipboard;
    const mockedClipboard = originalClipboard
      ? Object.create(Object.getPrototypeOf(originalClipboard), {
          ...Object.getOwnPropertyDescriptors(originalClipboard),
          readText: { configurable: true, writable: true, value: readText },
        })
      : { readText };

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: mockedClipboard,
    });
  }

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

  it('does not enable clipboard fallback for a remote host using the local server id', async () => {
    const readClipboardText = vi.fn()
      .mockResolvedValueOnce('clipboard-before-selection')
      .mockResolvedValueOnce('remote-selection');
    mockClipboardReadText(readClipboardText);
    const remoteServerWithLocalId: Server = {
      id: 'local',
      name: 'Misidentified Remote',
      host: 'remote.example.test',
      sshPort: 22,
      enabled: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };
    (window as any).spawneaApi.getHostConnectionEndpoint.mockResolvedValue({
      transport: 'ssh',
      hostname: 'remote.example.test',
      port: 22,
    });

    render(
      <WorkspaceTabs
        session={mockSession}
        server={remoteServerWithLocalId}
        activeTab="terminal"
        onTabChange={vi.fn()}
      />
    );

    const terminalViewport = screen.getByTestId('xterm-container').parentElement;
    expect(terminalViewport).not.toBeNull();
    fireEvent.mouseDown(terminalViewport!, { button: 0 });
    fireEvent.mouseMove(terminalViewport!, { buttons: 1 });
    fireEvent.mouseUp(terminalViewport!, { button: 0 });
    fireEvent.contextMenu(terminalViewport!);

    await waitFor(() => {
      expect(readClipboardText).not.toHaveBeenCalled();
      expect((screen.getByTestId('context-menu-copy') as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it('uses the resolved SSH endpoint for aliases and forwarded ports', async () => {
    const readClipboardText = vi.fn()
      .mockResolvedValueOnce('clipboard-before-selection')
      .mockResolvedValueOnce('remote-selection');
    mockClipboardReadText(readClipboardText);
    const serverConfiguredAsLocal: Server = {
      id: 'srv-1',
      name: 'Forwarded SSH Host',
      host: 'localhost',
      sshConfigAlias: 'remote-forward',
      sshPort: 22,
      enabled: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };
    const getHostConnectionEndpoint = vi.fn().mockResolvedValue({
      transport: 'ssh',
      hostname: '127.0.0.1',
      port: 22022,
    });
    (window as any).spawneaApi.getHostConnectionEndpoint = getHostConnectionEndpoint;

    render(
      <WorkspaceTabs
        session={mockSession}
        server={serverConfiguredAsLocal}
        activeTab="terminal"
        onTabChange={vi.fn()}
      />
    );

    expect(getHostConnectionEndpoint).toHaveBeenCalledWith('srv-1');
    const terminalViewport = screen.getByTestId('xterm-container').parentElement;
    expect(terminalViewport).not.toBeNull();
    fireEvent.mouseDown(terminalViewport!, { button: 0 });
    fireEvent.mouseMove(terminalViewport!, { buttons: 1 });
    fireEvent.mouseUp(terminalViewport!, { button: 0 });
    fireEvent.contextMenu(terminalViewport!);

    await waitFor(() => {
      expect(readClipboardText).not.toHaveBeenCalled();
      expect((screen.getByTestId('context-menu-copy') as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it('does not carry a local clipboard bridge into a new remote session', async () => {
    const readClipboardText = vi.fn().mockResolvedValue('unrelated-local-text');
    mockClipboardReadText(readClipboardText);
    let resolveRemoteEndpoint!: (endpoint: HostConnectionEndpoint) => void;
    const remoteEndpoint = new Promise<HostConnectionEndpoint>((resolve) => {
      resolveRemoteEndpoint = resolve;
    });
    const getHostConnectionEndpoint = vi.fn()
      .mockResolvedValueOnce({ transport: 'local', hostname: '127.0.0.1', port: 0 })
      .mockReturnValueOnce(remoteEndpoint);
    (window as any).spawneaApi.getHostConnectionEndpoint = getHostConnectionEndpoint;
    const remoteSession = {
      ...mockSession,
      id: 'sess-remote',
      serverId: 'srv-remote',
    };
    const { rerender } = render(
      <WorkspaceTabs
        session={mockSession}
        activeTab="terminal"
        onTabChange={vi.fn()}
      />
    );

    await waitFor(() => expect(getHostConnectionEndpoint).toHaveBeenCalledWith('srv-1'));
    rerender(
      <WorkspaceTabs
        session={remoteSession}
        activeTab="terminal"
        onTabChange={vi.fn()}
      />
    );

    const terminalViewport = screen.getByTestId('xterm-container').parentElement;
    expect(terminalViewport).not.toBeNull();
    fireEvent.mouseDown(terminalViewport!, { button: 0 });
    fireEvent.mouseMove(terminalViewport!, { buttons: 1 });
    fireEvent.mouseUp(terminalViewport!, { button: 0 });
    fireEvent.contextMenu(terminalViewport!);

    await waitFor(() => expect(readClipboardText).not.toHaveBeenCalled());
    resolveRemoteEndpoint({ transport: 'ssh', hostname: 'remote.example.test', port: 22 });
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
