import React, { useEffect } from 'react';
import type { Session } from '@spawnea/domain';
import { AlertTriangle, X, ArrowUpRight, Trash2 } from 'lucide-react';

interface CloseParentModalProps {
  isOpen: boolean;
  parentSession: Session | null;
  childrenSessions: Session[];
  gitDirtyBySessionId?: Record<string, boolean>;
  onClose: () => void;
  onConfirm: (action: 'close-all' | 'leave-children') => void;
}

export function CloseParentModal({
  isOpen,
  parentSession,
  childrenSessions,
  gitDirtyBySessionId = {},
  onClose,
  onConfirm,
}: CloseParentModalProps): React.JSX.Element | null {
  const modalRef = React.useRef<HTMLDivElement>(null);
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  // Initial focus on open (only runs when isOpen transitions to true)
  useEffect(() => {
    if (!isOpen) return;

    const timer = setTimeout(() => {
      if (modalRef.current && !modalRef.current.contains(document.activeElement)) {
        const primaryButton = modalRef.current.querySelector<HTMLElement>(
          '[data-testid="parent-close-leave-children-button"]'
        );
        if (primaryButton) {
          primaryButton.focus();
        } else {
          const firstFocusable = modalRef.current.querySelector<HTMLElement>(
            'button:not([disabled])'
          );
          firstFocusable?.focus();
        }
      }
    }, 0);

    return () => clearTimeout(timer);
  }, [isOpen]);

  // Keyboard navigation: Escape to close, Tab to cycle focus within modal
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab' && modalRef.current) {
        const elements = modalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (elements.length === 0) return;
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen]);

  if (!isOpen || !parentSession) return null;

  const dirtyChildrenCount = childrenSessions.filter(
    (c) => c.managedWorktree && gitDirtyBySessionId[c.id]
  ).length;

  return (
    <div
      ref={modalRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="close-parent-modal-title"
      data-testid="close-parent-modal"
      className="fixed inset-0 bg-black/70 backdrop-blur-xs flex items-center justify-center z-50 p-4"
    >
      <div className="bg-[#161b22] border border-[#30363d] rounded-xl w-full max-w-md shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#30363d] bg-[#0d1117]">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20">
              <AlertTriangle className="w-4 h-4" />
            </div>
            <div>
              <h2 id="close-parent-modal-title" className="text-sm font-semibold text-white">Parent Session Has Children</h2>
              <p className="text-[11px] text-zinc-400">
                {childrenSessions.length} active child {childrenSessions.length === 1 ? 'session' : 'sessions'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            data-testid="close-parent-modal-cancel-x"
            aria-label="Close dialog"
            className="text-zinc-400 hover:text-zinc-200 p-1 rounded-md hover:bg-[#21262d] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-xs text-zinc-300">
            <span className="font-semibold text-white">{parentSession.name}</span> has{' '}
            <span className="font-medium text-amber-300">{childrenSessions.length} child session{childrenSessions.length === 1 ? '' : 's'}</span>.
            How would you like to handle them?
          </p>

          <div className="space-y-2 max-h-36 overflow-y-auto pr-1">
            {childrenSessions.map((child) => (
              <div
                key={child.id}
                className="flex items-center justify-between px-3 py-1.5 rounded bg-[#0d1117] border border-[#30363d] text-xs"
              >
                <div className="flex items-center gap-2 truncate">
                  <span className="font-mono text-[10px] text-purple-400 font-medium px-1 rounded bg-purple-500/10 border border-purple-500/20 shrink-0">
                    {child.childAlias || 'child'}
                  </span>
                  <span className="text-zinc-200 truncate">{child.name}</span>
                  {child.managedWorktree && gitDirtyBySessionId[child.id] && (
                    <span className="text-[9px] px-1 py-0.2 rounded bg-amber-500/10 text-amber-300 border border-amber-500/30 shrink-0">
                      Uncommitted changes
                    </span>
                  )}
                </div>
                <span className="text-[10px] text-zinc-500 capitalize ml-2">{child.status}</span>
              </div>
            ))}
          </div>

          {dirtyChildrenCount > 0 && (
            <p className="text-[11px] text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded px-2.5 py-1.5">
              {dirtyChildrenCount === 1
                ? '1 child has uncommitted changes and will prompt for finalization if you choose "Close All".'
                : `${dirtyChildrenCount} children have uncommitted changes and will prompt for finalization if you choose "Close All".`}
            </p>
          )}

          <div className="pt-2 border-t border-[#30363d] flex flex-col gap-2">
            <button
              type="button"
              data-testid="parent-close-leave-children-button"
              onClick={() => onConfirm('leave-children')}
              className="flex items-center justify-between px-4 py-2.5 rounded-lg border border-purple-500/30 bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 transition-colors cursor-pointer text-left"
            >
              <div>
                <div className="text-xs font-medium flex items-center gap-1.5">
                  <ArrowUpRight className="w-3.5 h-3.5 text-purple-400" />
                  Leave Children
                </div>
                <div className="text-[11px] text-zinc-400 mt-0.5">
                  Promotes child sessions to standalone root sessions.
                </div>
              </div>
            </button>

            <button
              type="button"
              data-testid="parent-close-all-button"
              onClick={() => onConfirm('close-all')}
              className="flex items-center justify-between px-4 py-2.5 rounded-lg border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 transition-colors cursor-pointer text-left"
            >
              <div>
                <div className="text-xs font-medium flex items-center gap-1.5">
                  <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                  Close All
                </div>
                <div className="text-[11px] text-zinc-400 mt-0.5">
                  Closes the parent and all child sessions (worktree changes prompted).
                </div>
              </div>
            </button>

            <button
              type="button"
              data-testid="parent-close-cancel-button"
              onClick={onClose}
              className="w-full py-2 text-xs font-medium text-zinc-400 hover:text-white bg-[#21262d] hover:bg-[#30363d] rounded-lg transition-colors cursor-pointer text-center mt-1"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
