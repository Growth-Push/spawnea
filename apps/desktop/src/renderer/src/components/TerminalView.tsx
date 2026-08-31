import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal, type ILinkProvider } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Session, Agent, HostConnectionState } from '@spawnea/domain';
import {
  Activity,
  AlertCircle,
  RefreshCw,
  Unplug,
  Play,
  CheckCircle2,
  Trash2,
  Check,
} from 'lucide-react';
import { TerminalContextMenu } from './TerminalContextMenu.js';
import { ReconnectionBanner } from './ReconnectionBanner.js';

interface TerminalViewProps {
  session: Session;
  agent?: Agent;
  onAttach?: (sessionId: string) => void;
  onDetach?: (sessionId: string) => void;
  onDelete?: (sessionId: string) => void;
  onStatusChange?: (sessionId: string, status: Session['status']) => void;
}

const MAX_AUTO_RETRIES = 5;
const RETRY_DELAY_MS = 2000;

const isInteractiveStatus = (status: Session['status']) => status !== 'done';

const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;

export function findHttpUrls(lineText: string): Array<{ text: string; start: number }> {
  return Array.from(lineText.matchAll(HTTP_URL_PATTERN), (match) => {
    const text = match[0].replace(/[),.;!?]+$/g, '');
    return { text, start: match.index ?? 0 };
  }).filter((link) => link.text.length > 0);
}

export function createHttpLinkProvider(
  getLineText: (bufferLineNumber: number) => string,
  openUrl: (url: string) => void
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const lineText = getLineText(bufferLineNumber);
      const links = findHttpUrls(lineText).map(({ text, start }) => ({
        text,
        range: {
          start: { x: start + 1, y: bufferLineNumber },
          end: { x: start + text.length, y: bufferLineNumber },
        },
        decorations: { underline: true, pointerCursor: true },
        activate(event: MouseEvent, url: string) {
          if (event.ctrlKey || event.metaKey) openUrl(url);
        },
      }));
      callback(links.length > 0 ? links : undefined);
    },
  };
}

export function TerminalView({
  session,
  agent,
  onAttach,
  onDetach: _onDetach,
  onDelete,
  onStatusChange,
}: TerminalViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalInstanceRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const activeChannelIdRef = useRef<string | null>(null);
  const cleanupFnsRef = useRef<(() => void)[]>([]);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const resizeTimerRef = useRef<NodeJS.Timeout | null>(null);
  const retryCountRef = useRef<number>(0);
  const isConnectingRef = useRef<boolean>(false);

  const sessionRef = useRef(session);
  sessionRef.current = session;
  const prevStatusRef = useRef(session.status);
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  const onAttachRef = useRef(onAttach);
  onAttachRef.current = onAttach;

  const [_ptyChannelId, setPtyChannelId] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<
    'connecting' | 'connected' | 'error' | 'disconnected'
  >(session.status === 'done' ? 'disconnected' : 'connecting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [retryAttempt, setRetryAttempt] = useState<number>(0);
  const [hostConnectionState, setHostConnectionState] = useState<HostConnectionState | null>(null);
  const [isRetryingHost, setIsRetryingHost] = useState<boolean>(false);

  // Context Menu & Toast State
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    hasSelection: boolean;
    selectionText: string;
  } | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<NodeJS.Timeout | null>(null);

  const showToast = useCallback((msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMessage(msg);
    toastTimerRef.current = setTimeout(() => {
      setToastMessage(null);
    }, 2200);
  }, []);

  // Listen to remote host connection state transitions and transparent reattachment events
  useEffect(() => {
    if (!window.spawneaApi) return;

    if (typeof window.spawneaApi.getHostConnectionState === 'function') {
      window.spawneaApi
        .getHostConnectionState(session.serverId)
        .then((state) => {
          setHostConnectionState(state);
        })
        .catch(() => {});
    }

    const unHost =
      typeof window.spawneaApi.onHostConnectionStateChanged === 'function'
        ? window.spawneaApi.onHostConnectionStateChanged((state) => {
            if (state.serverId === sessionRef.current.serverId) {
              setHostConnectionState(state);
            }
          })
        : () => {};

    const unRecon =
      typeof window.spawneaApi.onSessionReconnected === 'function'
        ? window.spawneaApi.onSessionReconnected((data) => {
            if (data.sessionId === sessionRef.current.id) {
              const term = terminalInstanceRef.current;
              if (term) {
                activeChannelIdRef.current = data.ptyChannelId;
                setPtyChannelId(data.ptyChannelId);
                setConnectionStatus('connected');
                term.options.disableStdin = false;
                term.focus();
                showToast('Connection restored successfully');
              }
            }
          })
        : () => {};

    return () => {
      unHost();
      unRecon();
    };
  }, [session.serverId]);

  // Clean up any existing listeners, active streams, and pending timers
  const cleanupActiveConnection = useCallback(() => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    if (resizeTimerRef.current) {
      clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = null;
    }
    retryCountRef.current = 0;
    setRetryAttempt(0);

    for (const fn of cleanupFnsRef.current) {
      try {
        fn();
      } catch {
        // Ignore cleanup errors
      }
    }
    cleanupFnsRef.current = [];
    activeChannelIdRef.current = null;
    setPtyChannelId(null);
    isConnectingRef.current = false;
  }, []);

  const connectToSession = useCallback(
    async (term: Terminal, isRetry = false) => {
      if (isConnectingRef.current) return;
      isConnectingRef.current = true;

      const currentSession = sessionRef.current;
      const currentAgent = agentRef.current;
      const currentOnStatusChange = onStatusChangeRef.current;

      if (!isRetry) {
        cleanupActiveConnection();
      } else if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      isConnectingRef.current = true;

      setConnectionStatus('connecting');
      setErrorMessage(null);

      if (window.spawneaApi) {
        try {
          const { ptyChannelId: channelId } = await window.spawneaApi.attachSession(
            currentSession.id,
            term.cols,
            term.rows
          );

          activeChannelIdRef.current = channelId;
          setPtyChannelId(channelId);
          setConnectionStatus('connected');
          retryCountRef.current = 0;
          setRetryAttempt(0);
          term.options.disableStdin = false;

          if (currentSession.status === 'disconnected') {
            currentOnStatusChange?.(currentSession.id, 'idle');
          }

          setTimeout(() => {
            term.focus();
          }, 50);

          // 1. Hook up PTY output streaming
          const unData = window.spawneaApi.onPtyData((cid, data) => {
            if (cid === channelId) {
              term.write(data);
            }
          });
          cleanupFnsRef.current.push(unData);

          // 2. Hook up PTY exit notification
          const unExit = window.spawneaApi.onPtyExit((cid, code) => {
            if (cid === channelId) {
              term.writeln(`\r\n\x1b[33m[Spawnea Persistent Session Detached (exit code ${code})]\x1b[0m`);
              cleanupActiveConnection();
              setConnectionStatus('disconnected');
              term.options.disableStdin = true;
            }
          });
          cleanupFnsRef.current.push(unExit);

          // 3. Hook up user keyboard input (with DA sequence filter to prevent leaking 0;276;0c)
          const termInputDisposable = term.onData((data) => {
            // Filter out any leaked DA escape responses from xterm.js
            // Device-attribute responses are intentionally matched as control sequences.
            // eslint-disable-next-line no-control-regex
            if (/^\x1b\[(\?|>|=)?[0-9;]*c$/.test(data)) {
              return;
            }
            if (activeChannelIdRef.current && window.spawneaApi?.writePty) {
              window.spawneaApi.writePty(activeChannelIdRef.current, data);
            }
          });
          cleanupFnsRef.current.push(() => termInputDisposable.dispose());
        } catch (err: any) {
          const msg = err?.message || 'Failed to attach to remote session';
          setConnectionStatus('error');
          setErrorMessage(msg);
          term.options.disableStdin = true;

          // If the backend confirmed the session is no longer active / concluded, mark as done immediately
          if (
            msg.includes('no longer active') ||
            msg.includes('not found') ||
            msg.includes('finished') ||
            msg.includes('exited')
          ) {
            currentOnStatusChange?.(currentSession.id, 'done');
            term.writeln(`\r\n\x1b[33m[Spawnea: ${msg}]\x1b[0m`);
            return;
          }

          const nextCount = retryCountRef.current + 1;
          retryCountRef.current = nextCount;
          setRetryAttempt(nextCount);

          if (nextCount < MAX_AUTO_RETRIES && isInteractiveStatus(sessionRef.current.status)) {
            const retryMsg = `${msg} (Retrying ${nextCount}/${MAX_AUTO_RETRIES} in 2s...)`;
            setErrorMessage(retryMsg);
            term.writeln(`\r\n\x1b[31m[Spawnea Connection Error: ${retryMsg}]\x1b[0m`);

            retryTimeoutRef.current = setTimeout(() => {
              if (terminalInstanceRef.current && isInteractiveStatus(sessionRef.current.status)) {
                connectToSession(terminalInstanceRef.current, true);
              }
            }, RETRY_DELAY_MS);
          } else {
            const finalMsg = `${msg} (Stopped after ${MAX_AUTO_RETRIES} attempts)`;
            setErrorMessage(finalMsg);
            term.writeln(`\r\n\x1b[31m[Spawnea Connection Error: ${finalMsg}]\x1b[0m`);
          }
        } finally {
          isConnectingRef.current = false;
        }
      } else {
        // Fallback demo mode for browser testing
        try {
          setConnectionStatus('connected');
          term.options.disableStdin = false;
          term.writeln(
            `\x1b[32mSpawnea Persistent Session Attached: ${currentSession.tmuxSessionName}\x1b[0m`
          );
          term.writeln(
            `Harness: ${currentAgent?.command || 'claude'} | Path: ${currentSession.worktreePath}`
          );
          term.writeln(`Type interactive commands below:`);
          term.write('\r\n$ ');
          term.focus();

          const termInputDisposable = term.onData((data) => {
            if (data === '\r') {
              term.write('\r\n$ ');
            } else if (data === '\u007F') {
              term.write('\b \b');
            } else {
              term.write(data);
            }
          });
          cleanupFnsRef.current.push(() => termInputDisposable.dispose());
        } finally {
          isConnectingRef.current = false;
        }
      }
    },
    [cleanupActiveConnection]
  );

  // Initialize Terminal instance on mount or session change
  useEffect(() => {
    if (!containerRef.current) return;

    cleanupActiveConnection();
    containerRef.current.innerHTML = '';
    prevStatusRef.current = session.status;

    const term = new Terminal({
      cursorBlink: isInteractiveStatus(session.status),
      cursorStyle: 'block',
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      disableStdin: session.status === 'disconnected' || session.status === 'done',
      scrollback: 50000,
      scrollSensitivity: 1,
      fastScrollSensitivity: 5,
      scrollOnUserInput: false,
      theme: {
        background: '#090d13',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        selectionBackground: '#264f78',
        black: '#0d1117',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#d0d7de',
        brightBlack: '#484f58',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd',
        brightWhite: '#ffffff',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    const linkProviderDisposable = term.registerLinkProvider(
      createHttpLinkProvider(
        (bufferLineNumber) => term.buffer.active.getLine(bufferLineNumber - 1)?.translateToString(true) || '',
        (url) => {
          void window.spawneaApi?.openExternalUrl?.(url);
        }
      )
    );

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type === 'keydown') {
        // Ctrl+Shift+C: Linux standard Copy
        if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
          e.preventDefault();
          e.stopPropagation();
          const sel = term.getSelection();
          if (sel) {
            navigator.clipboard.writeText(sel);
            showToast('Copied to clipboard');
          }
          return false;
        }

        // Ctrl+Shift+V / Shift+Insert: Linux standard Paste
        if ((e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) || (e.shiftKey && e.key === 'Insert')) {
          e.preventDefault();
          e.stopPropagation();
          navigator.clipboard.readText().then((text) => {
            if (text && terminalInstanceRef.current) {
              terminalInstanceRef.current.paste(text);
            }
          });
          return false;
        }

        // Ctrl+C with active selection: Copy selection (otherwise standard SIGINT)
        if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
          if (term.hasSelection()) {
            e.preventDefault();
            e.stopPropagation();
            const sel = term.getSelection();
            navigator.clipboard.writeText(sel);
            showToast('Copied to clipboard');
            return false;
          }
        }

        // PageUp / PageDown / Shift+PageUp / Shift+PageDown
        if (e.key === 'PageUp') {
          term.scrollPages(-1);
          return false;
        }
        if (e.key === 'PageDown') {
          term.scrollPages(1);
          return false;
        }

        // Ctrl+Up / Shift+Up / Ctrl+Shift+Up
        if ((e.shiftKey || e.ctrlKey) && (e.key === 'ArrowUp' || e.key === 'Up')) {
          term.scrollLines(-5);
          return false;
        }

        // Ctrl+Down / Shift+Down / Ctrl+Shift+Down
        if ((e.shiftKey || e.ctrlKey) && (e.key === 'ArrowDown' || e.key === 'Down')) {
          term.scrollLines(5);
          return false;
        }

        // Shift+Home -> Scroll to top
        if (e.shiftKey && e.key === 'Home') {
          term.scrollToTop();
          return false;
        }

        // Shift+End -> Scroll to bottom
        if (e.shiftKey && e.key === 'End') {
          term.scrollToBottom();
          return false;
        }
      }
      return true;
    });

    terminalInstanceRef.current = term;
    fitAddonRef.current = fitAddon;

    try {
      fitAddon.fit();
    } catch {
      // Ignore initial fit error
    }

    if (isInteractiveStatus(session.status)) {
      connectToSession(term, false);
    } else {
      setConnectionStatus('disconnected');
    }

    // Direct wheel scrolling listener
    const containerElem = containerRef.current;
    const handleWheel = (e: WheelEvent) => {
      if (term && e.deltaY !== 0) {
        const lines = Math.sign(e.deltaY) * (e.shiftKey ? 10 : 3);
        term.scrollLines(lines);
      }
    };
    containerElem.addEventListener('wheel', handleWheel, { passive: true });

    // Debounced resize handling via ResizeObserver
    const resizeObserver = new ResizeObserver(() => {
      if (fitAddonRef.current && containerRef.current && terminalInstanceRef.current) {
        try {
          fitAddonRef.current.fit();
          const cols = terminalInstanceRef.current.cols;
          const rows = terminalInstanceRef.current.rows;

          if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
          resizeTimerRef.current = setTimeout(() => {
            if (activeChannelIdRef.current && window.spawneaApi?.resizePty) {
              window.spawneaApi.resizePty(
                activeChannelIdRef.current,
                cols,
                rows
              );
            }
          }, 60);
        } catch {
          // Ignore resize errors when container hidden
        }
      }
    });

    resizeObserver.observe(containerElem);

    return () => {
      cleanupActiveConnection();
      containerElem.removeEventListener('wheel', handleWheel);
      resizeObserver.disconnect();
      linkProviderDisposable.dispose();
      term.dispose();
      terminalInstanceRef.current = null;
      fitAddonRef.current = null;
    };
  }, [session.id, showToast]);

  // React strictly to external session.status changes (avoid initial mount duplication)
  useEffect(() => {
    if (!terminalInstanceRef.current) return;
    if (prevStatusRef.current === session.status) return;
    prevStatusRef.current = session.status;

    if (session.status === 'done') {
      cleanupActiveConnection();
      setConnectionStatus('disconnected');
      terminalInstanceRef.current.options.disableStdin = true;
    } else if (session.status !== 'disconnected') {
      if (!activeChannelIdRef.current && connectionStatus !== 'connecting') {
        connectToSession(terminalInstanceRef.current, false);
      }
    }
  }, [session.status, connectionStatus, connectToSession, cleanupActiveConnection]);

  const handleManualRetry = async () => {
    cleanupActiveConnection();
    if (onAttachRef.current) {
      onAttachRef.current(session.id);
    }
    if (terminalInstanceRef.current) {
      await connectToSession(terminalInstanceRef.current, false);
    }
  };

  const handleContainerClick = () => {
    if (isInteractiveStatus(session.status) && connectionStatus === 'connected') {
      terminalInstanceRef.current?.focus();
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const term = terminalInstanceRef.current;
    const sel = term ? term.getSelection() : '';
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      hasSelection: Boolean(sel && sel.trim().length > 0),
      selectionText: sel,
    });
  };

  const handleCopy = () => {
    const sel = contextMenu?.selectionText || terminalInstanceRef.current?.getSelection();
    if (sel) {
      navigator.clipboard.writeText(sel);
      showToast('Copied to clipboard');
    }
  };

  const handlePaste = () => {
    navigator.clipboard.readText().then((text) => {
      if (text && terminalInstanceRef.current) {
        terminalInstanceRef.current.paste(text);
      }
    });
  };

  const handleOpenInEditor = () => {
    const textToOpen = contextMenu?.selectionText || terminalInstanceRef.current?.getSelection();
    if (textToOpen && window.spawneaApi?.openSnippetInEditor) {
      window.spawneaApi.openSnippetInEditor(textToOpen);
      showToast('Opened snippet in default editor');
    }
  };

  const handleTransformToArtifact = () => {
    const textToSave = contextMenu?.selectionText || terminalInstanceRef.current?.getSelection();
    if (textToSave && window.spawneaApi?.createArtifactFromText) {
      const filename = `snippet-${Date.now().toString(36)}.txt`;
      window.spawneaApi
        .createArtifactFromText(session.id, filename, textToSave)
        .then(() => {
          showToast(`Artifact created: ${filename}`);
        })
        .catch((err) => {
          showToast(`Failed to create artifact: ${err?.message || 'Error'}`);
        });
    }
  };

  const handleSelectAll = () => {
    terminalInstanceRef.current?.selectAll();
  };

  const handleClearBuffer = () => {
    terminalInstanceRef.current?.clear();
    showToast('Terminal buffer cleared');
  };

  const handleRetryHost = useCallback(async () => {
    if (isRetryingHost || !window.spawneaApi) return;
    setIsRetryingHost(true);
    try {
      const res = await window.spawneaApi.retryHostConnection(session.serverId);
      setHostConnectionState(res);
    } catch (err: any) {
      showToast(`Retry failed: ${err?.message || String(err)}`);
    } finally {
      setIsRetryingHost(false);
    }
  }, [session.serverId, isRetryingHost, showToast]);

  return (
    <div
      onClick={handleContainerClick}
      className={`relative h-full flex flex-col rounded-lg border border-[#30363d] bg-[#090d13] font-mono text-xs shadow-inner overflow-hidden ${
        isInteractiveStatus(session.status) && connectionStatus === 'connected'
          ? 'cursor-text'
          : 'cursor-default'
      }`}
    >
      {/* Terminal Top Info Bar */}
      <div className="flex items-center justify-between border-b border-[#21262d] px-4 py-2 bg-[#12161c] text-zinc-400 select-none shrink-0 cursor-default">
        <div className="flex items-center gap-2">
          {connectionStatus === 'connected' ? (
            <Activity className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
          ) : connectionStatus === 'connecting' ? (
            <RefreshCw className="w-3.5 h-3.5 text-yellow-400 animate-spin" />
          ) : session.status === 'disconnected' ? (
            <Unplug className="w-3.5 h-3.5 text-zinc-400" />
          ) : (
            <AlertCircle className="w-3.5 h-3.5 text-rose-400" />
          )}
          <span className="text-zinc-300 font-semibold">
            {session.tmuxSessionName}
          </span>
          <span className="text-zinc-600">•</span>
          <span className="text-zinc-400 truncate max-w-sm">
            {session.worktreePath}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {connectionStatus === 'disconnected' && session.status !== 'done' && onAttach && (
            <button
              type="button"
              data-testid="terminal-header-attach-button"
              onClick={() => onAttach(session.id)}
              className="flex items-center gap-1 px-2.5 py-0.5 rounded bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 text-[11px] hover:bg-emerald-600/30 transition-colors cursor-pointer"
            >
              <Play className="w-3 h-3 fill-current" />
              <span>Attach</span>
            </button>
          )}

          {connectionStatus === 'error' && (
            <button
              type="button"
              onClick={handleManualRetry}
              className="flex items-center gap-1 px-2.5 py-0.5 rounded bg-rose-950/60 border border-rose-500/40 text-rose-300 text-[11px] hover:bg-rose-900/80 cursor-pointer transition-colors"
            >
              <RefreshCw className="w-3 h-3" />
              <span>Retry</span>
            </button>
          )}

          <span
            data-testid="terminal-connection-badge"
            className={`text-[11px] px-2 py-0.5 rounded border ${
              connectionStatus === 'connected'
                ? 'bg-emerald-950/50 border-emerald-500/30 text-emerald-300'
                : connectionStatus === 'connecting'
                ? 'bg-yellow-950/50 border-yellow-500/30 text-yellow-300'
                : connectionStatus === 'disconnected'
                ? 'bg-[#21262d] border-[#30363d] text-zinc-400'
                : 'bg-rose-950/50 border-rose-500/30 text-rose-300'
            }`}
          >
            {connectionStatus === 'connected'
              ? 'PTY Stream Active'
              : connectionStatus === 'connecting'
              ? retryAttempt > 0
                ? `Retrying (${retryAttempt}/${MAX_AUTO_RETRIES})...`
                : 'Attaching SSH PTY...'
              : connectionStatus === 'disconnected'
              ? 'Disconnected'
              : 'Connection Error'}
          </span>
        </div>
      </div>

      {/* Terminal Viewport Container */}
      <div
        onContextMenu={handleContextMenu}
        className="relative flex-1 w-full h-full overflow-hidden bg-[#090d13]"
      >
        {/* Floating Reconnection Banner */}
        {hostConnectionState && (
          <ReconnectionBanner
            hostState={hostConnectionState}
            onRetryNow={handleRetryHost}
            isRetrying={isRetryingHost}
          />
        )}

        <div
          data-testid="xterm-container"
          ref={containerRef}
          className={`w-full h-full ${
            connectionStatus === 'disconnected' || connectionStatus === 'error'
              ? 'opacity-40 filter grayscale pointer-events-none'
              : ''
          }`}
        />

        {/* Floating Context Menu */}
        {contextMenu && (
          <TerminalContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            hasSelection={contextMenu.hasSelection}
            onCopy={handleCopy}
            onPaste={handlePaste}
            onOpenInEditor={handleOpenInEditor}
            onTransformToArtifact={handleTransformToArtifact}
            onSelectAll={handleSelectAll}
            onClearBuffer={handleClearBuffer}
            onClose={() => setContextMenu(null)}
          />
        )}

        {/* Transient Toast Notification */}
        {toastMessage && (
          <div
            data-testid="terminal-toast"
            className="absolute bottom-4 right-4 z-40 bg-[#161b22]/95 border border-emerald-500/40 text-emerald-300 px-3 py-1.5 rounded-lg shadow-xl text-xs flex items-center gap-2 backdrop-blur-md animate-in fade-in slide-in-from-bottom-2 duration-150 pointer-events-none"
          >
            <Check className="w-3.5 h-3.5 text-emerald-400" />
            <span>{toastMessage}</span>
          </div>
        )}

        {/* Detached State Overlay */}
        {connectionStatus === 'disconnected' && session.status !== 'done' && (
          <div
            data-testid="terminal-detached-overlay"
            className="absolute inset-0 bg-[#0d1117]/80 backdrop-blur-[1px] flex flex-col items-center justify-center p-6 text-center z-10 select-none"
          >
            <div className="w-12 h-12 rounded-xl bg-[#161b22] border border-[#30363d] flex items-center justify-center text-zinc-400 mb-3 shadow-lg">
              <Unplug className="w-6 h-6 text-yellow-400/90" />
            </div>
            <h3 className="text-sm font-semibold text-white mb-1">Session is Detached</h3>
            <p className="text-xs text-zinc-400 max-w-md mb-4 leading-relaxed">
              Execution is running persistently in tmux (<span className="font-mono text-zinc-300">{session.tmuxSessionName}</span>).
              You can attach at any time to resume interactive terminal control.
            </p>
            {onAttach && (
              <button
                type="button"
                data-testid="terminal-overlay-attach-button"
                onClick={() => onAttach(session.id)}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold transition-all shadow-md hover:shadow-emerald-600/20 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>Attach to Session</span>
              </button>
            )}
          </div>
        )}

        {/* Session Concluded Overlay */}
        {session.status === 'done' && (
          <div
            data-testid="terminal-ended-overlay"
            className="absolute inset-0 bg-[#0d1117]/85 backdrop-blur-[1px] flex flex-col items-center justify-center p-6 text-center z-10 select-none"
          >
            <div className="w-12 h-12 rounded-xl bg-[#161b22] border border-[#30363d] flex items-center justify-center text-emerald-400 mb-3 shadow-lg">
              <CheckCircle2 className="w-6 h-6" />
            </div>
            <h3 className="text-sm font-semibold text-white mb-1">Session Ended</h3>
            <p className="text-xs text-zinc-400 max-w-md mb-4 leading-relaxed">
              The persistent execution context has concluded.
            </p>
            {onDelete && (
              <button
                type="button"
                data-testid="terminal-overlay-delete-button"
                onClick={() => onDelete(session.id)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-950/40 hover:bg-rose-900/60 border border-rose-500/30 text-rose-300 rounded-lg text-xs font-medium transition-all shadow-sm cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Remove Session Record</span>
              </button>
            )}
          </div>
        )}

        {/* Connection Error Overlay */}
        {connectionStatus === 'error' && (
          <div
            data-testid="terminal-error-overlay"
            className="absolute inset-0 bg-[#0d1117]/90 backdrop-blur-[2px] flex flex-col items-center justify-center p-6 text-center z-10 select-none"
          >
            <div className="w-12 h-12 rounded-xl bg-rose-950/40 border border-rose-500/30 flex items-center justify-center text-rose-400 mb-3 shadow-lg">
              <AlertCircle className="w-6 h-6" />
            </div>
            <h3 className="text-sm font-semibold text-white mb-1">Terminal Connection Error</h3>
            <p className="text-xs text-rose-300 max-w-md mb-4 font-mono leading-relaxed bg-rose-950/30 p-2.5 rounded border border-rose-500/20">
              {errorMessage || 'Unable to attach to tmux session on host.'}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleManualRetry}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold transition-all shadow-md cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Retry Attach</span>
              </button>
              {onDelete && (
                <button
                  type="button"
                  data-testid="terminal-overlay-error-delete-button"
                  onClick={() => onDelete(session.id)}
                  className="flex items-center gap-1.5 px-3 py-2 bg-[#21262d] hover:bg-rose-950/60 hover:border-rose-500/40 hover:text-rose-300 border border-[#30363d] text-zinc-300 rounded-lg text-xs font-medium transition-all cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Remove Session</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
