import React, { useEffect, useRef, useState } from 'react';
import type { Session, Server, Project, Agent, HostSystemInfo } from '@spawnea/domain';
import { StatusBadge } from './StatusBadge';
import { OsIcon } from './OsIcon';
import {
  ChevronRight,
  GitBranch,
  GitFork,

  Square,
  Unplug,
  Play,
  Terminal,
  Trash2,
  MessageSquarePlus,
  Search,
  Radio,
  GitMerge,
  Pencil,
  Check,
  X,
  FileDiff,
} from 'lucide-react';
import { AgentIcon } from './AgentIcon';
import { SessionSourceBadge } from './SessionSourceBadge';

interface ContextBarProps {
  session: Session | null;
  server?: Server;
  project?: Project;
  agent?: Agent;
  hostInfo?: HostSystemInfo;
  hasUncommittedChanges?: boolean;
  gitChangeCount?: number;
  onDetach?: (sessionId: string) => void;
  onStop?: (sessionId: string) => void;
  onAttach?: (sessionId: string) => void;
  onDelete?: (sessionId: string) => void;
  onUnadopt?: (sessionId: string) => void;
  onFinish?: (sessionId: string) => void;
  onReportFeedback?: (sessionId: string) => void;
  onOpenQuickSwitcher?: () => void;
  onRename?: (sessionId: string, title: string) => Promise<void>;
}

export function ContextBar({
  session,
  server,
  project,
  agent,
  hostInfo,
  hasUncommittedChanges = false,
  gitChangeCount = 0,
  onDetach,
  onStop,
  onAttach,
  onDelete,
  onUnadopt,
  onFinish,
  onReportFeedback,
  onOpenQuickSwitcher,
  onRename,
}: ContextBarProps): React.JSX.Element {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const isEditingTitle = Boolean(session && editingSessionId === session.id);

  useEffect(() => {
    setEditingSessionId(null);
    setDraftTitle('');
    setRenameError(null);
    setIsRenaming(false);
  }, [session?.id]);

  useEffect(() => {
    if (isEditingTitle) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [isEditingTitle]);

  if (!session) {
    return (
      <header className="h-14 px-6 border-b border-[#30363d] bg-[#161b22]/50 flex items-center justify-between text-zinc-400 text-xs shrink-0 select-none">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-zinc-500" />
          <span>No active session selected</span>
        </div>
      </header>
    );
  }

  const serverDisplay = server ? `${server.name} (${server.host})` : session.serverId;
  const projectDisplay = project ? project.name : session.projectId;
  const agentDisplay = agent ? agent.name : session.agentId;
  const hasAgentHarness = agent && agent.harness !== 'none' && agent.harness !== 'terminal' && agent.name !== 'Terminal' && session.agentId !== 'agent-terminal';
  const hasDistinctTask = session.task.trim() !== session.name.trim();

  const beginTitleEdit = (): void => {
    setEditingSessionId(session.id);
    setDraftTitle(session.name);
    setRenameError(null);
  };

  const cancelTitleEdit = (): void => {
    setEditingSessionId(null);
    setDraftTitle('');
    setRenameError(null);
  };

  const saveTitle = async (): Promise<void> => {
    const title = draftTitle.trim();
    if (!title) {
      setRenameError('Title cannot be empty');
      return;
    }
    if (title === session.name) {
      cancelTitleEdit();
      return;
    }
    if (!onRename) {
      setRenameError('Session title editing is unavailable');
      return;
    }

    setIsRenaming(true);
    setRenameError(null);
    try {
      await onRename(session.id, title);
      setEditingSessionId(null);
      setDraftTitle('');
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : 'Could not update session title');
    } finally {
      setIsRenaming(false);
    }
  };

  return (
    <header className="h-14 px-6 border-b border-[#30363d] bg-[#161b22]/80 flex items-center justify-between shrink-0 select-none backdrop-blur-sm">
      {/* Session Context Hierarchy */}
      <div className="flex items-center gap-3 min-w-0 flex-1 mr-4">
        {/* Session Name & Task */}
        <div className="flex flex-col min-w-0 max-w-[320px]">
          <div className="group/title flex items-center gap-1 min-w-0">
            {isEditingTitle ? (
              <>
                <input
                  ref={titleInputRef}
                  data-testid="session-title-input"
                  aria-label="Session title"
                  aria-invalid={Boolean(renameError)}
                  value={draftTitle}
                  maxLength={120}
                  disabled={isRenaming}
                  onChange={(event) => {
                    setDraftTitle(event.target.value);
                    setRenameError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void saveTitle();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      cancelTitleEdit();
                    }
                  }}
                  className={`h-6 min-w-0 w-[220px] rounded border bg-[#0d1117] px-2 text-xs font-semibold text-white outline-none select-text ${
                    renameError
                      ? 'border-rose-500 focus:border-rose-400'
                      : 'border-emerald-500/60 focus:border-emerald-400'
                  }`}
                />
                <button
                  type="button"
                  aria-label="Save session title"
                  title="Save title (Enter)"
                  disabled={isRenaming}
                  onClick={() => { void saveTitle(); }}
                  className="p-1 rounded text-emerald-400 hover:text-emerald-200 hover:bg-emerald-500/10 disabled:opacity-50 cursor-pointer"
                >
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  aria-label="Cancel session title edit"
                  title="Cancel (Escape)"
                  disabled={isRenaming}
                  onClick={cancelTitleEdit}
                  className="p-1 rounded text-zinc-400 hover:text-white hover:bg-white/5 disabled:opacity-50 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </>
            ) : (
              <>
                <span className="text-xs font-semibold text-white truncate" title={session.name}>
                  {session.name}
                </span>
                {onRename && (
                  <button
                    type="button"
                    data-testid="edit-session-title-button"
                    aria-label="Edit session title"
                    title="Edit session title"
                    onClick={beginTitleEdit}
                    className="p-1 rounded text-zinc-500 opacity-0 group-hover/title:opacity-100 group-focus-within/title:opacity-100 focus:opacity-100 hover:text-emerald-300 hover:bg-emerald-500/10 transition-opacity cursor-pointer shrink-0"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                )}
              </>
            )}
            {session.isExternal && (
              <span
                data-testid="contextbar-external-badge"
                className="text-[9px] font-mono font-bold px-1.5 py-0.2 rounded bg-cyan-950/90 text-cyan-300 border border-cyan-500/40 shrink-0"
                title="Adopted external tmux session"
              >
                EXT
              </span>
            )}
            <SessionSourceBadge session={session} />
          </div>
          {renameError ? (
            <span role="alert" className="text-[9px] text-rose-400 truncate" title={renameError}>
              {renameError}
            </span>
          ) : hasDistinctTask ? (
            <span className="text-[10px] text-zinc-400 truncate" title={session.task}>
              {session.task}
            </span>
          ) : null}
        </div>

        <ChevronRight className="w-3.5 h-3.5 text-zinc-600 shrink-0" />

        {/* Server & Project context */}
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="flex items-center gap-1.5 text-[11px] text-zinc-300 truncate px-2 py-0.5 bg-[#21262d] rounded border border-[#30363d]"
            title={`Server: ${serverDisplay}`}
          >
            <OsIcon osName={hostInfo?.osName || server?.name || server?.host} className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{projectDisplay}</span>
          </span>

          {session.managedWorktree && (
            <span
              data-testid="contextbar-worktree-badge"
              className="flex items-center gap-1.5 text-[11px] text-teal-300 px-2 py-0.5 bg-teal-500/10 rounded border border-teal-500/25 shrink-0"
              title={`Managed Git worktree\nBranch: ${session.branch}\nPath: ${session.worktreePath}${hasUncommittedChanges ? '\nUncommitted Git changes' : ''}`}
            >
              <GitFork className="w-3 h-3 shrink-0" />
              <span>Worktree</span>
              {hasUncommittedChanges && (
                <>
                  <FileDiff data-testid="contextbar-worktree-dirty-indicator" aria-label="Uncommitted Git changes" className="w-3 h-3 text-amber-300 shrink-0" />
                  <span data-testid="contextbar-worktree-change-count">{gitChangeCount}</span>
                </>
              )}
            </span>
          )}

          {!session.managedWorktree && hasUncommittedChanges && (
            <>
              <FileDiff data-testid="contextbar-git-dirty-indicator" aria-label="Uncommitted Git changes" className="w-3.5 h-3.5 text-amber-300 shrink-0" />
              <span data-testid="contextbar-git-change-count">{gitChangeCount}</span>
            </>
          )}

          <span
            className="flex items-center gap-1 text-[11px] text-emerald-400 font-mono px-2 py-0.5 bg-emerald-500/10 rounded border border-emerald-500/20 truncate"
            title={`Branch: ${session.branch}`}
          >
            <GitBranch className="w-3 h-3 shrink-0" />
            <span className="truncate">{session.branch}</span>
          </span>

          {hasAgentHarness && (
            <span
              className="flex items-center gap-1.5 text-[11px] text-purple-400 px-2 py-0.5 bg-purple-500/10 rounded border border-purple-500/20 truncate hidden lg:flex"
              title={`Agent Harness: ${agentDisplay}`}
            >
              <AgentIcon
                harness={agent?.harness}
                agentName={agentDisplay}
                command={agent?.command}
                className="w-3 h-3 shrink-0"
              />
              <span className="truncate">{agentDisplay}</span>
            </span>
          )}
        </div>
      </div>

      {/* Status & Lifecycle Actions */}
      <div className="flex items-center gap-3 shrink-0">
        {onOpenQuickSwitcher && (
          <button
            type="button"
            data-testid="header-quick-switcher-button"
            onClick={onOpenQuickSwitcher}
            className="flex items-center gap-1.5 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 bg-[#21262d]/70 hover:bg-[#21262d] border border-[#30363d] rounded-md transition-colors cursor-pointer"
            title="Open Quick Switcher / Command Palette (Ctrl+P)"
          >
            <Search className="w-3.5 h-3.5 text-emerald-400" />
            <span className="hidden sm:inline">Jump</span>
            <kbd className="text-[9px] font-mono px-1 py-0.2 rounded bg-[#0d1117] text-zinc-400 border border-[#30363d]">
              Ctrl+P
            </kbd>
          </button>
        )}

        <div className="flex items-center gap-1.5">
          <StatusBadge status={session.status} />
          {onReportFeedback && (
            <button
              type="button"
              data-testid="session-feedback-button"
              onClick={() => onReportFeedback(session.id)}
              className="p-1 rounded text-zinc-500 hover:text-purple-400 hover:bg-purple-500/10 transition-colors cursor-pointer"
              title="Report state detection issue / feedback"
              aria-label="Report state issue"
            >
              <MessageSquarePlus className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="h-4 w-px bg-[#30363d]" />

        <div className="flex items-center gap-1.5">
          {/* State: Disconnected -> Next: Attach (Connect) or Stop */}
          {session.status === 'disconnected' && (
            <>
              <button
                type="button"
                data-testid="session-attach-button"
                onClick={() => onAttach?.(session.id)}
                className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30 border border-emerald-500/30 rounded-md transition-colors cursor-pointer"
                title="Connect / Attach to persistent session"
              >
                <Play className="w-3 h-3" />
                <span>Attach</span>
              </button>
              <button
                type="button"
                data-testid="session-stop-button"
                onClick={() => onStop?.(session.id)}
                className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 border border-transparent hover:border-amber-500/20 rounded-md transition-colors cursor-pointer"
                title="Stop persistent session execution"
              >
                <Square className="w-3 h-3" />
                <span>Stop</span>
              </button>
            </>
          )}

          {/* State: Active Interactive Session (working, starting, needs_input, idle, error) -> Detach, Stop */}
          {(session.status === 'working' ||
            session.status === 'starting' ||
            session.status === 'needs_input' ||
            session.status === 'idle' ||
            session.status === 'error') && (
            <>
              <button
                type="button"
                data-testid="session-detach-button"
                onClick={() => onDetach?.(session.id)}
                className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-[#21262d] rounded-md transition-colors cursor-pointer"
                title="Disconnect / Detach from terminal (session keeps running on host)"
              >
                <Unplug className="w-3 h-3" />
                <span>Detach</span>
              </button>
              <button
                type="button"
                data-testid="session-stop-button"
                onClick={() => onStop?.(session.id)}
                className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 border border-transparent hover:border-amber-500/20 rounded-md transition-colors cursor-pointer"
                title="Stop session execution"
              >
                <Square className="w-3 h-3" />
                <span>Stop</span>
              </button>
            </>
          )}

          {/* External Session Non-Destructive Release Option */}
          {session.isExternal && onUnadopt && (
            <button
              type="button"
              data-testid="session-unadopt-button"
              onClick={() => onUnadopt(session.id)}
              className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-cyan-400 hover:text-cyan-300 hover:bg-cyan-500/10 border border-cyan-500/30 rounded-md transition-colors cursor-pointer"
              title="Release / Un-adopt session without killing tmux process"
            >
              <Radio className="w-3 h-3" />
              <span>Release</span>
            </button>
          )}

          {/* Managed Worktree Finalization Option (Task 6.2.1) */}
          {session.managedWorktree && onFinish && (
            <button
              type="button"
              data-testid="session-finish-button"
              onClick={() => onFinish(session.id)}
              className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-indigo-300 hover:text-indigo-200 bg-indigo-950/60 hover:bg-indigo-900/80 border border-indigo-500/40 rounded-md transition-colors cursor-pointer"
              title="Finalize isolated worktree (Integrate, Close, or Ignore)"
            >
              <GitMerge className="w-3 h-3 text-indigo-400" />
              <span>Finish Worktree</span>
            </button>
          )}

          {/* State: Stopped / Concluded (done, error) -> Next: Delete */}
          {(session.status === 'done' || session.status === 'error') && onDelete && (
            <button
              type="button"
              data-testid="session-delete-button"
              onClick={() => onDelete(session.id)}
              className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 border border-transparent hover:border-rose-500/20 rounded-md transition-colors cursor-pointer"
              title="Delete session record completely"
            >
              <Trash2 className="w-3 h-3" />
              <span>Delete</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
