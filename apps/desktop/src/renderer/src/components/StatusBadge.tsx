import React from 'react';
import type { SessionStatus } from '@spawnea/domain';
import {
  Radio,
  AlertCircle,
  CheckCircle2,
  Clock,
  Loader2,
  Unplug,
  MessageSquare,
} from 'lucide-react';

interface StatusBadgeProps {
  status: SessionStatus;
  isFocused?: boolean;
  isAcknowledged?: boolean;
  promptSnippet?: string;
  errorReason?: string;
  source?: string;
  confidence?: number;
  iconOnly?: boolean;
  className?: string;
  showIcon?: boolean;
}

export function StatusBadge({
  status,
  isFocused = false,
  isAcknowledged = false,
  promptSnippet,
  errorReason,
  source,
  confidence,
  iconOnly = false,
  className = '',
  showIcon = true,
}: StatusBadgeProps): React.JSX.Element {
  let label = 'Idle';
  let colorClass = 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30';
  let tooltipColorClass = 'border-emerald-500/40 text-emerald-300';
  let Icon = CheckCircle2;
  let animClass = '';
  let ringAnimClass = '';

  const isSeen = isAcknowledged || isFocused;

  switch (status) {
    case 'starting':
      label = 'Starting';
      colorClass = 'text-amber-400 bg-amber-500/10 border-amber-500/30';
      tooltipColorClass = 'border-amber-500/40 text-amber-300';
      Icon = Loader2;
      animClass = 'animate-spin';
      ringAnimClass = 'border-dashed border-amber-400 animate-[spin_4s_linear_infinite]';
      break;

    case 'working':
      // 1. Working -> Yellow
      label = 'Working';
      colorClass = 'text-amber-400 bg-amber-500/10 border-amber-500/30';
      tooltipColorClass = 'border-amber-500/40 text-amber-300';
      Icon = Radio;
      animClass = 'animate-pulse';
      ringAnimClass = 'border-dashed border-amber-400 animate-[spin_4s_linear_infinite]';
      break;

    case 'needs_input':
      // 2. Input Required -> Violet
      label = 'Needs Input';
      colorClass = 'text-purple-300 bg-purple-500/15 border-purple-500/40';
      tooltipColorClass = 'border-purple-500/50 text-purple-200';
      Icon = MessageSquare;
      animClass = !isSeen ? 'animate-pulse' : '';
      ringAnimClass = !isSeen
        ? 'border-dashed border-purple-400 animate-[spin_3s_linear_infinite]'
        : '';
      break;

    case 'done':
      // 3. Done -> Green
      label = 'Done';
      colorClass = 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30';
      tooltipColorClass = 'border-emerald-500/40 text-emerald-300';
      Icon = CheckCircle2;
      break;

    case 'error':
      // 4. Error -> Red
      label = 'Error';
      colorClass = 'text-rose-400 bg-rose-500/15 border-rose-500/40';
      tooltipColorClass = 'border-rose-500/50 text-rose-200';
      Icon = AlertCircle;
      animClass = !isSeen ? 'animate-pulse' : '';
      ringAnimClass = !isSeen
        ? 'border-dashed border-rose-400 animate-[spin_3s_linear_infinite]'
        : '';
      break;

    case 'disconnected':
      label = 'Disconnected';
      colorClass = 'text-zinc-400 bg-zinc-800 border-zinc-700';
      tooltipColorClass = 'border-zinc-600 text-zinc-300';
      Icon = Unplug;
      break;

    case 'idle':
    default:
      // 3. Idle -> Green
      label = 'Idle';
      colorClass = 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30';
      tooltipColorClass = 'border-emerald-500/40 text-emerald-300';
      Icon = Clock;
      break;
  }

  const detailText = promptSnippet || errorReason;

  if (iconOnly) {
    return (
      <div className="relative group/status inline-flex items-center justify-center">
        <div
          data-testid={`status-badge-${status}`}
          className={`relative flex items-center justify-center w-6 h-6 rounded-full border transition-all ${colorClass} ${className}`}
          title={`${label}${detailText ? `: ${detailText}` : ''}`}
        >
          {ringAnimClass && (
            <span
              className={`absolute -inset-[3px] rounded-full border pointer-events-none ${ringAnimClass}`}
            />
          )}
          <Icon className={`w-3.5 h-3.5 ${animClass}`} />
          <span className="sr-only">{label}</span>
        </div>

        {/* Hover Tooltip anchored to Icon */}
        <div
          className="hidden group-hover/status:flex flex-col gap-1 absolute right-0 top-full mt-1.5 p-2 rounded-md bg-[#161b22] border shadow-2xl z-50 text-[10px] backdrop-blur-md pointer-events-none min-w-[140px] max-w-[240px] leading-tight"
          style={{ zIndex: 100 }}
        >
          <div className="flex items-center gap-1.5 font-semibold">
            <Icon className="w-3.5 h-3.5 shrink-0" />
            <span className={tooltipColorClass}>{label}</span>
          </div>
          {source && (
            <span className="text-[9px] text-zinc-400">
              Source: {source} {confidence !== undefined ? `(${Math.round(confidence * 100)}%)` : ''}
            </span>
          )}
          {detailText && (
            <p className="font-mono text-zinc-300 line-clamp-3 leading-snug break-words border-t border-[#30363d] pt-1 mt-0.5">
              {detailText}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <span
      data-testid={`status-badge-${status}`}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border ${colorClass} ${className}`}
    >
      {showIcon && <Icon className={`w-3 h-3 ${animClass}`} />}
      <span>{label}</span>
    </span>
  );
}
