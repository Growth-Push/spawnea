import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { TerminalView, createHttpLinkProvider, findHttpUrls } from './TerminalView.js';
import type { Session, Agent, HostConnectionState } from '@spawnea/domain';

// Mock xterm.js and fit addon
vi.mock('@xterm/xterm', () => {
  return {
    Terminal: class {
      cols = 80;
      rows = 24;
      options = { disableStdin: false };
      open = vi.fn();
      loadAddon = vi.fn();
      attachCustomKeyEventHandler = vi.fn();
      registerLinkProvider = vi.fn().mockReturnValue({ dispose: vi.fn() });
      buffer = { active: { getLine: vi.fn().mockReturnValue(undefined) } };
      write = vi.fn();
      paste = vi.fn();
      getSelection = vi.fn().mockReturnValue('');
      hasSelection = vi.fn().mockReturnValue(false);
      selectAll = vi.fn();
      clear = vi.fn();
      focus = vi.fn();
      dispose = vi.fn();
      onData = vi.fn().mockReturnValue({ dispose: vi.fn() });
      scrollPages = vi.fn();
      scrollLines = vi.fn();
      scrollToTop = vi.fn();
      scrollToBottom = vi.fn();
    },
  };
});

vi.mock('@xterm/addon-fit', () => {
  return {
    FitAddon: class {
      fit = vi.fn();
      dispose = vi.fn();
    },
  };
});

global.ResizeObserver = class {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
} as any;

describe('TerminalView with ReconnectionBanner and Resilience', () => {
  it('finds HTTP(S) URLs with optional ports and paths', () => {
    expect(findHttpUrls('Try https://example.com:8443/api?q=1, or http://localhost:3000/health.')).toEqual([
      { text: 'https://example.com:8443/api?q=1', start: 4 },
      { text: 'http://localhost:3000/health', start: 41 },
    ]);
    expect(findHttpUrls('ftp://example.com and example.com are not links')).toEqual([]);
  });

  it('opens detected URLs only with Ctrl/Cmd activation', () => {
    const openUrl = vi.fn();
    let links: any[] | undefined;
    const provider = createHttpLinkProvider(
      () => 'Visit https://example.com/path',
      openUrl
    );

    provider.provideLinks(1, (provided) => {
      links = provided as any[];
    });

    expect(links).toHaveLength(1);
    links?.[0].activate(new MouseEvent('click'), links[0].text);
    expect(openUrl).not.toHaveBeenCalled();
    links?.[0].activate(new MouseEvent('click', { ctrlKey: true }), links[0].text);
    expect(openUrl).toHaveBeenCalledWith('https://example.com/path');
  });

  const mockSession: Session = {
    id: 'sess-recon-1',
    name: 'Reconnection Test',
    serverId: 'srv-remote-1',
    projectId: 'proj-1',
    agentId: 'agent-1',
    task: 'Fix network resilience',
    worktreePath: '/srv/code/spawnea',
    branch: 'feat/pilot5-epic2',
    tmuxSessionName: 'spawnea-recon-test',
    status: 'working',
    isExternal: false,
    createdAt: new Date(),
    lastActivityAt: new Date(),
  };

  let hostStateListener: ((state: HostConnectionState) => void) | null = null;
  let sessionReconnectedListener: ((data: { sessionId: string; ptyChannelId: string }) => void) | null = null;
  let mockGetHostConnectionState: ReturnType<typeof vi.fn>;
  let mockRetryHostConnection: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    hostStateListener = null;
    sessionReconnectedListener = null;

    mockGetHostConnectionState = vi.fn().mockResolvedValue({
      serverId: 'srv-remote-1',
      status: 'connected',
      attempt: 0,
      maxAttempts: 5,
    });

    mockRetryHostConnection = vi.fn().mockResolvedValue({
      serverId: 'srv-remote-1',
      status: 'connected',
      attempt: 0,
      maxAttempts: 5,
    });

    window.spawneaApi = {
      attachSession: vi.fn().mockResolvedValue({ ptyChannelId: 'pty-recon-1' }),
      detachSession: vi.fn().mockResolvedValue(undefined),
      stopSession: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi.fn().mockResolvedValue(true),
      writePty: vi.fn(),
      resizePty: vi.fn(),
      onPtyData: vi.fn().mockReturnValue(() => {}),
      onPtyExit: vi.fn().mockReturnValue(() => {}),
      onStatusChanged: vi.fn().mockReturnValue(() => {}),
      getHostConnectionState: mockGetHostConnectionState,
      retryHostConnection: mockRetryHostConnection,
      onHostConnectionStateChanged: vi.fn((cb) => {
        hostStateListener = cb;
        return () => {
          hostStateListener = null;
        };
      }),
      onSessionReconnected: vi.fn((cb) => {
        sessionReconnectedListener = cb;
        return () => {
          sessionReconnectedListener = null;
        };
      }),
    } as any;
  });

  it('renders TerminalView and displays ReconnectionBanner when host drops', async () => {
    render(<TerminalView session={mockSession} />);

    await waitFor(() => {
      expect(mockGetHostConnectionState).toHaveBeenCalledWith('srv-remote-1');
    });

    // Initially connected, banner should not be present
    expect(screen.queryByTestId('reconnection-banner')).toBeNull();

    // Simulate host connection drop event
    act(() => {
      hostStateListener?.({
        serverId: 'srv-remote-1',
        status: 'reconnecting',
        attempt: 1,
        maxAttempts: 5,
        nextRetryDelayMs: 1000,
        error: 'SSH transport closed unexpectedly',
      });
    });

    // Reconnection banner should now be visible
    expect(screen.getByTestId('reconnection-banner')).toBeDefined();
    expect(screen.getByText(/Reconnecting host... attempt 1\/5/)).toBeDefined();
    expect(screen.getByTestId('reconnection-error-message').textContent).toContain('SSH transport closed unexpectedly');
    expect(screen.getByTestId('reconnect-retry-button')).toBeDefined();

    // Click the "Retry now" button
    act(() => {
      fireEvent.click(screen.getByTestId('reconnect-retry-button'));
    });

    expect(mockRetryHostConnection).toHaveBeenCalledWith('srv-remote-1');
  });

  it('transparently updates PTY channel when session is reconnected without losing terminal instance', async () => {
    render(<TerminalView session={mockSession} />);

    await waitFor(() => {
      expect(window.spawneaApi.attachSession).toHaveBeenCalled();
    });

    // Simulate host connection recovery event
    act(() => {
      hostStateListener?.({
        serverId: 'srv-remote-1',
        status: 'connected',
        attempt: 0,
        maxAttempts: 5,
      });
      sessionReconnectedListener?.({
        sessionId: 'sess-recon-1',
        ptyChannelId: 'pty-recon-recovered-1',
      });
    });

    // Banner is dismissed
    expect(screen.queryByTestId('reconnection-banner')).toBeNull();
    expect(screen.getByText('Connection restored successfully')).toBeDefined();
    expect(screen.getByTestId('terminal-toast')).toBeDefined();
  });
});
