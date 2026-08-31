import React from 'react';
import type { HostConnectionState } from '@spawnea/domain';
import { WifiOff, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';

export interface ReconnectionBannerProps {
  hostState: HostConnectionState;
  onRetryNow: () => void;
  isRetrying?: boolean;
}

export function ReconnectionBanner({
  hostState,
  onRetryNow,
  isRetrying = false,
}: ReconnectionBannerProps): React.JSX.Element | null {
  if (hostState.status === 'connected') {
    return null;
  }

  const isReconnecting = hostState.status === 'reconnecting';
  const isDisconnected = hostState.status === 'disconnected';

  return (
    <div
      data-testid="reconnection-banner"
      className={`absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 px-4 py-2.5 rounded-lg border shadow-2xl backdrop-blur-md transition-all duration-200 animate-in fade-in slide-in-from-top-2 select-none ${
        isReconnecting
          ? 'bg-amber-950/85 border-amber-500/40 text-amber-200'
          : 'bg-rose-950/85 border-rose-500/40 text-rose-200'
      }`}
    >
      <div className="flex items-center gap-2">
        {isReconnecting ? (
          <RefreshCw
            data-testid="reconnection-spinner"
            className="w-4 h-4 text-amber-400 animate-spin"
          />
        ) : (
          <WifiOff
            data-testid="reconnection-offline-icon"
            className="w-4 h-4 text-rose-400"
          />
        )}

        <div className="flex flex-col">
          <div className="flex items-center gap-1.5 text-xs font-semibold">
            {isReconnecting ? (
              <span>
                Reconnecting host... attempt {hostState.attempt}/{hostState.maxAttempts}
              </span>
            ) : (
              <span>Host Connection Lost</span>
            )}
          </div>
          {hostState.error && (
            <span
              data-testid="reconnection-error-message"
              className="text-[11px] text-zinc-400 max-w-sm truncate"
              title={hostState.error}
            >
              {hostState.error}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 pl-2 border-l border-white/10">
        <button
          type="button"
          data-testid="reconnect-retry-button"
          onClick={onRetryNow}
          disabled={isRetrying}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-all shadow-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
            isReconnecting
              ? 'bg-amber-600/30 hover:bg-amber-600/50 border border-amber-500/40 text-amber-100 active:scale-95'
              : 'bg-rose-600/30 hover:bg-rose-600/50 border border-rose-500/40 text-rose-100 active:scale-95'
          }`}
        >
          <RefreshCw className={`w-3 h-3 ${isRetrying ? 'animate-spin' : ''}`} />
          <span>Retry now</span>
        </button>
      </div>
    </div>
  );
}
