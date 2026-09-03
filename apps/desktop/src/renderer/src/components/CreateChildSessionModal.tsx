import React, { useState, useEffect, useMemo } from 'react';
import type { Session, Agent, Server, CreateChildSessionInput, ChildSessionWorkspaceMode } from '@spawnea/domain';
import { X, GitFork, Folder, Loader2, GitBranch } from 'lucide-react';

interface CreateChildSessionModalProps {
  isOpen: boolean;
  parentSession: Session | null;
  agents: Agent[];
  servers?: Server[];
  onClose: () => void;
  onSubmit: (input: CreateChildSessionInput) => Promise<void>;
}

function getDisplayAgentName(agent: Agent, hostName?: string): string {
  if (!hostName) return agent.name;
  const suffix = ` (${hostName})`;
  if (agent.name.endsWith(suffix)) {
    return agent.name.slice(0, -suffix.length);
  }
  return agent.name;
}

export function CreateChildSessionModal({
  isOpen,
  parentSession,
  agents,
  servers = [],
  onClose,
  onSubmit,
}: CreateChildSessionModalProps): React.JSX.Element | null {
  const [name, setName] = useState('');
  const [task, setTask] = useState('');
  const [workspace, setWorkspace] = useState<ChildSessionWorkspaceMode>('same-project');
  const [selectedHostId, setSelectedHostId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initializedParentIdRef = React.useRef<string | null>(null);
  const modalRef = React.useRef<HTMLDivElement>(null);
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  const submittingRef = React.useRef(submitting);
  submittingRef.current = submitting;

  // Child sessions always run on the parent session's host
  const hostOptions = useMemo(() => {
    if (!parentSession) return [];
    const server = servers.find((s) => s.id === parentSession.serverId);
    const hostName = server?.name || parentSession.serverId;
    return [{ id: parentSession.serverId, name: hostName }];
  }, [servers, parentSession]);

  const availableAgentsForHost = useMemo(() => {
    if (!parentSession) return agents;
    const targetHostId = parentSession.serverId;
    return agents.filter((a) => {
      if (!a.id.includes(':')) {
        return true;
      }
      return a.id.startsWith(`${targetHostId}:`);
    });
  }, [agents, parentSession]);

  // Reconcile agentId if available agents update while modal is open
  useEffect(() => {
    if (isOpen && availableAgentsForHost.length > 0 && !availableAgentsForHost.some((agent) => agent.id === agentId)) {
      setAgentId(availableAgentsForHost[0]?.id ?? '');
    }
  }, [isOpen, agentId, availableAgentsForHost]);

  // Initialize form state when modal opens and parentSession is available
  useEffect(() => {
    if (!isOpen) {
      initializedParentIdRef.current = null;
      return;
    }
    if (parentSession && initializedParentIdRef.current !== parentSession.id) {
      initializedParentIdRef.current = parentSession.id;
      setName('');
      setTask('');
      setWorkspace('same-project');
      setSelectedHostId(parentSession.serverId);
      setAgentId(parentSession.agentId);
      setError(null);
      setSubmitting(false);
    }
  }, [isOpen, parentSession]);

  // Initial focus on open (only runs when isOpen transitions to true)
  useEffect(() => {
    if (!isOpen) return;

    const timer = setTimeout(() => {
      if (modalRef.current && !modalRef.current.contains(document.activeElement)) {
        const taskInput = modalRef.current.querySelector<HTMLElement>('#child-task');
        if (taskInput) {
          taskInput.focus();
        } else {
          const firstFocusable = modalRef.current.querySelector<HTMLElement>(
            'textarea:not([disabled]), input:not([disabled]), button:not([disabled])'
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
      if (e.key === 'Escape' && !submittingRef.current) {
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!task.trim()) {
      setError('Task description is required.');
      return;
    }
    if (!agentId || !availableAgentsForHost.some((agent) => agent.id === agentId)) {
      setError('An agent harness must be selected.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await onSubmit({
        parentSessionId: parentSession.id,
        name: name.trim() || undefined,
        task: task.trim(),
        workspace,
        agentId,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create child session');
      setSubmitting(false);
    }
  };

  return (
    <div
      ref={modalRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-child-modal-title"
      data-testid="create-child-session-modal"
      className="fixed inset-0 bg-black/70 backdrop-blur-xs flex items-center justify-center z-50 p-4"
    >
      <div className="bg-[#161b22] border border-[#30363d] rounded-xl w-full max-w-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#30363d] bg-[#0d1117]">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-purple-500/10 text-purple-400 border border-purple-500/20">
              <GitFork className="w-4 h-4" />
            </div>
            <div>
              <h2 id="create-child-modal-title" className="text-sm font-semibold text-white">Create Child Session</h2>
              <p className="text-[11px] text-zinc-400">
                Parent: <span className="font-medium text-zinc-200">{parentSession.name}</span>
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close dialog"
            data-testid="close-create-child-modal-button"
            className="text-zinc-400 hover:text-zinc-200 p-1 rounded-md hover:bg-[#21262d] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {error && (
            <div
              role="alert"
              className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg text-xs text-rose-400"
            >
              {error}
            </div>
          )}

          {/* Task description */}
          <div>
            <label htmlFor="child-task" className="block text-xs font-medium text-zinc-300 mb-1">
              Task Description <span className="text-rose-400">*</span>
            </label>
            <textarea
              id="child-task"
              data-testid="child-session-task-input"
              rows={3}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="What subtask should this child session investigate or execute?"
              className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 resize-none"
              required
              autoFocus
            />
          </div>

          {/* Display Name (Optional) */}
          <div>
            <label htmlFor="child-name" className="block text-xs font-medium text-zinc-300 mb-1">
              Display Name <span className="text-zinc-500">(Optional)</span>
            </label>
            <input
              id="child-name"
              type="text"
              data-testid="child-session-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Investigate API Retries (defaults to child alias)"
              className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
            />
          </div>

          {/* Workspace Mode */}
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-2">Workspace Isolation</label>
            <div className="grid grid-cols-2 gap-3">
              <label
                className={`flex flex-col p-3 rounded-lg border cursor-pointer transition-colors ${
                  workspace === 'same-project'
                    ? 'border-purple-500 bg-purple-500/10 text-white'
                    : 'border-[#30363d] bg-[#0d1117] text-zinc-400 hover:border-zinc-600'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <input
                    type="radio"
                    name="workspace"
                    value="same-project"
                    data-testid="child-workspace-same-project"
                    checked={workspace === 'same-project'}
                    onChange={() => setWorkspace('same-project')}
                    className="accent-purple-500"
                  />
                  <Folder className="w-3.5 h-3.5 text-zinc-300" />
                  <span className="text-xs font-medium">Same Project</span>
                </div>
                <p className="text-[10px] text-zinc-500">
                  Runs directly in parent's directory. Fast and shares state.
                </p>
              </label>

              <label
                className={`flex flex-col p-3 rounded-lg border cursor-pointer transition-colors ${
                  workspace === 'new-worktree'
                    ? 'border-purple-500 bg-purple-500/10 text-white'
                    : 'border-[#30363d] bg-[#0d1117] text-zinc-400 hover:border-zinc-600'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <input
                    type="radio"
                    name="workspace"
                    value="new-worktree"
                    data-testid="child-workspace-new-worktree"
                    checked={workspace === 'new-worktree'}
                    onChange={() => setWorkspace('new-worktree')}
                    className="accent-purple-500"
                  />
                  <GitBranch className="w-3.5 h-3.5 text-zinc-300" />
                  <span className="text-xs font-medium">New Worktree</span>
                </div>
                <p className="text-[10px] text-zinc-500">
                  Isolated Git worktree branched from configured base branch.
                </p>
              </label>
            </div>
          </div>

          {/* Host & Agent Harness Selection (2 Combos) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="child-host" className="block text-xs font-medium text-zinc-300 mb-1">
                Host
              </label>
              <div className="relative">
                <select
                  id="child-host"
                  data-testid="child-session-host-select"
                  value={selectedHostId}
                  disabled
                  title="Child sessions inherit the parent session's host"
                  className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs text-zinc-400 focus:outline-none cursor-not-allowed opacity-80"
                >
                  {hostOptions.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name} (Parent Host)
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="child-agent" className="block text-xs font-medium text-zinc-300 mb-1">
                Agent Harness
              </label>
              <div className="relative">
                <select
                  id="child-agent"
                  data-testid="child-session-agent-select"
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                  disabled={availableAgentsForHost.length === 0}
                  className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs text-zinc-200 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 cursor-pointer disabled:opacity-50"
                >
                  {availableAgentsForHost.length === 0 ? (
                    <option value="" disabled>No agents available for this host</option>
                  ) : (
                    availableAgentsForHost.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {getDisplayAgentName(agent, hostOptions.find((h) => h.id === selectedHostId)?.name)} {parentSession && agent.id === parentSession.agentId ? '(Parent Default)' : ''}
                      </option>
                    ))
                  )}
                </select>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-[#30363d]">
            <button
              type="button"
              data-testid="cancel-create-child-button"
              onClick={onClose}
              disabled={submitting}
              className="px-3.5 py-1.5 text-xs font-medium text-zinc-300 hover:text-white bg-[#21262d] hover:bg-[#30363d] rounded-lg transition-colors cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid="submit-create-child-button"
              disabled={submitting || !task.trim() || !agentId || !availableAgentsForHost.some((agent) => agent.id === agentId)}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white bg-purple-600 hover:bg-purple-500 rounded-lg transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {submitting && <Loader2 className="w-3 h-3 animate-spin" />}
              <span>Create Child Session</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
