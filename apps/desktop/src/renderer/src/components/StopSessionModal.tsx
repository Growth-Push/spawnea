import React from 'react';
import type { Session, Server, Project, Agent } from '@spawnea/domain';
import { StatusBadge } from './StatusBadge';
import {
  AlertTriangle,
  X,
  Unplug,
  Square,
  Server as ServerIcon,
  Folder,
  Bot,
  Loader2,
  AlertCircle,
} from 'lucide-react';

interface StopSessionModalProps {
  isOpen: boolean;
  session: Session | null;
  server?: Server;
  project?: Project;
  agent?: Agent;
  onClose: () => void;
  onDetach: (sessionId: string) => Promise<void> | void;
  onConfirmStop: (sessionId: string) => Promise<void> | void;
  isStopping?: boolean;
  error?: string | null;
}

export function StopSessionModal({
  isOpen,
  session,
  server,
  project,
  agent,
  onClose,
  onDetach,
  onConfirmStop,
  isStopping = false,
  error = null,
}: StopSessionModalProps): React.JSX.Element | null {
  React.useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isStopping) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, isStopping, onClose]);

  if (!isOpen || !session) return null;

  const serverDisplay = server ? `${server.name} (${server.host})` : session.serverId;
  const projectDisplay = project ? project.name : session.projectId;
  const agentDisplay = agent ? agent.name : session.agentId;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-150"
      data-testid="stop-session-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isStopping) {
          onClose();
        }
      }}
    >
      <div
        className="bg-[#161b22] border border-[#30363d] rounded-xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-labelledby="stop-modal-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#30363d] bg-[#0d1117]">
          <div className="flex items-center gap-2.5 text-amber-400">
            <AlertTriangle className="w-5 h-5" />
            <h2 id="stop-modal-title" className="text-base font-semibold text-zinc-100">
              Terminate Session Execution?
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isStopping}
            className="text-zinc-400 hover:text-zinc-200 transition-colors p-1 rounded-md hover:bg-[#21262d] disabled:opacity-50"
            aria-label="Close modal"
            data-testid="stop-modal-close-icon"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4 text-sm">
          {/* Active-work Warning Banner */}
          <div className="p-3.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium text-amber-300">Active Work Warning</p>
              <p className="text-xs text-amber-200/90 leading-relaxed">
                Terminating will kill the remote persistent <code className="px-1 py-0.5 bg-black/40 rounded text-amber-300">tmux</code> session and immediately stop all executing agent processes.
              </p>
            </div>
          </div>

          {/* Session Metadata Card */}
          <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3.5 space-y-2.5">
            <div className="flex items-center justify-between pb-2 border-b border-[#21262d]">
              <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Target Session</span>
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
                  <Bot className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                  <span className="truncate">{agentDisplay}</span>
                  <span className="text-zinc-600">({session.tmuxSessionName})</span>
                </div>
              </div>
            </div>
          </div>

          {/* Explanation: Detach vs Stop */}
          <div className="text-xs text-zinc-400 space-y-2 bg-[#21262d]/40 p-3 rounded-lg border border-[#30363d]/50">
            <div className="flex items-start gap-2">
              <Unplug className="w-3.5 h-3.5 text-zinc-300 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-zinc-200">Detach Instead:</span> Disconnects the UI but keeps the agent running on the remote host. You can re-attach anytime.
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Square className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-rose-300">Terminate:</span> Kills the persistent tmux session on the host. Unsaved agent work will be lost.
              </div>
            </div>
          </div>

          {/* Error Message if Stop Verification Failed */}
          {error && (
            <div
              className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-2"
              data-testid="stop-modal-error"
            >
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">Termination Failed</p>
                <p className="text-rose-200/90 mt-0.5">{error}</p>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-[#30363d] bg-[#0d1117]">
          <button
            type="button"
            data-testid="stop-modal-cancel"
            onClick={onClose}
            disabled={isStopping}
            className="px-3.5 py-1.5 text-xs font-medium text-zinc-300 hover:text-white bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] rounded-lg transition-colors cursor-pointer disabled:opacity-50"
          >
            Cancel / Keep Running
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="stop-modal-detach"
              onClick={async () => {
                await onDetach(session.id);
                onClose();
              }}
              disabled={isStopping}
              className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-zinc-300 hover:text-white bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] rounded-lg transition-colors cursor-pointer disabled:opacity-50"
            >
              <Unplug className="w-3.5 h-3.5" />
              <span>Detach Instead</span>
            </button>

            <button
              type="button"
              data-testid="stop-modal-confirm"
              onClick={() => onConfirmStop(session.id)}
              disabled={isStopping}
              className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-rose-600 hover:bg-rose-500 rounded-lg transition-colors shadow-sm cursor-pointer disabled:opacity-50"
            >
              {isStopping ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Terminating...</span>
                </>
              ) : (
                <>
                  <Square className="w-3.5 h-3.5" />
                  <span>Terminate Session</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
