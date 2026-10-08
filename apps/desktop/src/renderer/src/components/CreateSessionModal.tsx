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
  Search,
} from 'lucide-react';
import { AgentIcon, detectProviderType, getProviderDisplayName, type ProviderType } from './AgentIcon';
import { OsIcon } from './OsIcon';

const NUMBER_SHORTCUTS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
export const NEW_PROJECT_OPTION_VALUE = '__new_project__';

const CANONICAL_PROVIDER_ORDER: (ProviderType | 'shell')[] = [
  'codex',
  'claude',
  'hermes',
  'antigravity',
  'grok',
  'deepseek',
  'gemini',
  'copilot',
  'cursor',
  'generic',
  'shell',
];

export function getAgentProvider(agent: Agent): ProviderType | 'shell' {
  if (
    agent.harness === 'shell' ||
    agent.id.endsWith(':shell') ||
    agent.id === 'agent-shell'
  ) {
    return 'shell';
  }
  const detected = detectProviderType(agent.harness, agent.name, agent.command);
  if (detected === 'none') {
    return 'shell';
  }
  return detected;
}

export function isLocalHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '' ||
    normalized.startsWith('127.')
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
  const [serverId, setServerId] = useState<string>(() => servers[0]?.id || '');
  const [projectId, setProjectId] = useState<string>('');
  const [agentId, setAgentId] = useState<string>('');
  const [task, setTask] = useState<string>('');
  const [isCustomTask, setIsCustomTask] = useState<boolean>(false);
  const [baseBranch, setBaseBranch] = useState<string>('');
  const [useWorktree, setUseWorktree] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Project Combobox state
  const [projectSearchQuery, setProjectSearchQuery] = useState<string>('');
  const [isProjectOpen, setIsProjectOpen] = useState<boolean>(false);
  const [highlightedProjectIdx, setHighlightedProjectIdx] = useState<number>(0);

  const serverTriggerRef = useRef<HTMLButtonElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const projectComboboxRef = useRef<HTMLDivElement>(null);
  const projectListRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

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

  // Escape key to dismiss modal or close open combobox
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSubmitting && !hasChildModalOpen) {
        if (isProjectOpen) {
          e.preventDefault();
          e.stopPropagation();
          setIsProjectOpen(false);
          setProjectSearchQuery('');
          return;
        }
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
  }, [isOpen, isSubmitting, hasChildModalOpen, isProjectOpen, onClose]);

  // Click outside project combobox dropdown
  useEffect(() => {
    if (!isProjectOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (
        !projectComboboxRef.current?.contains(event.target as Node) &&
        !projectListRef.current?.contains(event.target as Node)
      ) {
        setIsProjectOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [isProjectOpen]);

  const effectiveServerId = useMemo(() => {
    return serverId && servers.some((s) => s.id === serverId)
      ? serverId
      : servers[0]?.id || '';
  }, [serverId, servers]);

  // Reset dialog state only when it opens
  useEffect(() => {
    if (!isOpen) return;
    setIsCustomTask(false);
    lastConsumedCreatedProjectRef.current = null;
    setUseWorktree(false);
    setError(null);
    setHostTestStatus('idle');
    setHostTestResult(null);
    setIsProjectOpen(false);
    setProjectSearchQuery('');

    // Restore configured baseBranch from currently selected project
    prevProjectIdRef.current = projectId;
    const currentProj = projects.find((p) => p.id === projectId);
    setBaseBranch(currentProj?.baseBranch || '');

    serverTriggerRef.current?.focus();
    const timer = setTimeout(() => serverTriggerRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [isOpen]);



  // Synchronize selections when modal opens or lists change.
  useEffect(() => {
    if (isOpen) {
      if (effectiveServerId && effectiveServerId !== serverId) {
        setServerId(effectiveServerId);
      }
    }
  }, [isOpen, effectiveServerId, serverId]);

  // Available projects for currently selected server
  const availableProjects = useMemo(() => {
    return projects
      .filter((p) => !effectiveServerId || p.serverId === effectiveServerId)
      .sort((a, b) => {
        const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        return byName !== 0 ? byName : a.id.localeCompare(b.id);
      });
  }, [projects, effectiveServerId]);

  // Auto-select created project if signaled
  useEffect(() => {
    if (!createdProject) return;
    const projectKey = `${createdProject.serverId}:${createdProject.projectId}`;
    if (lastConsumedCreatedProjectRef.current === projectKey) return;

    if (
      createdProject.serverId &&
      createdProject.serverId !== effectiveServerId &&
      servers.some((s) => s.id === createdProject.serverId)
    ) {
      setServerId(createdProject.serverId);
    }

    const fullId = createdProject.projectId.includes(':')
      ? createdProject.projectId
      : `${createdProject.serverId}:${createdProject.projectId}`;

    if (availableProjects.some((p) => p.id === fullId)) {
      setProjectId(fullId);
      lastConsumedCreatedProjectRef.current = projectKey;
    }
  }, [createdProject, effectiveServerId, servers, availableProjects]);

  // Available agents: filter by server and order harnesses so shell is last
  const availableAgents = useMemo(() => {
    return agents
      .filter((a) => !effectiveServerId || !a.id.includes(':') || a.id.startsWith(`${effectiveServerId}:`))
      .sort((a, b) => {
        const aIsShell = a.harness === 'shell' || a.id.endsWith(':shell') || a.id === 'agent-shell';
        const bIsShell = b.harness === 'shell' || b.id.endsWith(':shell') || b.id === 'agent-shell';
        if (aIsShell && !bIsShell) return 1;
        if (!aIsShell && bIsShell) return -1;
        return 0;
      });
  }, [agents, effectiveServerId]);

  // Keep project selection valid
  useEffect(() => {
    // If a newly created project is in the process of switching hosts, don't preemptively select the first project
    if (createdProject) {
      const createdKey = `${createdProject.serverId}:${createdProject.projectId}`;
      if (lastConsumedCreatedProjectRef.current !== createdKey) {
        return;
      }
    }
    if (availableProjects.length > 0) {
      if (!projectId || !availableProjects.some((p) => p.id === projectId)) {
        setProjectId(availableProjects[0].id);
      }
    } else {
      setProjectId('');
    }
  }, [availableProjects, projectId, createdProject]);

  // Keep agent selection valid
  useEffect(() => {
    if (availableAgents.length > 0) {
      if (!agentId || !availableAgents.some((a) => a.id === agentId)) {
        setAgentId(availableAgents[0].id);
      }
    } else {
      setAgentId('');
    }
  }, [availableAgents, agentId]);

  // Two-tier agent grouping
  const groupedAgents = useMemo(() => {
    const map = new Map<string, Agent[]>();
    for (const a of availableAgents) {
      const key = getAgentProvider(a);
      const list = map.get(key) || [];
      list.push(a);
      map.set(key, list);
    }
    return map;
  }, [availableAgents]);

  const orderedProviders = useMemo(() => {
    const available = new Set<string>();
    for (const a of availableAgents) {
      available.add(getAgentProvider(a));
    }

    const order: string[] = [];
    for (const canonical of CANONICAL_PROVIDER_ORDER) {
      if (canonical !== 'shell' && available.has(canonical)) {
        order.push(canonical);
      }
    }

    // Include any other non-shell providers not in CANONICAL_PROVIDER_ORDER
    for (const p of available) {
      if (p !== 'shell' && !order.includes(p)) {
        order.push(p);
      }
    }

    if (available.has('shell')) {
      order.push('shell');
    }
    return order;
  }, [availableAgents]);

  const currentAgent = useMemo(() => {
    return availableAgents.find((a) => a.id === agentId) || availableAgents[0];
  }, [availableAgents, agentId]);

  const selectedProvider = useMemo(() => {
    if (currentAgent) {
      return getAgentProvider(currentAgent);
    }
    return orderedProviders[0] || 'shell';
  }, [currentAgent, orderedProviders]);

  const currentProviderAgents = useMemo(() => {
    return groupedAgents.get(selectedProvider) || [];
  }, [groupedAgents, selectedProvider]);

  const handleSelectProvider = useCallback(
    (pKey: string) => {
      const agentsInGroup = groupedAgents.get(pKey) || [];
      if (agentsInGroup.length > 0) {
        if (!agentsInGroup.some((a) => a.id === agentId)) {
          setAgentId(agentsInGroup[0].id);
        }
      }
    },
    [groupedAgents, agentId]
  );

  // Auto-generate task description from current selection
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

  // Project base branch: update only when selected project changes
  const prevProjectIdRef = useRef<string>(projectId);
  useEffect(() => {
    if (prevProjectIdRef.current !== projectId) {
      prevProjectIdRef.current = projectId;
      const selectedProj = projects.find((project) => project.id === projectId);
      if (selectedProj?.baseBranch) {
        setBaseBranch(selectedProj.baseBranch);
      } else {
        setBaseBranch('');
      }
    }
  }, [projectId, projects]);

  // If the selected project does not support worktree, turn it off
  useEffect(() => {
    if (!projectId) {
      setUseWorktree(false);
      return;
    }
    const proj = projects.find((p) => p.id === projectId);
    const catHost =
      catalog?.hosts[effectiveServerId] ||
      (effectiveServerId ? Object.values(catalog?.hosts || {}).find((h) => h.name === effectiveServerId) : undefined);
    const catProj = catHost?.projects
      ? Object.entries(catHost.projects).find(
          ([key, p]) => key === projectId || `${effectiveServerId}:${key}` === projectId || p.path === proj?.rootPath
        )?.[1]
      : undefined;
    const isConfigured = Boolean(catProj?.worktree?.enabled);
    if (!isConfigured) {
      setUseWorktree(false);
    }
  }, [projectId, effectiveServerId, catalog, projects]);

  // Filtered projects for searchable combobox
  const filteredProjects = useMemo(() => {
    if (!projectSearchQuery.trim()) return availableProjects;
    const q = projectSearchQuery.toLowerCase().trim();
    return availableProjects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.rootPath.toLowerCase().includes(q)
    );
  }, [availableProjects, projectSearchQuery]);

  interface ProjectOptionItem {
    value: string;
    label: string;
    detail?: string;
    icon: React.ReactNode;
    shortcut?: string;
  }

  const projectComboboxOptions = useMemo<ProjectOptionItem[]>(() => {
    const items: ProjectOptionItem[] = filteredProjects.map((p) => ({
      value: p.id,
      label: p.name,
      detail: p.rootPath,
      icon: <FolderGit2 className="w-4 h-4 text-zinc-400 shrink-0" />,
    }));
    if (onOpenNewProject) {
      items.push({
        value: NEW_PROJECT_OPTION_VALUE,
        label: '+ New Project...',
        detail: 'Register or clone a repository on this host',
        icon: <Sparkles className="w-4 h-4 text-emerald-400 shrink-0" />,
        shortcut: 'N',
      });
    }
    return items;
  }, [filteredProjects, onOpenNewProject]);

  // Scroll active item into view in project list
  useEffect(() => {
    if (isProjectOpen && projectListRef.current) {
      const activeEl = projectListRef.current.querySelector<HTMLElement>(`[data-index="${highlightedProjectIdx}"]`);
      activeEl?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [isProjectOpen, highlightedProjectIdx]);

  const handleProjectSelect = useCallback(
    (newVal: string) => {
      if (newVal === NEW_PROJECT_OPTION_VALUE) {
        setIsProjectOpen(false);
        setProjectSearchQuery('');
        onOpenNewProject?.(effectiveServerId);
        return;
      }
      setProjectId(newVal);
      setIsProjectOpen(false);
      setProjectSearchQuery('');
    },
    [onOpenNewProject, effectiveServerId]
  );

  const handleServerChange = useCallback((newServerId: string) => {
    setServerId(newServerId);
    setHostTestStatus('idle');
    setHostTestResult(null);
  }, []);

  const handleHostKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, currentIdx: number) => {
      if (servers.length === 0) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const numIdx = NUMBER_SHORTCUTS.indexOf(e.key);
      if (numIdx !== -1 && numIdx < servers.length) {
        e.preventDefault();
        e.stopPropagation();
        handleServerChange(servers[numIdx].id);
        const buttons = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button[role="radio"]');
        buttons?.[numIdx]?.focus();
        return;
      }

      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        const nextIdx = (currentIdx + 1) % servers.length;
        handleServerChange(servers[nextIdx].id);
        const buttons = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button[role="radio"]');
        buttons?.[nextIdx]?.focus();
        return;
      }

      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        const prevIdx = (currentIdx - 1 + servers.length) % servers.length;
        handleServerChange(servers[prevIdx].id);
        const buttons = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button[role="radio"]');
        buttons?.[prevIdx]?.focus();
        return;
      }

      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleServerChange(servers[currentIdx].id);
      }
    },
    [servers, handleServerChange]
  );

  const handleProjectKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const isInput = (e.target as HTMLElement)?.tagName?.toLowerCase() === 'input';

      // 'n' or 'N' shortcut to trigger + New Project...
      // Only trigger if focus is outside the text search input (e.g. on trigger button or listbox)
      if (e.key.toLowerCase() === 'n' && onOpenNewProject && !isInput) {
        e.preventDefault();
        e.stopPropagation();
        setIsProjectOpen(false);
        setProjectSearchQuery('');
        onOpenNewProject(effectiveServerId);
        return;
      }

      // 1..0 number shortcuts: only when not typing inside the text input
      const numIdx = NUMBER_SHORTCUTS.indexOf(e.key);
      if (numIdx !== -1 && numIdx < projectComboboxOptions.length && !isInput) {
        e.preventDefault();
        e.stopPropagation();
        handleProjectSelect(projectComboboxOptions[numIdx].value);
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!isProjectOpen) {
          setIsProjectOpen(true);
          const currentIdx = projectComboboxOptions.findIndex((opt) => opt.value === projectId);
          setHighlightedProjectIdx(currentIdx >= 0 ? currentIdx : 0);
        } else {
          setHighlightedProjectIdx((prev) => Math.min(prev + 1, projectComboboxOptions.length - 1));
        }
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!isProjectOpen) {
          setIsProjectOpen(true);
          const currentIdx = projectComboboxOptions.findIndex((opt) => opt.value === projectId);
          setHighlightedProjectIdx(currentIdx >= 0 ? currentIdx : 0);
        } else {
          setHighlightedProjectIdx((prev) => Math.max(prev - 1, 0));
        }
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        if (isProjectOpen && projectComboboxOptions[highlightedProjectIdx]) {
          handleProjectSelect(projectComboboxOptions[highlightedProjectIdx].value);
        } else {
          setIsProjectOpen(true);
        }
        return;
      }

      if (e.key === 'Escape' && isProjectOpen) {
        e.preventDefault();
        e.stopPropagation();
        setIsProjectOpen(false);
        setProjectSearchQuery('');
        return;
      }
    },
    [
      onOpenNewProject,
      serverId,
      projectSearchQuery,
      projectComboboxOptions,
      highlightedProjectIdx,
      isProjectOpen,
      projectId,
      handleProjectSelect,
    ]
  );

  const handleProviderKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, currentIdx: number) => {
      if (orderedProviders.length === 0) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const numIdx = NUMBER_SHORTCUTS.indexOf(e.key);
      if (numIdx !== -1 && numIdx < orderedProviders.length) {
        e.preventDefault();
        e.stopPropagation();
        handleSelectProvider(orderedProviders[numIdx]);
        const buttons = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button[role="radio"]');
        buttons?.[numIdx]?.focus();
        return;
      }

      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        const nextIdx = (currentIdx + 1) % orderedProviders.length;
        handleSelectProvider(orderedProviders[nextIdx]);
        const buttons = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button[role="radio"]');
        buttons?.[nextIdx]?.focus();
        return;
      }

      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        const prevIdx = (currentIdx - 1 + orderedProviders.length) % orderedProviders.length;
        handleSelectProvider(orderedProviders[prevIdx]);
        const buttons = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button[role="radio"]');
        buttons?.[prevIdx]?.focus();
        return;
      }
    },
    [orderedProviders, handleSelectProvider]
  );

  const handleTaskChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setTask(val);
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

  const catalogHost =
    catalog?.hosts[effectiveServerId] ||
    (effectiveServerId ? Object.values(catalog?.hosts || {}).find((h) => h.name === effectiveServerId) : undefined);
  const catalogProject = catalogHost?.projects
    ? Object.entries(catalogHost.projects).find(
        ([key, p]) => key === projectId || `${effectiveServerId}:${key}` === projectId || p.path === selectedProject?.rootPath
      )?.[1]
    : undefined;

  const isWorktreeConfigured = Boolean(catalogProject?.worktree?.enabled);

  // Slugification rule: lowercase, hyphens, alphanumeric only, max 30 chars
  const slug =
    task
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
    if (!effectiveServerId) {
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
        serverId: effectiveServerId,
        projectId,
        agentId,
        task: task.trim(),
        baseBranch: isEffectiveWorktree ? baseBranch.trim() || undefined : undefined,
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
      <div className="bg-[#161b22] border border-[#30363d] rounded-xl shadow-2xl w-full max-w-xl overflow-hidden flex flex-col max-h-[92vh]">
        {/* Modal Header */}
        <div className="h-14 px-5 border-b border-[#30363d] flex items-center justify-between bg-[#12161c] shrink-0">
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
        <form onSubmit={handleSubmit} className="p-5 space-y-4 overflow-y-auto">
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

          {/* Target Host Selection (1-click segmented pill picker) */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                <ServerIcon className="w-3.5 h-3.5 text-zinc-400" />
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
                        className="flex items-center gap-0.5 text-zinc-400 hover:text-emerald-300 font-mono transition-colors cursor-pointer px-1.5 py-0.5 bg-[#21262d] rounded border border-[#30363d]"
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

            {/* Hidden native select for backwards compatibility */}
            <select
              data-testid="select-server"
              value={effectiveServerId}
              onChange={(e) => handleServerChange(e.target.value)}
              disabled={isSubmitting}
              aria-hidden="true"
              tabIndex={-1}
              className="sr-only"
            >
              {servers.length === 0 ? (
                <option value="">No hosts configured</option>
              ) : (
                servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.host})
                  </option>
                ))
              )}
            </select>

            {/* Segmented Pill Selector (1-click picking) */}
            <div
              role="radiogroup"
              aria-label="Target Host"
              data-testid="host-pill-group"
              className="flex flex-wrap gap-2"
            >
              {servers.length === 0 ? (
                <button
                  ref={serverTriggerRef}
                  type="button"
                  data-testid="select-server-trigger"
                  disabled
                  className="w-full min-h-[38px] px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs text-zinc-500 text-left cursor-not-allowed"
                >
                  No hosts configured
                </button>
              ) : (
                servers.map((s, idx) => {
                  const isSelected = s.id === effectiveServerId;
                  const isLocal = isLocalHost(s.host);
                  const health = hostHealthMap[s.id];
                  const shortcut = idx < 10 ? NUMBER_SHORTCUTS[idx] : null;

                  return (
                    <button
                      key={s.id}
                      ref={isSelected ? serverTriggerRef : undefined}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      tabIndex={isSelected ? 0 : -1}
                      autoFocus={isOpen && isSelected}
                      disabled={isSubmitting}
                      data-testid={isSelected ? 'select-server-trigger' : `host-pill-${s.id}`}
                      onClick={() => handleServerChange(s.id)}
                      onKeyDown={(e) => handleHostKeyDown(e, idx)}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs transition-all cursor-pointer select-none disabled:opacity-50 disabled:cursor-not-allowed ${
                        isSelected
                          ? 'bg-emerald-500/15 border-emerald-500/60 text-white shadow-sm ring-1 ring-emerald-500/30'
                          : 'bg-[#0d1117] border-[#30363d] text-zinc-300 hover:bg-[#1c2128] hover:border-zinc-500'
                      }`}
                    >
                      <span className="contents">
                        <OsIcon osName={`${s.name} ${s.host}`} className="w-4 h-4 shrink-0" />
                        <span className="font-medium truncate max-w-[140px]">{s.name}</span>
                        {/* Local vs Remote indicator */}
                        {isLocal ? (
                          <span
                            data-testid="host-badge-local"
                            className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/25 font-mono shrink-0"
                          >
                            Local
                          </span>
                        ) : (
                          <span
                            data-testid="host-badge-remote"
                            className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400 border border-purple-500/25 font-mono shrink-0"
                          >
                            Remote
                          </span>
                        )}
                        {/* Latency */}
                        {health?.latencyMs !== undefined && health.status !== 'unreachable' && (
                          <span data-testid="host-latency" className="text-[10px] text-zinc-400 font-mono shrink-0">
                            {health.latencyMs}ms
                          </span>
                        )}
                        {health?.status === 'unreachable' && (
                          <span className="text-[10px] text-rose-400 font-mono shrink-0">offline</span>
                        )}
                        {shortcut && (
                          <kbd className="text-[10px] font-mono text-zinc-500 bg-[#161b22] border border-[#30363d] px-1 rounded shrink-0">
                            {shortcut}
                          </kbd>
                        )}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Searchable Project Combobox */}
          <div ref={projectComboboxRef} className="relative space-y-1.5">
            <label className="block text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-zinc-400" />
              <span>Project Root</span>
            </label>

            {/* Hidden native select for backwards compatibility */}
            <select
              data-testid="select-project"
              value={projectId}
              onChange={(e) => handleProjectSelect(e.target.value)}
              disabled={isSubmitting}
              aria-hidden="true"
              tabIndex={-1}
              className="sr-only"
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
              {onOpenNewProject && (
                <option value={NEW_PROJECT_OPTION_VALUE}>+ New Project...</option>
              )}
            </select>

            {/* Searchable Combobox Input & Trigger */}
            <div data-testid="select-project-combobox" className="relative flex items-center">
              <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-zinc-400">
                <Search className="w-3.5 h-3.5" />
              </div>

              <input
                ref={projectInputRef}
                type="text"
                role="combobox"
                aria-expanded={isProjectOpen}
                aria-haspopup="listbox"
                aria-autocomplete="list"
                data-testid="select-project-input"
                disabled={isSubmitting || (availableProjects.length === 0 && !onOpenNewProject)}
                placeholder={
                  availableProjects.length === 0
                    ? onOpenNewProject
                      ? 'No projects for host. Press N to add...'
                      : 'No projects for host'
                    : selectedProject
                      ? `${selectedProject.name} (${selectedProject.rootPath})`
                      : 'Search projects by name or path...'
                }
                value={isProjectOpen ? projectSearchQuery : selectedProject ? selectedProject.name : ''}
                onFocus={() => {
                  if (availableProjects.length > 0 || onOpenNewProject) {
                    setIsProjectOpen(true);
                    setProjectSearchQuery('');
                    const curIdx = projectComboboxOptions.findIndex((opt) => opt.value === projectId);
                    setHighlightedProjectIdx(curIdx >= 0 ? curIdx : 0);
                  }
                }}
                onChange={(e) => {
                  setProjectSearchQuery(e.target.value);
                  setIsProjectOpen(true);
                  setHighlightedProjectIdx(0);
                }}
                onKeyDown={handleProjectKeyDown}
                className="w-full min-h-[38px] pl-9 pr-9 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
              />

              <button
                type="button"
                data-testid="select-project-trigger"
                aria-label="Toggle project list"
                aria-haspopup="listbox"
                aria-expanded={isProjectOpen}
                disabled={isSubmitting || (availableProjects.length === 0 && !onOpenNewProject)}
                tabIndex={0}
                onKeyDown={handleProjectKeyDown}
                onClick={() => {
                  if (availableProjects.length === 0 && !onOpenNewProject) return;
                  setIsProjectOpen((prev) => {
                    const next = !prev;
                    if (next) {
                      const curIdx = projectComboboxOptions.findIndex((opt) => opt.value === projectId);
                      setHighlightedProjectIdx(curIdx >= 0 ? curIdx : 0);
                    }
                    return next;
                  });
                  if (!isProjectOpen) {
                    projectInputRef.current?.focus();
                  }
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
              >
                {availableProjects.length === 0 && !onOpenNewProject && (
                  <span className="sr-only">No projects for host</span>
                )}
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isProjectOpen ? 'rotate-180' : ''}`} />
              </button>
            </div>

            {/* Filtered Dropdown list */}
            {isProjectOpen && (
              <div
                ref={projectListRef}
                role="listbox"
                aria-label="select-project"
                className="absolute left-0 right-0 top-[calc(100%+4px)] z-30 max-h-56 overflow-y-auto rounded-lg border border-[#30363d] bg-[#161b22] p-1 shadow-2xl"
              >
                {projectComboboxOptions.length === 0 ? (
                  <div className="p-3 text-xs text-zinc-500 text-center">No matching projects</div>
                ) : (
                  projectComboboxOptions.map((opt, index) => {
                    const isSelected = opt.value === projectId;
                    const isHighlighted = index === highlightedProjectIdx;
                    const shortcutBadge = opt.shortcut || (index < 10 ? NUMBER_SHORTCUTS[index] : null);

                    return (
                      <button
                        key={opt.value}
                        type="button"
                        role="option"
                        tabIndex={-1}
                        data-index={index}
                        aria-selected={isSelected}
                        onMouseEnter={() => setHighlightedProjectIdx(index)}
                        onClick={() => handleProjectSelect(opt.value)}
                        className={`w-full flex items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors cursor-pointer ${
                          isHighlighted
                            ? isSelected
                              ? 'bg-emerald-500/20 text-emerald-200'
                              : 'bg-[#21262d] text-zinc-100'
                            : isSelected
                              ? 'bg-emerald-500/10 text-emerald-300'
                              : 'text-zinc-200 hover:bg-[#21262d]'
                        }`}
                      >
                        {opt.icon}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium">{opt.label}</span>
                          {opt.detail && (
                            <span className="block truncate text-[10px] text-zinc-400">{opt.detail}</span>
                          )}
                        </span>
                        {shortcutBadge && (
                          <kbd className="text-[10px] font-mono text-zinc-400 bg-[#0d1117] border border-[#30363d] px-1.5 py-0.5 rounded shrink-0">
                            {shortcutBadge}
                          </kbd>
                        )}
                        {isSelected && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>

          {/* Two-Tier Agent Selection (Provider -> Profile) */}
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
              <Bot className="w-3.5 h-3.5 text-zinc-400" />
              <span>Agent Harness</span>
            </label>

            {/* Hidden native select for backwards compatibility */}
            <select
              data-testid="select-agent"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              disabled={isSubmitting}
              aria-hidden="true"
              tabIndex={-1}
              className="sr-only"
            >
              {availableAgents.length === 0 ? (
                <option value="">No harnesses for host</option>
              ) : (
                availableAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.command})
                  </option>
                ))
              )}
            </select>

            {/* Tier 1: Primary Providers */}
            <div
              role="radiogroup"
              aria-label="Agent Provider"
              data-testid="agent-provider-group"
              className="flex flex-wrap gap-2"
            >
              {availableAgents.length === 0 ? (
                <button
                  type="button"
                  data-testid="select-agent-trigger"
                  disabled
                  className="w-full min-h-[38px] px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs text-zinc-500 text-left cursor-not-allowed"
                >
                  No harnesses for host
                </button>
              ) : (
                orderedProviders.map((pKey, idx) => {
                  const isSelected = selectedProvider === pKey;
                  const count = groupedAgents.get(pKey)?.length || 0;
                  const displayName =
                    pKey === 'shell' ? 'Interactive Shell' : getProviderDisplayName(pKey as ProviderType);
                  const shortcut = idx < 10 ? NUMBER_SHORTCUTS[idx] : null;

                  return (
                    <button
                      key={pKey}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      tabIndex={isSelected ? 0 : -1}
                      disabled={isSubmitting}
                      data-testid={isSelected ? 'select-agent-trigger' : `provider-radio-${pKey}`}
                      onClick={() => handleSelectProvider(pKey)}
                      onKeyDown={(e) => handleProviderKeyDown(e, idx)}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs transition-all cursor-pointer select-none disabled:opacity-50 disabled:cursor-not-allowed ${
                        isSelected
                          ? 'bg-emerald-500/15 border-emerald-500/60 text-white shadow-sm ring-1 ring-emerald-500/30'
                          : 'bg-[#0d1117] border-[#30363d] text-zinc-300 hover:bg-[#1c2128] hover:border-zinc-500'
                      }`}
                    >
                      <span className="contents">
                        <AgentIcon
                          type={pKey === 'shell' ? 'none' : (pKey as ProviderType)}
                          harness={pKey === 'shell' ? 'shell' : undefined}
                          className="w-4 h-4 shrink-0"
                        />
                        <span className="font-medium">{displayName}</span>
                        {count > 1 && (
                          <span className="text-[10px] px-1.5 py-0.2 rounded bg-zinc-800 text-zinc-400 font-mono">
                            {count}
                          </span>
                        )}
                        {shortcut && (
                          <kbd className="text-[10px] font-mono text-zinc-500 bg-[#161b22] border border-[#30363d] px-1 rounded shrink-0">
                            {shortcut}
                          </kbd>
                        )}
                      </span>
                    </button>
                  );
                })
              )}
            </div>

            {/* Tier 2: Profile Selection (when multi-profile or Hermes) */}
            {currentProviderAgents.length > 0 && (
              <div
                role="radiogroup"
                aria-label="Agent Profile"
                data-testid="agent-profile-selector"
                className="flex flex-wrap items-center gap-2 pt-1 pl-1"
              >
                <span className="text-[11px] font-medium text-zinc-400 mr-1">Profile:</span>
                {currentProviderAgents.map((ag) => {
                  const isProfileSelected = ag.id === agentId;
                  return (
                    <button
                      key={ag.id}
                      type="button"
                      role="radio"
                      aria-checked={isProfileSelected}
                      disabled={isSubmitting}
                      data-testid={`profile-pill-${ag.id}`}
                      onClick={() => setAgentId(ag.id)}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                        isProfileSelected
                          ? 'bg-emerald-500/20 border-emerald-500 text-emerald-200'
                          : 'bg-[#12161c] border-[#30363d] text-zinc-400 hover:text-zinc-200 hover:bg-[#1c2128]'
                      }`}
                    >
                      <AgentIcon
                        harness={ag.harness}
                        agentName={ag.name}
                        command={ag.command}
                        className="w-3.5 h-3.5 shrink-0"
                      />
                      <span>{ag.name}</span>
                      {ag.command && ag.command !== ag.name && (
                        <span className="text-[10px] text-zinc-500 font-mono">({ag.command})</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
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

          {/* Base Branch (if worktree active) */}
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

            <div className="space-y-1.5">
              {isWorktreeConfigured && useWorktree ? (
                <>
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
                    <span
                      data-testid="preview-task-branch"
                      className="truncate text-cyan-400 text-right max-w-[280px]"
                    >
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
                </>
              ) : (
                <div
                  className="flex items-baseline justify-between gap-3 group cursor-help"
                  title={`Project Path: ${previewBasePath}`}
                >
                  <span className="text-zinc-500 shrink-0">Project Path:</span>
                  <span className="truncate text-zinc-300 text-right max-w-[280px]">{previewBasePath}</span>
                </div>
              )}

              {/* Task Slug live preview */}
              <div
                className="flex items-baseline justify-between gap-3 cursor-help"
                title={`Task Slug: ${slug}`}
              >
                <span className="text-zinc-500 shrink-0">Task Slug:</span>
                <span data-testid="preview-slug" className="truncate text-zinc-300 text-right max-w-[280px]">
                  {slug}
                </span>
              </div>

              {/* tmux session preview */}
              <div
                className="flex items-baseline justify-between gap-3 pt-1.5 border-t border-[#21262d]/60 cursor-help"
                title={`tmux Session Target: ${previewTmux}`}
              >
                <span className="text-zinc-500 shrink-0">tmux Session:</span>
                <span data-testid="preview-tmux-session" className="truncate text-zinc-300 text-right max-w-[280px]">
                  {previewTmux}
                </span>
              </div>
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
