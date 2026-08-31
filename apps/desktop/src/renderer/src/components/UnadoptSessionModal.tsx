import React, { useEffect } from 'react';
import type { Session, Server, Project, Agent } from '@spawnea/domain';
import { StatusBadge } from './StatusBadge';
import {
  X,
  Radio,
  Server as ServerIcon,
  Folder,

  Loader2,
  AlertCircle,
  Info,
} from 'lucide-react';

interface UnadoptSessionModalProps {
  isOpen: boolean;
  session: Session | null;
  server?: Server;
  project?: Project;
  agent?: Agent;
  onClose: () => void;
  onConfirmUnadopt: (sessionId: string) => Promise<void> | void;
  isUnadopting?: boolean;
  error?: string | null;
}

export function UnadoptSessionModal({
  isOpen,
  session,
  server,
  project,
  agent: _agent,
  onClose,
  onConfirmUnadopt,
  isUnadopting = false,
  error = null,
}: UnadoptSessionModalProps): React.JSX.Element | null {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isUnadopting) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, isUnadopting, onClose]);

  if (!isOpen || !session) return null;

  const serverDisplay = server ? `${server.name} (${server.host})` : session.serverId;
  const projectDisplay = project ? project.name : session.projectId;


  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-150"
      data-testid="unadopt-session-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isUnadopting) {
          onClose();
        }
      }}
    >
      <div
        className="bg-[#161b22] border border-[#30363d] rounded-xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unadopt-modal-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#30363d] bg-[#0d1117]">
          <div className="flex items-center gap-2.5 text-cyan-400">
            <Radio className="w-5 h-5" />
            <h2 id="unadopt-modal-title" className="text-base font-semibold text-zinc-100">
              Release / Un-adopt Session
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isUnadopting}
            className="text-zinc-400 hover:text-zinc-200 transition-colors p-1 rounded-md hover:bg-[#21262d] disabled:opacity-50 cursor-pointer"
            aria-label="Close modal"
            data-testid="unadopt-modal-close-icon"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4 text-sm">
          {/* Non-destructive Explanation Banner */}
          <div className="p-3.5 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-200 flex items-start gap-3">
            <Info className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium text-cyan-300">Non-Destructive Release</p>
              <p className="text-xs text-cyan-200/90 leading-relaxed">
                This will remove the session record and context file from Spawnea. The underlying persistent <code className="px-1 py-0.5 bg-black/40 rounded text-cyan-300 font-mono">{session.tmuxSessionName}</code> tmux session and its running processes will <strong>continue running uninterrupted</strong> on the host.
              </p>
            </div>
          </div>

          {/* Session Metadata Card */}
          <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3.5 space-y-2.5">
            <div className="flex items-center justify-between pb-2 border-b border-[#21262d]">
              <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Session Details</span>
              <StatusBadge status={session.status} />
            </div>

            <div className="space-y-1.5 text-xs text-zinc-300">
              <div className="font-medium text-zinc-100 truncate text-sm">
                {session.task || session.name}
              </div>
              <div className="grid grid-cols-2 gap-2 pt-1">
                <div className="flex items-center gap-1.5 text-zinc-400 truncate">
                  <ServerIcon className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                  <span className="truncate">{serverDisplay}</span>
                </div>
                <div className="flex items-center gap-1.5 text-zinc-400 truncate">
                  <Folder className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                  <span className="truncate">{projectDisplay}</span>
                </div>
                <div className="flex items-center gap-1.5 text-zinc-400 truncate col-span-2">
                  <span className="text-zinc-500">tmux:</span>
                  <span className="font-mono text-zinc-300">{session.tmuxSessionName}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Error Message if Unadopt Failed */}
          {error && (
            <div
              className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-2"
              data-testid="unadopt-modal-error"
            >
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">Release Failed</p>
                <p className="text-rose-200/90 mt-0.5">{error}</p>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-[#30363d] bg-[#0d1117]">
          <button
            type="button"
            data-testid="unadopt-modal-cancel"
            onClick={onClose}
            disabled={isUnadopting}
            className="px-3.5 py-1.5 text-xs font-medium text-zinc-300 hover:text-white bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] rounded-lg transition-colors cursor-pointer disabled:opacity-50"
          >
            Cancel
          </button>

          <button
            type="button"
            data-testid="unadopt-modal-confirm"
            onClick={() => onConfirmUnadopt(session.id)}
            disabled={isUnadopting}
            className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-cyan-600 hover:bg-cyan-500 rounded-lg transition-colors shadow-sm cursor-pointer disabled:opacity-50"
          >
            {isUnadopting ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Releasing Session...</span>
              </>
            ) : (
              <>
                <Radio className="w-3.5 h-3.5" />
                <span>Release Session</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
