import React, { useState } from 'react';
import type { StateRulesStatus } from '@spawnea/domain';
import { AlertTriangle, X } from 'lucide-react';

interface StateRulesErrorBannerProps {
  status: StateRulesStatus | null;
}

/**
 * Reports an invalid user state-rules file. Spawnea ignores the whole file
 * and uses the factory rules until the file is fixed and Spawnea restarts.
 */
export function StateRulesErrorBanner({ status }: StateRulesErrorBannerProps): React.JSX.Element | null {
  const [isDismissed, setIsDismissed] = useState(false);
  const error = status?.source === 'user_invalid' ? status.error : undefined;
  if (!error || isDismissed) {
    return null;
  }

  const location = [
    error.harness ? `harness "${error.harness}"` : undefined,
    error.position !== undefined ? `rule ${error.position}` : undefined,
    error.line !== undefined ? `line ${error.line}` : undefined,
  ].filter(Boolean).join(', ');

  return (
    <div
      data-testid="state-rules-error-banner"
      role="alert"
      className="bg-amber-950/40 border-b border-amber-500/30 text-amber-200 px-4 py-2.5 shrink-0"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="flex flex-col gap-1 text-xs min-w-0">
            <span>
              <span className="font-semibold text-amber-300">State rules ignored:</span>{' '}
              <span>Factory rules are in use. Fix the file and restart Spawnea to apply it.</span>
            </span>
            <span className="font-mono text-[11px] text-zinc-300 break-all" data-testid="state-rules-error-detail">
              {status?.userFilePath ?? error.file}
              {location ? ` (${location})` : ''}: {error.message}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setIsDismissed(true)}
          className="p-1 hover:bg-amber-500/20 rounded text-amber-400 hover:text-white transition-colors cursor-pointer shrink-0"
          title="Dismiss banner"
          aria-label="Dismiss state rules error"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
