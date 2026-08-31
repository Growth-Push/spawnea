import React, { useEffect } from 'react';
import { Check, Copy, Terminal, X, ArrowUpRight } from 'lucide-react';

export interface ToastAction {
  label: string;
  onClick: () => void;
  icon?: React.ComponentType<{ className?: string }>;
  primary?: boolean;
}

export interface ToastNotificationProps {
  id: string;
  title: string;
  message?: string;
  type?: 'success' | 'info' | 'warning';
  actions?: ToastAction[];
  onClose: () => void;
  autoCloseMs?: number;
}

export function ToastNotification({
  title,
  message,
  type = 'success',
  actions = [],
  onClose,
  autoCloseMs = 6000,
}: ToastNotificationProps): React.JSX.Element {
  useEffect(() => {
    if (autoCloseMs > 0) {
      const timer = setTimeout(() => {
        onClose();
      }, autoCloseMs);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [autoCloseMs, onClose]);

  const borderColors = {
    success: 'border-emerald-500/40 bg-[#121b18]',
    info: 'border-blue-500/40 bg-[#101827]',
    warning: 'border-amber-500/40 bg-[#211810]',
  };

  const titleColors = {
    success: 'text-emerald-400',
    info: 'text-blue-400',
    warning: 'text-amber-400',
  };

  return (
    <div
      data-testid="toast-notification"
      className={`fixed bottom-5 right-5 z-50 max-w-md p-4 rounded-xl border shadow-2xl backdrop-blur-md transition-all animate-in slide-in-from-bottom-3 duration-200 ${borderColors[type]}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <h5 className={`text-xs font-semibold ${titleColors[type]} flex items-center gap-1.5`}>
            <span>{title}</span>
          </h5>
          {message && (
            <p className="text-[11px] text-zinc-300 mt-1 font-mono break-all leading-tight">
              {message}
            </p>
          )}

          {actions.length > 0 && (
            <div className="flex items-center gap-2 mt-3 pt-2 border-t border-[#30363d]/50">
              {actions.map((act, idx) => {
                const Icon = act.icon;
                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={act.onClick}
                    data-testid={`toast-action-${act.label.toLowerCase().replace(/\s+/g, '-')}`}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                      act.primary
                        ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm'
                        : 'bg-[#21262d] hover:bg-[#30363d] text-zinc-200'
                    }`}
                  >
                    {Icon && <Icon className="w-3 h-3" />}
                    <span>{act.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onClose}
          data-testid="close-toast-button"
          className="p-1 text-zinc-500 hover:text-zinc-200 rounded transition-colors cursor-pointer shrink-0"
          title="Dismiss notification"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
