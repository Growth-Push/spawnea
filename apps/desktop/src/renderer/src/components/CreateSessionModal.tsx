import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { Server, Project, Agent, CreateSessionInput, HostTestResult } from '@spawnea/domain';
import {
  X,
  Bot,
  Server as ServerIcon,
  Layers,
  GitBranch,
  Terminal,
  AlertCircle,
  Loader2,
  CheckCircle2,
  RefreshCw,
  FolderGit2,
  Sparkles,
  ChevronDown,
} from 'lucide-react';
import { AgentIcon } from './AgentIcon';
import { OsIcon } from './OsIcon';

interface IconSelectOption {
  value: string;
  label: string;
  detail?: string;
  icon: React.ReactNode;
}

interface IconSelectProps {
  id: string;
  value: string;
  options: IconSelectOption[];
  disabled?: boolean;
  emptyLabel: string;
  onChange: (value: string) => void;
}

/** A native-select-compatible picker whose open list can render provider/OS icons. */
function IconSelect({ id, value, options, disabled = false, emptyLabel, onChange }: IconSelectProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [isOpen]);

  return (
    <div ref={rootRef} className="relative">
      <select
        data-testid={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-hidden="true"
        tabIndex={-1}
        className="sr-only"
      >
        {options.length === 0 ? <option value="">{emptyLabel}</option> : options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>

      <button
        type="button"
        data-testid={`${id}-trigger`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        disabled={disabled}
        onClick={() => setIsOpen((open) => !open)}
        className="w-full min-h-[38px] px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs text-zinc-200 focus:outline-none focus:border-emerald-500 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 text-left"
      >
        {selected ? (
          <>
            {selected.icon}
            <span className="truncate flex-1">{selected.label}</span>
          </>
        ) : (
          <span className="text-zinc-500 flex-1">{emptyLabel}</span>
        )}
        <ChevronDown className={`w-3.5 h-3.5 text-zinc-500 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && options.length > 0 && (
        <div
          role="listbox"
          aria-label={id}
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 max-h-56 overflow-y-auto rounded-lg border border-[#30363d] bg-[#161b22] p-1 shadow-2xl"
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                onChange(option.value);
                setIsOpen(false);
              }}
              className={`w-full flex items-center gap-2 rounded-md px-2 py-2 text-left transition-colors cursor-pointer ${
                option.value === value ? 'bg-emerald-500/10 text-emerald-300' : 'text-zinc-200 hover:bg-[#21262d]'
              }`}
            >
              {option.icon}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs">{option.label}</span>
                {option.detail && <span className="block truncate text-[10px] text-zinc-500">{option.detail}</span>}
              </span>
              {option.value === value && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface CreateSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (input: CreateSessionInput) => Promise<void>;
  servers: Server[];
  projects: Project[];
  agents: Agent[];
  catalog?: import('@spawnea/domain').OperationalCatalog | null;
  hostHealthMap?: Record<string, import('@spawnea/domain').HostHealthResult>;
}

export function CreateSessionModal({
  isOpen,
  onClose,
  onSubmit,
  servers,
  projects,
  agents,
  catalog,
  hostHealthMap = {},
}: CreateSessionModalProps): React.JSX.Element | null {
  const [serverId, setServerId] = useState<string>('');
  const [projectId, setProjectId] = useState<string>('');
  const [agentId, setAgentId] = useState<string>('');
  const [task, setTask] = useState<string>('');
  const [isCustomTask, setIsCustomTask] = useState<boolean>(false);
  const [baseBranch, setBaseBranch] = useState<string>('');
  const [useWorktree, setUseWorktree] = useState<boolean>(true);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Host connectivity testing state (FG-1.2, FG-2.1)
  const [hostTestStatus, setHostTestStatus] = useState<'idle' | 'testing' | 'success' | 'failed'>('idle');
  const [hostTestResult, setHostTestResult] = useState<HostTestResult | null>(null);

  const testHostConnection = useCallback(async (targetServerId: string) => {
    if (!targetServerId) return;
    setHostTestStatus('testing');
    setHostTestResult(null);

    if (window.spawneaApi?.testServer) {
      try {
        const result = await window.spawneaApi.testServer(targetServerId);
        setHostTestResult(result);
        setHostTestStatus(result.success ? 'success' : 'failed');
      } catch (err: any) {
        setHostTestStatus('failed');
        setHostTestResult({
          success: false,
          hostId: targetServerId,
          target: targetServerId,
          error: err?.message || 'Connection test failed',
        });
      }
    } else {
      // Mock success for standalone browser testing
      setHostTestStatus('success');
      setHostTestResult({
        success: true,
        hostId: targetServerId,
        target: 'localhost',
        latencyMs: 15,
        details: 'Connected (mock)',
      });
    }
  }, []);

  // Escape key to dismiss modal
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSubmitting) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, isSubmitting, onClose]);

  // Initialize or synchronize selections when modal opens or lists change
  useEffect(() => {
    if (isOpen) {
      setIsCustomTask(false);
      const initialServerId = servers.length > 0 ? (serverId && servers.some((s) => s.id === serverId) ? serverId : servers[0].id) : '';
      if (initialServerId && initialServerId !== serverId) {
        setServerId(initialServerId);
      }
      if (agents.length > 0 && (!agentId || !agents.some((a) => a.id === agentId))) {
        setAgentId(agents[0].id);
      }
      setError(null);
      setHostTestStatus('idle');
      setHostTestResult(null);
    }
  }, [isOpen, servers, agents]);

  // Memoize project & agent selections when server changes
  const availableProjects = useMemo(() => {
    return projects
      .filter((p) => !serverId || p.serverId === serverId)
      .sort((a, b) => {
        const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        return byName !== 0 ? byName : a.id.localeCompare(b.id);
      });
  }, [projects, serverId]);

  const availableAgents = useMemo(() => {
    return agents.filter(
      (a) => !serverId || !a.id.includes(':') || a.id.startsWith(`${serverId}:`)
    );
  }, [agents, serverId]);

  useEffect(() => {
    if (availableProjects.length > 0) {
      if (!projectId || !availableProjects.some((p) => p.id === projectId)) {
        setProjectId(availableProjects[0].id);
      }
    } else {
      setProjectId('');
    }
  }, [serverId, availableProjects, projectId]);

  useEffect(() => {
    if (availableAgents.length > 0) {
      if (!agentId || !availableAgents.some((a) => a.id === agentId)) {
        setAgentId(availableAgents[0].id);
      }
    } else {
      setAgentId('');
    }
  }, [serverId, availableAgents, agentId]);

  // Auto-generate task description from current project & agent selection if not manually overridden
  useEffect(() => {
    if (!isCustomTask) {
      const proj = availableProjects.find((p) => p.id === projectId) || projects.find((p) => p.id === projectId);
      const ag = availableAgents.find((a) => a.id === agentId) || agents.find((a) => a.id === agentId);
      if (proj && ag) {
        setTask(`${proj.name} - ${ag.name}`);
      } else if (proj) {
        setTask(`${proj.name} session`);
      } else if (ag) {
        setTask(`${ag.name} session`);
      }
    }
  }, [projectId, agentId, isCustomTask, availableProjects, availableAgents, projects, agents]);

  // Synchronize useWorktree default state when selected project changes
  useEffect(() => {
    if (!projectId) {
      setUseWorktree(false);
      return;
    }
    const proj = projects.find((p) => p.id === projectId);
    const catHost = catalog?.hosts[serverId] || (serverId ? Object.values(catalog?.hosts || {}).find((h) => h.name === serverId) : undefined);
    const catProj = catHost?.projects
      ? Object.entries(catHost.projects).find(
          ([key, p]) => key === projectId || `${serverId}:${key}` === projectId || p.path === proj?.rootPath
        )?.[1]
      : undefined;
    const isConfigured = Boolean(catProj?.worktree?.enabled);
    setUseWorktree(isConfigured);
  }, [projectId, serverId, catalog, projects]);

  useEffect(() => {
    const selectedProject = projects.find((project) => project.id === projectId);
    if (selectedProject?.baseBranch) {
      setBaseBranch(selectedProject.baseBranch);
    }
  }, [projectId, projects]);

  const handleServerChange = (newServerId: string) => {
    setServerId(newServerId);
    setHostTestStatus('idle');
    setHostTestResult(null);
  };

  const handleTaskChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setTask(val);
    // Any direct edit is intentional, including clearing the field. Keep it blank
    // until the user explicitly chooses "Use default name".
    setIsCustomTask(true);
  };

  const handleResetToAutoTask = () => {
    const proj = availableProjects.find((p) => p.id === projectId) || projects.find((p) => p.id === projectId);
    const ag = availableAgents.find((a) => a.id === agentId) || agents.find((a) => a.id === agentId);
    if (proj && ag) {
      setTask(`${proj.name} - ${ag.name}`);
    } else if (proj) {
      setTask(`${proj.name} session`);
    } else if (ag) {
      setTask(`${ag.name} session`);
    }
    setIsCustomTask(false);
  };

  if (!isOpen) return null;

  const selectedServer = servers.find((s) => s.id === serverId);
  const selectedProject = projects.find((p) => p.id === projectId);
  const selectedAgent = agents.find((a) => a.id === agentId);

  const catalogHost = catalog?.hosts[serverId] || (serverId ? Object.values(catalog?.hosts || {}).find((h) => h.name === serverId) : undefined);
  const catalogProject = catalogHost?.projects
    ? Object.entries(catalogHost.projects).find(
        ([key, p]) => key === projectId || `${serverId}:${key}` === projectId || p.path === selectedProject?.rootPath
      )?.[1]
    : undefined;

  const isWorktreeConfigured = Boolean(catalogProject?.worktree?.enabled);

  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 30) || 'task';

  const previewBasePath = selectedProject ? selectedProject.rootPath : `/workspace/code`;
  const previewWorktreePath = `${previewBasePath}__worktrees/${slug}`;
  const previewTaskBranch = `spawnea/${slug}`;
  const previewBaseBranch = baseBranch.trim() !== '' ? baseBranch.trim() : 'Current branch (e.g. main)';
  const previewTmux = `spawnea-${slug}`;
  const copyFiles = catalogProject?.worktree?.copy_files || [];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    if (!task.trim()) {
      setError('Please provide a task description.');
      return;
    }
    if (!serverId) {
      setError('Please select a target server.');
      return;
    }
    if (!projectId) {
      setError('Please select a project repository.');
      return;
    }
    if (!agentId) {
      setError('Please select an agent harness.');
      return;
    }

    try {
      setIsSubmitting(true);
      setError(null);
      const isEffectiveWorktree = Boolean(isWorktreeConfigured && useWorktree);
      await onSubmit({
        serverId,
        projectId,
        agentId,
        task: task.trim(),
        baseBranch: isEffectiveWorktree ? (baseBranch.trim() || undefined) : undefined,
        useWorktree: isEffectiveWorktree,
      });
      // Reset form
      setTask('');
      setBaseBranch('');
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to create session. Please check details and retry.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150"
    >
      <div className="bg-[#161b22] border border-[#30363d] rounded-xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col">
        {/* Modal Header */}
        <div className="h-14 px-5 border-b border-[#30363d] flex items-center justify-between bg-[#12161c]">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
              <Terminal className="w-3.5 h-3.5" />
            </div>
            <h3 id="modal-title" className="font-semibold text-sm text-white">Create Agent Session</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 hover:bg-[#21262d] rounded-md text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Form Body */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {error && (
            <div
              data-testid="create-session-error-banner"
              className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg flex items-start gap-2.5 text-rose-400 text-xs leading-relaxed"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="flex-1">
                <span className="font-semibold block mb-0.5">Session Start Failed</span>
                <span className="break-all">{error}</span>
              </div>
            </div>
          )}

          {/* Grid Selection: Server & Project */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-zinc-300 flex items-center gap-1">
                  <ServerIcon className="w-3 h-3 text-zinc-400" />
                  <span>Target Host</span>
                </label>
                {/* Host connection indicator & Test button */}
                {serverId && (
                  <div className="flex items-center gap-1.5 text-[10px]">
                    {hostTestStatus === 'testing' && (
                      <span className="flex items-center gap-1 text-yellow-400 font-mono">
                        <Loader2 className="w-2.5 h-2.5 animate-spin" />
                        Testing...
                      </span>
                    )}
                    {hostTestStatus === 'success' && (
                      <div className="flex items-center gap-1.5">
                        <span
                          data-testid="host-status-connected"
                          className="flex items-center gap-1 text-emerald-400 font-mono"
                          title={hostTestResult?.details || 'Host reachable'}
                        >
                          <CheckCircle2 className="w-2.5 h-2.5" />
                          Connected
                        </span>
                        <button
                          type="button"
                          data-testid="test-host-button"
                          onClick={() => testHostConnection(serverId)}
                          className="flex items-center gap-0.5 text-zinc-400 hover:text-emerald-300 font-mono transition-colors cursor-pointer px-1 py-0.5 bg-[#21262d] rounded border border-[#30363d]"
                          title="Click to test connection again on demand"
                        >
                          <RefreshCw className="w-2.5 h-2.5" />
                          <span>Test</span>
                        </button>
                      </div>
                    )}
                    {hostTestStatus === 'failed' && (
                      <button
                        type="button"
                        data-testid="retry-host-test"
                        onClick={() => testHostConnection(serverId)}
                        className="flex items-center gap-1 text-rose-400 hover:text-rose-300 font-mono cursor-pointer px-1.5 py-0.5 bg-rose-950/40 rounded border border-rose-500/30"
                        title={hostTestResult?.error || 'Connection failed'}
                      >
                        <RefreshCw className="w-2.5 h-2.5" />
                        <span>Retry Test</span>
                      </button>
                    )}
                    {hostTestStatus === 'idle' && (
                      <button
                        type="button"
                        data-testid="test-host-button"
                        onClick={() => testHostConnection(serverId)}
                        className="flex items-center gap-1 text-zinc-400 hover:text-emerald-400 font-mono cursor-pointer px-1.5 py-0.5 bg-[#21262d] rounded border border-[#30363d]"
                      >
                        <RefreshCw className="w-2.5 h-2.5" />
                        <span>Test Connection</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
              <IconSelect
                id="select-server"
                value={serverId}
                onChange={handleServerChange}
                disabled={isSubmitting}
                emptyLabel="No hosts configured"
                options={servers.map((s) => {
                  const health = hostHealthMap[s.id];
                  const latency = health?.latencyMs !== undefined && health.status !== 'unreachable' ? ` • ${health.latencyMs}ms` : '';
                  const statusLabel = health?.status === 'unreachable' ? ' (unreachable)' : '';
                  return {
                    value: s.id,
                    label: `${s.name} (${s.host})${latency}${statusLabel}`,
                    detail: s.host,
                    icon: <OsIcon osName={`${s.name} ${s.host}`} className="w-4 h-4" />,
                  };
                })}
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-1.5 flex items-center gap-1">
                <Layers className="w-3 h-3 text-zinc-400" />
                <span>Project Root</span>
              </label>
              <select
                data-testid="select-project"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                disabled={isSubmitting}
                className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs text-zinc-200 focus:outline-none focus:border-emerald-500 cursor-pointer disabled:opacity-50"
              >
                {availableProjects.length === 0 ? (
                  <option value="">No projects for host</option>
                ) : (
                  availableProjects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))
                )}
              </select>
            </div>
          </div>

          {/* Isolated Git Worktree Option */}
          <div className="pt-0.5">
            <div
              onClick={() => {
                if (isWorktreeConfigured && !isSubmitting) {
                  setUseWorktree((prev) => !prev);
                }
              }}
              className={`flex items-start gap-2.5 p-2.5 bg-[#0d1117] border rounded-lg transition-colors select-none ${
                isWorktreeConfigured
                  ? 'border-[#30363d] hover:border-[#484f58] cursor-pointer'
                  : 'border-[#21262d] opacity-60 cursor-not-allowed'
              }`}
              title={
                isWorktreeConfigured
                  ? 'Toggle isolated git worktree for this session'
                  : "To enable worktrees for this project, add 'worktree: { enabled: true }' in your config.yaml"
              }
            >
              <input
                type="checkbox"
                id="checkbox-use-worktree"
                data-testid="checkbox-use-worktree"
                checked={isWorktreeConfigured && useWorktree}
                onChange={(e) => {
                  if (isWorktreeConfigured) {
                    setUseWorktree(e.target.checked);
                  }
                }}
                onClick={(e) => e.stopPropagation()}
                disabled={isSubmitting || !isWorktreeConfigured}
                className="mt-0.5 w-4 h-4 rounded border-[#30363d] bg-[#161b22] text-emerald-500 focus:ring-emerald-500 focus:ring-offset-0 cursor-pointer disabled:cursor-not-allowed accent-emerald-500"
              />
              <div className="flex flex-col gap-0.5 flex-1">
                <div className="flex items-center gap-2 text-xs font-semibold text-zinc-200">
                  <GitBranch className={`w-3.5 h-3.5 ${isWorktreeConfigured ? 'text-emerald-400' : 'text-zinc-500'}`} />
                  <span>Run in isolated Git Worktree</span>
                  {isWorktreeConfigured ? (
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
                      Worktree
                    </span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-zinc-800 text-zinc-400 border border-zinc-700 font-mono">
                      Disabled in config
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-zinc-400">
                  {isWorktreeConfigured
                    ? "Creates a dedicated branch and folder so work doesn't collide with main or other sessions"
                    : "Not configured for this project. Add 'worktree: { enabled: true }' in config.yaml"}
                </span>
              </div>
            </div>
          </div>

          {/* Grid Selection: Agent Harness & Base Branch */}
          <div className={isWorktreeConfigured && useWorktree ? 'grid grid-cols-2 gap-3' : 'space-y-3'}>
            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-1.5 flex items-center gap-1">
                <Bot className="w-3 h-3 text-zinc-400" />
                <span>Agent Harness</span>
              </label>
              <IconSelect
                id="select-agent"
                value={agentId}
                onChange={setAgentId}
                disabled={isSubmitting}
                emptyLabel="No harnesses for host"
                options={availableAgents.map((a) => ({
                  value: a.id,
                  label: `${a.name} (${a.command})`,
                  detail: a.command,
                  icon: a.harness === 'none' || a.harness === 'terminal'
                    ? <Bot className="w-4 h-4 text-zinc-400" />
                    : <AgentIcon harness={a.harness} agentName={a.name} command={a.command} className="w-4 h-4" />,
                }))}
              />
            </div>

            {isWorktreeConfigured && useWorktree && (
              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1.5 flex items-center gap-1">
                  <GitBranch className="w-3 h-3 text-zinc-400" />
                  <span>Base Branch</span>
                </label>
                <input
                  type="text"
                  data-testid="input-branch"
                  placeholder="Defaults to current branch"
                  value={baseBranch}
                  onChange={(e) => setBaseBranch(e.target.value)}
                  disabled={isSubmitting}
                  className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
                />
              </div>
            )}
          </div>

          {/* Task Name / Prompt */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-semibold text-zinc-300">
                Task Description <span className="text-rose-400">*</span>
              </label>
              {isCustomTask && (
                <button
                  type="button"
                  onClick={handleResetToAutoTask}
                  className="flex items-center gap-1 text-[10px] text-zinc-400 hover:text-emerald-400 transition-colors cursor-pointer"
                  title="Reset to default task description based on selections"
                >
                  <Sparkles className="w-2.5 h-2.5 text-emerald-400" />
                  <span>Use default name</span>
                </button>
              )}
            </div>
            <input
              type="text"
              data-testid="input-task-name"
              placeholder="e.g. Implement user authentication and OAuth"
              value={task}
              onChange={handleTaskChange}
              disabled={isSubmitting}
              className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 disabled:opacity-50"
            />
          </div>

          {/* Project Preparation & Execution Summary Card */}
          <div className="p-3 bg-[#12161c] border border-[#21262d] rounded-lg space-y-2 text-[11px] font-mono text-zinc-400">
            <div className="flex items-center justify-between text-zinc-300 font-semibold pb-1.5 border-b border-[#21262d]">
              <span>Execution Summary</span>
              {isWorktreeConfigured && useWorktree ? (
                <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-sans font-medium">
                  <GitBranch className="w-2.5 h-2.5" />
                  <span>Isolated Worktree</span>
                </span>
              ) : (
                <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700 font-sans font-medium">
                  <span>Project Root</span>
                </span>
              )}
            </div>

            {isWorktreeConfigured && useWorktree ? (
              <div className="space-y-1.5">
                <div
                  className="flex items-baseline justify-between gap-3 group cursor-help"
                  title={`Full Worktree Path: ${previewWorktreePath}`}
                >
                  <span className="text-zinc-500 shrink-0">Worktree Path:</span>
                  <span className="truncate text-emerald-400 font-medium text-right max-w-[280px]">
                    {previewWorktreePath}
                  </span>
                </div>
                <div
                  className="flex items-baseline justify-between gap-3 group cursor-help"
                  title={`Full Branch Name: ${previewTaskBranch}`}
                >
                  <span className="text-zinc-500 shrink-0">Task Branch:</span>
                  <span className="truncate text-cyan-400 text-right max-w-[280px]">
                    {previewTaskBranch}
                  </span>
                </div>
                <div
                  className="flex items-baseline justify-between gap-3 group cursor-help"
                  title={`Base Branch Target: ${previewBaseBranch}`}
                >
                  <span className="text-zinc-500 shrink-0">Base Branch:</span>
                  <span className="truncate text-zinc-300 text-right max-w-[280px]">
                    {previewBaseBranch}
                  </span>
                </div>
                {copyFiles.length > 0 && (
                  <div
                    className="flex items-baseline justify-between gap-3 group cursor-help"
                    title={`Files copied into worktree: ${copyFiles.join(', ')}`}
                  >
                    <span className="text-zinc-500 shrink-0">Copied Configs:</span>
                    <span className="truncate text-zinc-300 text-right max-w-[280px]">
                      {copyFiles.join(', ')}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-1.5">
                <div
                  className="flex items-baseline justify-between gap-3 group cursor-help"
                  title={`Project Path: ${previewBasePath}`}
                >
                  <span className="text-zinc-500 shrink-0">Project Path:</span>
                  <span className="truncate text-zinc-300 text-right max-w-[280px]">{previewBasePath}</span>
                </div>
                {selectedProject?.repoUrl ? (
                  <div className="flex items-center gap-1.5 text-[10px] text-zinc-400 pt-0.5">
                    <FolderGit2 className="w-3 h-3 text-blue-400 shrink-0" />
                    <span className="truncate" title={`Clone URL: ${selectedProject.repoUrl}`}>Reuse folder or clone from Git URL</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 text-[10px] text-zinc-400 pt-0.5">
                    <FolderGit2 className="w-3 h-3 text-zinc-500 shrink-0" />
                    <span className="truncate">Reuse folder or create directory</span>
                  </div>
                )}
              </div>
            )}

            <div
              className="flex items-baseline justify-between gap-3 pt-1.5 border-t border-[#21262d]/60 cursor-help"
              title={`tmux Session Target: ${previewTmux}`}
            >
              <span className="text-zinc-500 shrink-0">tmux Session:</span>
              <span className="truncate text-zinc-300 text-right max-w-[280px]">{previewTmux}</span>
            </div>
          </div>

          {/* Modal Footer Actions */}
          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-3.5 py-1.5 text-xs text-zinc-400 hover:text-white hover:bg-[#21262d] rounded-md transition-colors cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid="submit-create-session"
              disabled={isSubmitting}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-md text-xs font-semibold transition-colors shadow-sm cursor-pointer"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Launching Session...</span>
                </>
              ) : (
                <>
                  <Terminal className="w-3.5 h-3.5" />
                  <span>Launch Session</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
