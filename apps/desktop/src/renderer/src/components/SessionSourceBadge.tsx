import React from 'react';
import type { Session } from '@spawnea/domain';

interface SessionSourceBadgeProps {
  session: Pick<Session, 'creationSource'>;
  compact?: boolean;
}

/** Shows the session's explicit MCP origin without relying on display text. */
export function SessionSourceBadge({
  session,
  compact = false,
}: SessionSourceBadgeProps): React.JSX.Element | null {
  if (session.creationSource !== 'mcp') return null;

  return (
    <span
      role="img"
      aria-label="Created through Spawnea MCP"
      data-testid="mcp-session-badge"
      className={compact
        ? 'inline-flex items-center rounded bg-violet-950/90 px-1 py-0.5 text-[7px] font-mono font-bold leading-none text-violet-200 border border-violet-500/50 shrink-0'
        : 'inline-flex items-center rounded bg-violet-950/90 px-1.5 py-0.5 text-[9px] font-mono font-bold leading-none text-violet-200 border border-violet-500/50 shrink-0'}
      title="Created through Spawnea MCP"
    >
      MCP
    </span>
  );
}
