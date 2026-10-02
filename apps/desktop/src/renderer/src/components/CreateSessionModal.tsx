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

const NUMBER_SHORTCUTS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

interface IconSelectOption {
  value: string;
  label: string;
  detail?: string;
  icon: React.ReactNode;
  shortcut?: string;
}

interface IconSelectProps {
  id: string;
  value: string;
  options: IconSelectOption[];
  disabled?: boolean;
  emptyLabel: string;
  onChange: (value: string) => void;
  triggerRef?: React.Ref<HTMLButtonElement>;
  autoFocus?: boolean;
  onSpecialKey?: (key: string) => boolean | void;
}

/** A native-select-compatible picker with rich keyboard navigation (arrows, enter, 1..0 keys). */
function IconSelect({
  id,
  value,
  options,
  disabled = false,
  emptyLabel,
  onChange,
  triggerRef,
  autoFocus = false,
  onSpecialKey,
}: IconSelectProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const setTriggerRef = useCallback(
    (el: HTMLButtonElement | null) => {
      buttonRef.current = el;
      if (!triggerRef) return;
      if (typeof triggerRef === 'function') {
        triggerRef(el);
      } else {
        (triggerRef as React.MutableRefObject<HTMLButtonElement | null>).current = el;
      }
    },
    [triggerRef]
  );

  const selectedIndex = options.findIndex((option) => option.value === value);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(selectedIndex >= 0 ? selectedIndex : 0);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    const idx = options.findIndex((option) => option.value === value);
    setHighlightedIndex(idx >= 0 ? idx : 0);
  }, [value, options]);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && listRef.current) {
      const activeEl = listRef.current.querySelector<HTMLElement>(`[data-index="${highlightedIndex}"]`);
      activeEl?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [isOpen, highlightedIndex]);

  const selectOption = useCallback(
    (optionValue: string) => {
      onChange(optionValue);
      setIsOpen(false);
      buttonRef.current?.focus();
    },
    [onChange]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || options.length === 0) return;

    if (e.key === 'Escape' && isOpen) {
      e.preventDefault();
      e.stopPropagation();
      setIsOpen(false);
      return;
    }

    if (e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }

    if (onSpecialKey && onSpecialKey(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      setIsOpen(false);
      return;
    }

    const numIdx = NUMBER_SHORTCUTS.indexOf(e.key);
    if (numIdx !== -1 && numIdx < options.length) {
      const targetOption = options[numIdx];
      if (!targetOption.shortcut || targetOption.shortcut === NUMBER_SHORTCUTS[numIdx]) {
        e.preventDefault();
        e.stopPropagation();
        selectOption(targetOption.value);
        return;
      }
    }

    const shortcutMatch = options.find(
      (opt) => opt.shortcut && opt.shortcut.toLowerCase() === e.key.toLowerCase()
    );
    if (shortcutMatch) {
      e.preventDefault();
      e.stopPropagation();
      selectOption(shortcutMatch.value);
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
        const idx = options.findIndex((opt) => opt.value === value);
        setHighlightedIndex(idx >= 0 ? idx : 0);
      } else {
        setHighlightedIndex((prev) => Math.min(prev + 1, options.length - 1));
      }
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
        const idx = options.findIndex((opt) => opt.value === value);
        setHighlightedIndex(idx >= 0 ? idx : 0);
      } else {
        setHighlightedIndex((prev) => Math.max(prev - 1, 0));
      }
      return;
    }

    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      if (isOpen) {
        if (options[highlightedIndex]) {
          selectOption(options[highlightedIndex].value);
        }
      } else {
        setIsOpen(true);
        const idx = options.findIndex((opt) => opt.value === value);
        setHighlightedIndex(idx >= 0 ? idx : 0);
      }
      return;
    }
  };

  const handleBlur = (e: React.FocusEvent) => {
    if (!rootRef.current?.contains(e.relatedTarget as Node)) {
      setIsOpen(false);
    }
  };

  return (
    <div ref={rootRef} onBlur={handleBlur} className="relative">
      <select
        data-testid={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-hidden="true"
        tabIndex={-1}
        className="sr-only"
      >
        {options.length === 0 ? (
          <option value="">{emptyLabel}</option>
        ) : (
          options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))
        )}
      </select>

      <button
        ref={setTriggerRef}
        type="button"
        data-testid={`${id}-trigger`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        disabled={disabled}
        autoFocus={autoFocus}
        onKeyDown={handleKeyDown}
        onClick={() => {
          if (options.length === 0) return;
          if (!isOpen) {
            const idx = options.findIndex((opt) => opt.value === value);
            setHighlightedIndex(idx >= 0 ? idx : 0);
          }
          setIsOpen((open) => !open);
        }}
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
          ref={listRef}
          role="listbox"
          aria-label={id}
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 max-h-56 overflow-y-auto rounded-lg border border-[#30363d] bg-[#161b22] p-1 shadow-2xl"
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            const isHighlighted = index === highlightedIndex;
            const shortcutBadge = option.shortcut || (index < 10 ? NUMBER_SHORTCUTS[index] : null);

            return (
              <button
                key={option.value}
                type="button"
                role="option"
                tabIndex={-1}
                data-index={index}
                aria-selected={isSelected}
                onMouseEnter={() => setHighlightedIndex(index)}
                onClick={() => selectOption(option.value)}
                className={`w-full flex items-center gap-2 rounded-md px-2 py-2 text-left transition-colors cursor-pointer ${
                  isHighlighted
                    ? isSelected
                      ? 'bg-emerald-500/20 text-emerald-200'
                      : 'bg-[#21262d] text-zinc-100'
                    : isSelected
                      ? 'bg-emerald-500/10 text-emerald-300'
                      : 'text-zinc-200 hover:bg-[#21262d]'
                }`}
              >
                {option.icon}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs">{option.label}</span>
                  {option.detail && <span className="block truncate text-[10px] text-zinc-500">{option.detail}</span>}
                </span>
                {shortcutBadge && (
                  <kbd className="text-[10px] font-mono text-zinc-400 bg-[#0d1117] border border-[#30363d] px-1.5 py-0.5 rounded shrink-0">
                    {shortcutBadge}
                  </kbd>
                )}
                {isSelected && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export const NEW_PROJECT_OPTION_VALUE = '__new_project__';

interface CreateSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (input: CreateSessionInput) => Promise<void>;
  servers: Server[];
  projects: Project[];
  agents: Agent[];
  catalog?: import('@spawnea/domain').OperationalCatalog | null;
  hostHealthMap?: Record<string, import('@spawnea/domain').HostHealthResult>;
  onOpenNewProject?: (targetServerId?: string) => void;
  createdProject?: { serverId: string; projectId: string } | null;
  hasChildModalOpen?: boolean;
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
  onOpenNewProject,
  createdProject,
  hasChildModalOpen = false,
}: CreateSessionModalProps): React.JSX.Element | null {
  const [serverId, setServerId] = useState<string>('');
  const [projectId, setProjectId] = useState<string>('');
  const [agentId, setAgentId] = useState<string>('');
  const [task, setTask] = useState<string>('');
  const [isCustomTask, setIsCustomTask] = useState<boolean>(false);
  const [baseBranch, setBaseBranch] = useState<string>('');
  const [useWorktree, setUseWorktree] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const serverTriggerRef = useRef<HTMLButtonElement>(null);

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

  const lastConsumedCreatedProjectRef = useRef<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // Escape key to dismiss modal
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSubmitting && !hasChildModalOpen) {
        if (modalRef.current?.querySelector('[role="listbox"]')) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, isSubmitting, hasChildModalOpen, onClose]);

  // Reset dialog state only when it opens, preserving choices on catalog refresh.
  useEffect(() => {
    if (!isOpen) return;
    setIsCustomTask(false);
    lastConsumedCreatedProjectRef.current = null;
    setUseWorktree(false);
    setError(null);
    setHostTestStatus('idle');
    setHostTestResult(null);
    const timer = setTimeout(() => serverTriggerRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [isOpen]);

  // Synchronize selections when modal opens or lists change.
  useEffect(() => {
    if (isOpen) {
      const initialServerId = servers.length > 0 ? (serverId && servers.some((s) => s.id === serverId) ? serverId : servers[0].id) : '';
      if (initialServerId && initialServerId !== serverId) {
        setServerId(initialServerId);
      }
      if (agents.length > 0 && (!agentId || !agents.some((a) => a.id === agentId))) {
        setAgentId(agents[0].id);
      }
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

  useEffect(() => {
    if (!createdProject) return;
    const projectKey = `${createdProject.serverId}:${createdProject.projectId}`;
    if (lastConsumedCreatedProjectRef.current === projectKey) return;

    if (createdProject.serverId && createdProject.serverId !== serverId && servers.some((s) => s.id === createdProject.serverId)) {
      setServerId(createdProject.serverId);
    }

    const fullId = createdProject.projectId.includes(':')
      ? createdProject.projectId
      : `${createdProject.serverId}:${createdProject.projectId}`;

    if (availableProjects.some((p) => p.id === fullId)) {
      setProjectId(fullId);
      lastConsumedCreatedProjectRef.current = projectKey;
    }
  }, [createdProject, serverId, servers, availableProjects]);

  const availableAgents = useMemo(() => {
    return agents
      .filter((a) => !serverId || !a.id.includes(':') || a.id.startsWith(`${serverId}:`))
      .sort((a, b) => {
        const aIsShell = a.harness === 'shell' || a.id.endsWith(':shell') || a.id === 'agent-shell';
        const bIsShell = b.harness === 'shell' || b.id.endsWith(':shell') || b.id === 'agent-shell';
        if (aIsShell && !bIsShell) return 1;
        if (!aIsShell && bIsShell) return -1;
        return 0;
      });
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

  // If the selected project does not support worktree, turn it off
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
    if (!isConfigured) {
      setUseWorktree(false);
    }
  }, [projectId, serverId, catalog, projects]);

  const projectOptions = useMemo<IconSelectOption[]>(() => {
    const items: IconSelectOption[] = availableProjects.map((p) => ({
      value: p.id,
      label: p.name,
      detail: p.rootPath,
      icon: <FolderGit2 className="w-4 h-4 text-zinc-400" />,
    }));
    if (onOpenNewProject) {
      items.push({
        value: NEW_PROJECT_OPTION_VALUE,
        label: '+ New Project...',
        detail: 'Register or clone a repository on this host',
        icon: <Sparkles className="w-4 h-4 text-emerald-400" />,
        shortcut: 'N',
      });
    }
    return items;
  }, [availableProjects, onOpenNewProject]);

  const handleProjectChange = useCallback(
    (newVal: string) => {
      if (newVal === NEW_PROJECT_OPTION_VALUE) {
        onOpenNewProject?.(serverId);
        return;
      }
      setProjectId(newVal);
    },
    [onOpenNewProject, serverId]
  );

  const handleProjectSpecialKey = useCallback(
    (key: string) => {
      if (key.toLowerCase() === 'n' && onOpenNewProject) {
        onOpenNewProject(serverId);
        return true;
      }
      return false;
    },
    [onOpenNewProject, serverId]
  );

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

  const selectedProject = projects.find((p) => p.id === projectId);

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
      ref={modalRef}
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
                triggerRef={serverTriggerRef}
                autoFocus={isOpen}
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
              <IconSelect
                id="select-project"
                value={projectId}
                onChange={handleProjectChange}
                onSpecialKey={handleProjectSpecialKey}
                disabled={isSubmitting}
                emptyLabel={availableProjects.length === 0 ? 'No projects for host' : 'Select project'}
                options={projectOptions}
              />
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
