import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import {
  TerminalView,
  createHttpLinkProvider,
  decodeOsc52Clipboard,
  findHttpUrls,
} from './TerminalView.js';
import type { Session, HostConnectionState } from '@spawnea/domain';

const xtermMockState = vi.hoisted(() => ({
  osc52Handler: null as null | ((data: string) => boolean | Promise<boolean>),
  inputHandler: null as null | ((data: string) => void),
  mouseTrackingMode: 'any' as 'none' | 'x10' | 'vt200' | 'drag' | 'any',
  selectionText: '',
}));

// Mock xterm.js and fit addon
vi.mock('@xterm/xterm', () => {
  return {
    Terminal: class {
      cols = 80;
      rows = 24;
      options = { disableStdin: false };
      modes = {
        get mouseTrackingMode() {
          return xtermMockState.mouseTrackingMode;
        },
      };
      open = vi.fn();
      loadAddon = vi.fn();
      attachCustomKeyEventHandler = vi.fn();
      registerLinkProvider = vi.fn().mockReturnValue({ dispose: vi.fn() });
      parser = {
        registerOscHandler: vi.fn((ident: number, handler: (data: string) => boolean | Promise<boolean>) => {
          if (ident === 52) xtermMockState.osc52Handler = handler;
          return { dispose: vi.fn() };
        }),
      };
      buffer = { active: { getLine: vi.fn().mockReturnValue(undefined) } };
      write = vi.fn();
      paste = vi.fn();
      getSelection = vi.fn(() => xtermMockState.selectionText);
      hasSelection = vi.fn().mockReturnValue(false);
      selectAll = vi.fn();
      clear = vi.fn();
      focus = vi.fn();
      dispose = vi.fn();
      onData = vi.fn((handler: (data: string) => void) => {
        xtermMockState.inputHandler = handler;
        return { dispose: vi.fn() };
      });
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
  it('decodes OSC52 clipboard writes from remote tmux', () => {
    expect(decodeOsc52Clipboard(';Z3Atb3NjNTItc21va2U=')).toBe('gp-osc52-smoke');
    expect(decodeOsc52Clipboard('c;Y2Fmw6k=')).toBe('caf\u00e9');
  });

  it('rejects OSC52 clipboard reads, invalid payloads, and oversized writes', () => {
    expect(decodeOsc52Clipboard('c;?')).toBeNull();
    expect(decodeOsc52Clipboard('invalid;YQ==')).toBeNull();
    expect(decodeOsc52Clipboard('p;YQ==')).toBeNull();
    expect(decodeOsc52Clipboard('s;YQ==')).toBeNull();
    expect(decodeOsc52Clipboard('0;YQ==')).toBeNull();
    expect(decodeOsc52Clipboard('c;not base64')).toBeNull();
    expect(decodeOsc52Clipboard(`c;${'A'.repeat(1_398_105)}`)).toBeNull();
  });

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
  let clipboardWriteText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    xtermMockState.osc52Handler = null;
    xtermMockState.inputHandler = null;
    xtermMockState.mouseTrackingMode = 'any';
    xtermMockState.selectionText = '';
    hostStateListener = null;
    sessionReconnectedListener = null;
    clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: clipboardWriteText,
        readText: vi.fn().mockResolvedValue(''),
      },
    });

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
      writeClipboardText: clipboardWriteText,
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

  it('writes remote OSC52 data to the desktop clipboard', async () => {
    render(<TerminalView session={mockSession} />);

    expect(xtermMockState.osc52Handler).not.toBeNull();
    act(() => {
      xtermMockState.osc52Handler?.(';Z3Atb3NjNTItc21va2U=');
    });

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith('gp-osc52-smoke');
    });
    expect(screen.getByText('Copied to clipboard')).toBeDefined();
  });

  it('keeps an OSC52 tmux selection available to the context menu', async () => {
    render(<TerminalView session={mockSession} />);

    act(() => {
      xtermMockState.osc52Handler?.('c;Z3Atb3AtbW91c2Utc2VsZWN0aW9u');
    });
    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith('gp-op-mouse-selection');
    });

    const terminalViewport = screen.getByTestId('xterm-container').parentElement;
    expect(terminalViewport).not.toBeNull();
    fireEvent.contextMenu(terminalViewport!);

    expect((screen.getByTestId('context-menu-copy') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('context-menu-open-editor') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('context-menu-transform-artifact') as HTMLButtonElement).disabled).toBe(false);
  });

  it('uses clipboard text for a tmux-yank mouse selection without OSC52', async () => {
    const readClipboardText = vi.fn()
      .mockResolvedValueOnce('clipboard-before-selection')
      .mockResolvedValueOnce('gp-tmux-yank-selection');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: clipboardWriteText,
        readText: readClipboardText,
      },
    });

    render(<TerminalView session={mockSession} clipboardBridgeAvailable />);

    const terminalViewport = screen.getByTestId('xterm-container').parentElement;
    expect(terminalViewport).not.toBeNull();
    fireEvent.mouseDown(terminalViewport!, { button: 0 });
    fireEvent.mouseMove(terminalViewport!, { buttons: 1 });
    fireEvent.mouseUp(terminalViewport!, { button: 0 });
    fireEvent.contextMenu(terminalViewport!);

    await waitFor(() => {
      expect(readClipboardText).toHaveBeenCalled();
      expect((screen.getByTestId('context-menu-copy') as HTMLButtonElement).disabled).toBe(false);
    });

    // Dismissing the menu with a plain click must not discard the accepted
    // tmux selection when the user opens the menu again.
    fireEvent.mouseDown(terminalViewport!, { button: 0 });
    fireEvent.mouseUp(terminalViewport!, { button: 0 });
    act(() => {
      // tmux mouse reporting also travels through xterm's onData callback.
      xtermMockState.inputHandler?.('\x1b[<0;10;10M');
    });
    fireEvent.contextMenu(terminalViewport!);

    expect((screen.getByTestId('context-menu-copy') as HTMLButtonElement).disabled).toBe(false);
  });

  it('captures tmux mouse gestures before xterm stops propagation', async () => {
    const readClipboardText = vi.fn()
      .mockResolvedValueOnce('clipboard-before-selection')
      .mockResolvedValueOnce('gp-tmux-yank-selection');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: clipboardWriteText,
        readText: readClipboardText,
      },
    });

    render(<TerminalView session={mockSession} clipboardBridgeAvailable />);

    const xtermContainer = screen.getByTestId('xterm-container');
    const terminalViewport = xtermContainer.parentElement;
    expect(terminalViewport).not.toBeNull();
    const stopPropagation = (event: MouseEvent) => event.stopPropagation();
    xtermContainer.addEventListener('mousedown', stopPropagation);
    xtermContainer.addEventListener('mousemove', stopPropagation);
    xtermContainer.addEventListener('mouseup', stopPropagation);

    fireEvent.mouseDown(xtermContainer, { button: 0 });
    fireEvent.mouseMove(xtermContainer, { buttons: 1 });
    fireEvent.mouseUp(xtermContainer, { button: 0 });
    fireEvent.contextMenu(terminalViewport!);

    await waitFor(() => {
      expect(readClipboardText).toHaveBeenCalled();
      expect((screen.getByTestId('context-menu-copy') as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('does not use the local clipboard as a remote tmux selection', async () => {
    const readClipboardText = vi.fn().mockResolvedValue('unrelated-local-text');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: clipboardWriteText,
        readText: readClipboardText,
      },
    });

    render(<TerminalView session={mockSession} />);

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

  it('prefers a fresh bridged mouse selection over stale xterm text', async () => {
    xtermMockState.selectionText = 'stale-xterm-selection';
    const readClipboardText = vi.fn()
      .mockResolvedValueOnce('clipboard-before-selection')
      .mockResolvedValueOnce('fresh-tmux-selection');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: clipboardWriteText,
        readText: readClipboardText,
      },
    });

    render(<TerminalView session={mockSession} clipboardBridgeAvailable />);

    const terminalViewport = screen.getByTestId('xterm-container').parentElement;
    expect(terminalViewport).not.toBeNull();
    fireEvent.mouseDown(terminalViewport!, { button: 0 });
    fireEvent.mouseMove(terminalViewport!, { buttons: 1 });
    fireEvent.mouseUp(terminalViewport!, { button: 0 });
    fireEvent.contextMenu(terminalViewport!);

    await waitFor(() => {
      expect(readClipboardText).toHaveBeenCalled();
      expect((screen.getByTestId('context-menu-copy') as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId('context-menu-copy'));
    expect(clipboardWriteText).toHaveBeenCalledWith('fresh-tmux-selection');
  });

  it('does not use unchanged bridged clipboard text as a selection', async () => {
    const readClipboardText = vi.fn()
      .mockResolvedValueOnce('existing-clipboard-text')
      .mockResolvedValueOnce('existing-clipboard-text');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: clipboardWriteText,
        readText: readClipboardText,
      },
    });

    render(<TerminalView session={mockSession} clipboardBridgeAvailable />);

    const terminalViewport = screen.getByTestId('xterm-container').parentElement;
    expect(terminalViewport).not.toBeNull();
    fireEvent.mouseDown(terminalViewport!, { button: 0 });
    fireEvent.mouseMove(terminalViewport!, { buttons: 1 });
    fireEvent.mouseUp(terminalViewport!, { button: 0 });
    fireEvent.contextMenu(terminalViewport!);

    await waitFor(() => {
      expect(readClipboardText).toHaveBeenCalledTimes(2);
      expect((screen.getByTestId('context-menu-copy') as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it('keeps native xterm selection behavior when mouse tracking is off', async () => {
    xtermMockState.mouseTrackingMode = 'none';
    xtermMockState.selectionText = 'fresh-xterm-selection';
    const readClipboardText = vi.fn().mockResolvedValue('unrelated-local-text');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: clipboardWriteText,
        readText: readClipboardText,
      },
    });

    render(<TerminalView session={mockSession} />);

    const terminalViewport = screen.getByTestId('xterm-container').parentElement;
    expect(terminalViewport).not.toBeNull();
    fireEvent.mouseDown(terminalViewport!, { button: 0 });
    fireEvent.mouseMove(terminalViewport!, { buttons: 1 });
    fireEvent.mouseUp(terminalViewport!, { button: 0 });
    fireEvent.contextMenu(terminalViewport!);

    await waitFor(() => {
      expect(readClipboardText).not.toHaveBeenCalled();
      expect((screen.getByTestId('context-menu-copy') as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId('context-menu-copy'));
    expect(clipboardWriteText).toHaveBeenCalledWith('fresh-xterm-selection');
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
