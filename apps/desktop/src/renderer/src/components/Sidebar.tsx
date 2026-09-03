import React, { useState, useEffect, useRef } from 'react';
import type {
  Session,
  Server,
  Project,
  Agent,
  HostSystemInfo,
  SessionStatusResult,
  HostHealthResult,
} from '@spawnea/domain';
import { StatusBadge } from './StatusBadge';
import { OsIcon } from './OsIcon';
import { AgentIcon } from './AgentIcon';
import { SessionSourceBadge } from './SessionSourceBadge';
import {
  Plus,
  RefreshCw,
  Search,
  Server as ServerIcon,
  Layers,
  Bot,
  GitBranch,
  GitFork,
  Terminal,
  FileCode,
  AlertTriangle,

  ListFilter,
  Folder,
  MessageSquare,
  CheckCircle2,
  Unplug,
  Radio,
  PanelLeftClose,
  PanelLeftOpen,
  MoreHorizontal,
  Settings,
  Radar,
  LayoutGrid,
  List,
  Gauge,
  FileDiff,
  ChevronDown,
} from 'lucide-react';

export type GroupingMode = 'all' | 'host' | 'project' | 'harness';
export type StatusFilterMode = 'all' | 'needs_attention' | 'working' | 'idle_done' | 'disconnected';
export type SessionLayoutPreference = 'auto' | 'comfortable' | 'dense';

export const DENSE_SESSION_THRESHOLD = 8;
export const SESSION_PATH_MAX_LENGTH = 40;

function abbreviatePathSegment(segment: string): string {
  if (segment === '~') return segment;
  if (segment.startsWith('.') && segment.length > 1) {
    return `.${Array.from(segment.slice(1))[0]}`;
  }
  return Array.from(segment)[0] ?? segment;
}

export function formatSessionPath(
  path: string,
  maxLength = SESSION_PATH_MAX_LENGTH
): string {
  if (path.length <= maxLength) return path;
  if (maxLength <= 3) return '.'.repeat(Math.max(0, maxLength));

  const isAbsolute = path.startsWith('/');
  const segments = path.split('/').filter(Boolean);
  const abbreviatedPath = segments.length > 1
    ? `${isAbsolute ? '/' : ''}${segments
        .map((segment, index) => index === segments.length - 1 ? segment : abbreviatePathSegment(segment))
        .join('/')}`
    : path;

  return abbreviatedPath.length > maxLength
    ? `${abbreviatedPath.slice(0, maxLength - 3)}...`
    : abbreviatedPath;
}

export function resolveDenseSessionLayout(
  preference: SessionLayoutPreference,
  visibleSessionCount: number
): boolean {
  return preference === 'dense'
    || (preference === 'auto' && visibleSessionCount >= DENSE_SESSION_THRESHOLD);
}

export function HostHealthDot({
  health,
  className = '',
  showLatency = false,
}: {
  health?: HostHealthResult;
  className?: string;
  showLatency?: boolean;
}): React.JSX.Element {
  if (!health) {
    return (
      <span
        data-testid="host-health-dot"
        className={`inline-block w-2 h-2 rounded-full bg-zinc-600 shrink-0 ${className}`}
        title="Connectivity: Not checked yet"
      />
    );
  }

  let colorClass = 'bg-zinc-500';
  let title = `Host: ${health.hostId}\nStatus: Unknown`;

  if (health.status === 'healthy') {
    colorClass = 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]';
    title = `Host: ${health.hostId}\nStatus: Healthy\nLatency: ${health.latencyMs ?? 0}ms\nTarget: ${health.target}`;
  } else if (health.status === 'degraded') {
    colorClass = 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.6)]';
    title = `Host: ${health.hostId}\nStatus: Degraded (High latency or warning)\nLatency: ${health.latencyMs ?? 0}ms\n${health.details || ''}\nTarget: ${health.target}`;
  } else if (health.status === 'unreachable') {
    colorClass = 'bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.6)]';
    title = `Host: ${health.hostId}\nStatus: Unreachable\nError: ${health.error || 'Connection failed'}\nTarget: ${health.target}`;
  } else if (health.status === 'checking') {
    colorClass = 'bg-sky-400 animate-pulse';
    title = `Host: ${health.hostId}\nStatus: Checking connectivity...`;
  }

  return (
    <span
      data-testid={`host-health-dot-${health.hostId}`}
      data-status={health.status}
      className="inline-flex items-center gap-1 shrink-0"
      title={title}
    >
      <span className={`inline-block w-2 h-2 rounded-full ${colorClass} ${className}`} />
      {showLatency && health.latencyMs !== undefined && health.status !== 'unreachable' && (
        <span className="text-[10px] font-mono text-zinc-400">{health.latencyMs}ms</span>
      )}
    </span>
  );
}

interface SidebarProps {
  sessions: Session[];
  servers: Server[];
  projects: Project[];
  agents: Agent[];
  hostInfoMap?: Record<string, HostSystemInfo>;
  hostHealthMap?: Record<string, HostHealthResult>;
  statusDetailsMap?: Record<string, SessionStatusResult>;
  gitDirtyBySessionId?: Record<string, boolean>;
  gitChangeCountBySessionId?: Record<string, number>;
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onOpenCreateModal: () => void;
  onOpenCreateChildModal?: (parentSessionId?: string) => void;
  onOpenNewProject?: () => void;
  onOpenLocalDiscovery?: () => void;
  onOpenSettings?: () => void;
  onOpenAdoptModal?: () => void;
  onRefresh: () => void;
  onReloadCatalog?: () => void;
  onCheckHostHealth?: (serverId?: string) => void;
  onDeleteSession?: (id: string) => void;
  onClearDoneSessions?: () => void;
  isReloadingCatalog?: boolean;
  catalogErrorCount?: number;
  catalogPath?: string;
  isLoading?: boolean;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}

const STORAGE_KEY_GROUPING = 'spawnea:sidebar:grouping';
const STORAGE_KEY_STATUS_FILTER = 'spawnea:sidebar:statusFilter';
export const STORAGE_KEY_SESSION_LAYOUT = 'spawnea:sidebar:sessionLayout';

function SidebarActionsMenu({
  onRefresh,
  onReloadCatalog,
  onOpenAdoptModal,
  onOpenNewProject,
  onOpenLocalDiscovery,
  onOpenSettings,
  isReloadingCatalog,
  isLoading,
  collapsed = false,
}: {
  onRefresh: () => void;
  onReloadCatalog?: () => void;
  onOpenAdoptModal?: () => void;
  onOpenNewProject?: () => void;
  onOpenLocalDiscovery?: () => void;
  onOpenSettings?: () => void;
  isReloadingCatalog: boolean;
  isLoading: boolean;
  collapsed?: boolean;
}): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const action = (callback?: () => void) => {
    setIsOpen(false);
    callback?.();
  };

  return (
    <div ref={menuRef} className={`relative ${collapsed ? 'w-8' : ''}`}>
      <button
        type="button"
        data-testid="sidebar-actions-menu-button"
        aria-label="More session actions"
        aria-expanded={isOpen}
        title="More actions"
        onClick={() => setIsOpen((open) => !open)}
        className={`${collapsed ? 'w-8 h-8' : 'p-1.5'} rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-[#21262d] transition-colors cursor-pointer flex items-center justify-center`}
      >
        <MoreHorizontal className={collapsed ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
      </button>
      {isOpen && (
        <div
          role="menu"
          data-testid="sidebar-actions-menu"
          className={`absolute top-full mt-1 w-48 rounded-lg border border-[#30363d] bg-[#161b22] p-1 shadow-xl z-50 ${collapsed ? 'left-full ml-2' : 'right-0'}`}
        >
          {onReloadCatalog && (
            <button
              type="button"
              role="menuitem"
              data-testid="sidebar-reload-catalog-button"
              onClick={() => action(onReloadCatalog)}
              className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-xs text-zinc-300 hover:bg-[#21262d] hover:text-white cursor-pointer"
            >
              <FileCode className={`w-3.5 h-3.5 ${isReloadingCatalog ? 'animate-spin text-emerald-400' : ''}`} />
              Reload config
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            data-testid="sidebar-refresh-sessions-button"
            onClick={() => action(onRefresh)}
            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-xs text-zinc-300 hover:bg-[#21262d] hover:text-white cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-emerald-400' : ''}`} />
            Refresh sessions
          </button>
          {onOpenAdoptModal && (
            <button
              type="button"
              role="menuitem"
              data-testid="sidebar-adopt-session-button"
              onClick={() => action(onOpenAdoptModal)}
              className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-xs text-zinc-300 hover:bg-[#21262d] hover:text-white cursor-pointer"
            >
              <Radio className="w-3.5 h-3.5 text-cyan-300" />
              Adopt session
            </button>
          )}
          {onOpenNewProject && (
            <button
              type="button"
              role="menuitem"
              data-testid="sidebar-new-project-button"
              onClick={() => action(onOpenNewProject)}
              className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-xs text-zinc-300 hover:bg-[#21262d] hover:text-white cursor-pointer"
            >
              <Folder className="w-3.5 h-3.5 text-emerald-300" />
              New project
            </button>
          )}
          {onOpenLocalDiscovery && (
            <button
              type="button"
              role="menuitem"
              data-testid="sidebar-local-discovery-button"
              onClick={() => action(onOpenLocalDiscovery)}
              className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-xs text-zinc-300 hover:bg-[#21262d] hover:text-white cursor-pointer"
            >
              <Radar className="w-3.5 h-3.5 text-cyan-300" />
              Discover local setup…
            </button>
          )}
          {onOpenSettings && (
            <button
              type="button"
              role="menuitem"
              data-testid="sidebar-settings-button"
              onClick={() => action(onOpenSettings)}
              className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-xs text-zinc-300 hover:bg-[#21262d] hover:text-white cursor-pointer"
            >
              <Settings className="w-3.5 h-3.5" />
              Settings
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function Sidebar({
  sessions,
  servers,
  projects,
  agents,
  hostInfoMap,
  hostHealthMap = {},
  statusDetailsMap = {},
  gitDirtyBySessionId = {},
  gitChangeCountBySessionId = {},
  activeSessionId,
  onSelectSession,
  onOpenCreateModal,
  onOpenCreateChildModal,
  onOpenNewProject,
  onOpenLocalDiscovery,
  onOpenSettings,
  onOpenAdoptModal,
  onRefresh,
  onReloadCatalog,
  onCheckHostHealth,
  onDeleteSession: _onDeleteSession,
  onClearDoneSessions,
  isReloadingCatalog = false,
  catalogErrorCount = 0,
  catalogPath,
  isLoading = false,
  isCollapsed: externalIsCollapsed,
  onToggleCollapse,
}: SidebarProps): React.JSX.Element {
  const [searchTerm, setSearchTerm] = useState('');

  // Preference persistence (Task 2.3.4)
  const [groupingMode, setGroupingMode] = useState<GroupingMode>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_GROUPING);
      if (saved === 'all' || saved === 'host' || saved === 'project' || saved === 'harness') {
        return saved;
      }
    } catch {}
    return 'all';
  });

  const [statusFilter, setStatusFilter] = useState<StatusFilterMode>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_STATUS_FILTER);
      if (
        saved === 'all' ||
        saved === 'needs_attention' ||
        saved === 'working' ||
        saved === 'idle_done' ||
        saved === 'disconnected'
      ) {
        return saved;
      }
    } catch {}
    return 'all';
  });

  const [sessionLayoutPreference, setSessionLayoutPreference] = useState<SessionLayoutPreference>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_SESSION_LAYOUT);
      if (saved === 'auto' || saved === 'comfortable' || saved === 'dense') return saved;
    } catch {}
    return 'auto';
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_GROUPING, groupingMode);
    } catch {}
  }, [groupingMode]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_STATUS_FILTER, statusFilter);
    } catch {}
  }, [statusFilter]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_SESSION_LAYOUT, sessionLayoutPreference);
    } catch {}
  }, [sessionLayoutPreference]);

  // Track acknowledged / seen attention alerts (Stack/Set of alertIds)
  const [acknowledgedAlerts, setAcknowledgedAlerts] = useState<Set<string>>(new Set());

  // Helper to build alertId
  const getAlertId = (sessId: string, status: string, promptOrReason?: string) => {
    return `${sessId}:${status}:${(promptOrReason || '').trim()}`;
  };

  // When activeSessionId changes or statusDetailsMap updates, mark the active session's alert as acknowledged
  useEffect(() => {
    if (!activeSessionId) return;
    const activeSession = sessions.find((s) => s.id === activeSessionId);
    if (!activeSession) return;
    if (activeSession.status === 'needs_input' || activeSession.status === 'error') {
      const details = statusDetailsMap[activeSessionId];
      const alertId = getAlertId(activeSessionId, activeSession.status, details?.detectedPrompt || details?.reason);
      setAcknowledgedAlerts((prev) => {
        if (prev.has(alertId)) return prev;
        const next = new Set(prev);
        next.add(alertId);
        return next;
      });
    }
  }, [activeSessionId, statusDetailsMap, sessions]);

  // Clean up acknowledged alerts for sessions that returned to normal working/idle
  useEffect(() => {
    setAcknowledgedAlerts((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const alertKey of prev) {
        const [sessId] = alertKey.split(':');
        const session = sessions.find((s) => s.id === sessId);
        if (!session || (session.status !== 'needs_input' && session.status !== 'error')) {
          next.delete(alertKey);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [sessions]);

  const [internalIsCollapsed, setInternalIsCollapsed] = useState(false);

  const isCollapsed = externalIsCollapsed !== undefined ? externalIsCollapsed : internalIsCollapsed;
  const toggleCollapse = () => {
    if (onToggleCollapse) {
      onToggleCollapse();
    } else {
      setInternalIsCollapsed((prev) => !prev);
    }
  };

  const getServer = (serverId: string) => servers.find((srv) => srv.id === serverId);
  const getProject = (projectId: string) => projects.find((p) => p.id === projectId);
  const getAgent = (agentId: string) => agents.find((a) => a.id === agentId);

  // Live counts for filter chips
  const countNeedsAttention = sessions.filter(
    (s) => s.status === 'needs_input' || s.status === 'error'
  ).length;
  const countUnacknowledgedAttention = sessions.filter((s) => {
    if (s.status !== 'needs_input' && s.status !== 'error') return false;
    const details = statusDetailsMap[s.id];
    const aId = getAlertId(s.id, s.status, details?.detectedPrompt || details?.reason);
    return !acknowledgedAlerts.has(aId) && s.id !== activeSessionId;
  }).length;
  const countWorking = sessions.filter((s) => s.status === 'working' || s.status === 'starting').length;
  const countIdleDone = sessions.filter((s) => s.status === 'idle' || s.status === 'done').length;
  const countDisconnected = sessions.filter((s) => s.status === 'disconnected').length;

  // Auto-reset status filter if current filter category becomes empty (count === 0)
  useEffect(() => {
    if (statusFilter === 'needs_attention' && countNeedsAttention === 0) {
      setStatusFilter('all');
    } else if (statusFilter === 'working' && countWorking === 0) {
      setStatusFilter('all');
    } else if (statusFilter === 'idle_done' && countIdleDone === 0) {
      setStatusFilter('all');
    } else if (statusFilter === 'disconnected' && countDisconnected === 0) {
      setStatusFilter('all');
    }
  }, [statusFilter, countNeedsAttention, countWorking, countIdleDone, countDisconnected]);

  // Group children under parents and track expandable parent cards
  const childrenByParentId = React.useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const s of sessions) {
      if (s.parentSessionId) {
        const list = map.get(s.parentSessionId) || [];
        list.push(s);
        map.set(s.parentSessionId, list);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) =>
        (a.childAlias || a.name).localeCompare(b.childAlias || b.name, undefined, {
          numeric: true,
          sensitivity: 'base',
        })
      );
    }
    return map;
  }, [sessions]);

  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());
  const toggleParentExpanded = (parentId: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      return next;
    });
  };

  // Target parent session for "+ Child" creation in sidebar header
  const targetParentSession = React.useMemo(() => {
    const active = sessions.find((s) => s.id === activeSessionId);
    if (!active) {
      return sessions.find((s) => !s.parentSessionId) || null;
    }
    if (active.parentSessionId) {
      return sessions.find((s) => s.id === active.parentSessionId) || active;
    }
    return active;
  }, [sessions, activeSessionId]);

  // Auto-expand parent if an active session is a child session
  useEffect(() => {
    if (!activeSessionId) return;
    const active = sessions.find((s) => s.id === activeSessionId);
    if (active?.parentSessionId) {
      setExpandedParents((prev) => {
        if (prev.has(active.parentSessionId!)) return prev;
        const next = new Set(prev);
        next.add(active.parentSessionId!);
        return next;
      });
    }
  }, [activeSessionId, sessions]);

  // Root sessions remain primary top-level list items (2-level hierarchy).
  // In Spawnea's session hierarchy, child sessions inherit their parent's serverId
  // and projectId (per docs/tasks/05-session-hierarchy-and-child-agents.md) and are
  // intentionally grouped with and rendered directly under their parent session card.
  const rootSessions = React.useMemo(() => {
    return sessions.filter((s) => !s.parentSessionId);
  }, [sessions]);

  const sessionMatchesStatus = (s: Session): boolean => {
    if (statusFilter === 'needs_attention') {
      return s.status === 'needs_input' || s.status === 'error';
    }
    if (statusFilter === 'working') {
      return s.status === 'working' || s.status === 'starting';
    }
    if (statusFilter === 'idle_done') {
      return s.status === 'idle' || s.status === 'done';
    }
    if (statusFilter === 'disconnected') {
      return s.status === 'disconnected';
    }
    return true;
  };

  const sessionMatchesSearch = (s: Session, term: string): boolean => {
    const server = getServer(s.serverId);
    const project = getProject(s.projectId);
    const agent = getAgent(s.agentId);

    return Boolean(
      s.name.toLowerCase().includes(term) ||
      s.task.toLowerCase().includes(term) ||
      s.branch.toLowerCase().includes(term) ||
      (s.childAlias ? s.childAlias.toLowerCase().includes(term) : false) ||
      s.tmuxSessionName.toLowerCase().includes(term) ||
      (server && (server.name.toLowerCase().includes(term) || server.host.toLowerCase().includes(term))) ||
      (project && (project.name.toLowerCase().includes(term) || project.rootPath.toLowerCase().includes(term))) ||
      (agent && (agent.name.toLowerCase().includes(term) || agent.command.toLowerCase().includes(term)))
    );
  };

  // Normalize search term once (trims leading/trailing whitespace and lowercases)
  const normalizedSearchTerm = searchTerm.trim().toLowerCase();
  const hasSearch = Boolean(normalizedSearchTerm);

  // Filter root sessions: matches if root session matches both filters,
  // or if any of its children matches both filters
  const filteredSessions = rootSessions.filter((s) => {
    const rootMatchesSearch = !hasSearch || sessionMatchesSearch(s, normalizedSearchTerm);
    const rootMatchesStatus = sessionMatchesStatus(s);

    if (rootMatchesSearch && rootMatchesStatus) return true;

    const children = childrenByParentId.get(s.id) || [];
    return children.some(
      (c) => sessionMatchesStatus(c) && (!hasSearch || sessionMatchesSearch(c, normalizedSearchTerm))
    );
  });

  // Sorting helper: strictly alphabetical by session name (A-Z)
  const sortSessions = (sessionList: Session[]) => {
    return [...sessionList].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
    );
  };

  const sortedFilteredSessions = sortSessions(filteredSessions);

  // Sessions requiring immediate attention in background (for top prioritized group - Task 2.2.2)
  // Suppress active session to avoid false alerts while user is actively typing in the tab

  // Grouping structures (FG-4.1.1, FG-4.1.2, FG-4.1.3)
  interface SessionGroup {
    id: string;
    title: string;
    subtitle?: string;
    icon: React.ComponentType<{ className?: string }>;
    sessions: Session[];
  }

  const buildGroups = (): SessionGroup[] => {
    if (groupingMode === 'host') {
      const groupMap = new Map<string, Session[]>();
      for (const s of filteredSessions) {
        const list = groupMap.get(s.serverId) || [];
        list.push(s);
        groupMap.set(s.serverId, list);
      }

      return Array.from(groupMap.entries())
        .map(([serverId, groupSessions]) => {
          const srv = getServer(serverId);
          const hostInfo = hostInfoMap?.[serverId];
          const osString = hostInfo?.osName || srv?.name || srv?.host;
          return {
            id: `host-${serverId}`,
            title: srv ? srv.name : serverId,
            subtitle: srv ? srv.host : undefined,
            icon: () => <OsIcon osName={osString} className="w-4 h-4 shrink-0" />,
            sessions: sortSessions(groupSessions),
          };
        })
        .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }));
    }

    if (groupingMode === 'project') {
      const groupMap = new Map<string, Session[]>();
      for (const s of filteredSessions) {
        const list = groupMap.get(s.projectId) || [];
        list.push(s);
        groupMap.set(s.projectId, list);
      }

      return Array.from(groupMap.entries())
        .map(([projectId, groupSessions]) => {
          const proj = getProject(projectId);
          return {
            id: `project-${projectId}`,
            title: proj ? proj.name : projectId,
            subtitle: proj ? proj.rootPath : undefined,
            icon: Folder,
            sessions: sortSessions(groupSessions),
          };
        })
        .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }));
    }

    if (groupingMode === 'harness') {
      const groupMap = new Map<string, Session[]>();
      for (const s of filteredSessions) {
        const list = groupMap.get(s.agentId) || [];
        list.push(s);
        groupMap.set(s.agentId, list);
      }

      return Array.from(groupMap.entries())
        .map(([agentId, groupSessions]) => {
          const ag = getAgent(agentId);
          return {
            id: `harness-${agentId}`,
            title: ag ? ag.name : agentId,
            subtitle: ag ? ag.command : undefined,
            icon: Bot,
            sessions: sortSessions(groupSessions),
          };
        })
        .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }));
    }

    return [];
  };

  const groups = buildGroups();

  const visibleSessions =
    groupingMode === 'all'
      ? sortedFilteredSessions
      : groups.flatMap((g) => g.sessions);

  const isDenseLayout = resolveDenseSessionLayout(
    sessionLayoutPreference,
    visibleSessions.length
  );
  const [denseHoveredSessionId, setDenseHoveredSessionId] = useState<string | null>(null);
  const [denseFocusedSessionId, setDenseFocusedSessionId] = useState<string | null>(null);

  useEffect(() => {
    if (denseHoveredSessionId
        && (!isDenseLayout || !visibleSessions.some((session) => session.id === denseHoveredSessionId))) {
      setDenseHoveredSessionId(null);
    }
    if (denseFocusedSessionId
        && (!isDenseLayout || !visibleSessions.some((session) => session.id === denseFocusedSessionId))) {
      setDenseFocusedSessionId(null);
    }
  }, [denseFocusedSessionId, denseHoveredSessionId, isDenseLayout, visibleSessions]);

  const shortcutLabels = new Map<string, string>();
  visibleSessions.slice(0, 10).forEach((s, idx) => {
    const num = idx === 9 ? 0 : idx + 1;
    shortcutLabels.set(s.id, `Ctrl-${num}`);
  });

  const renderChildListItem = (child: Session) => {
    const isSelected = child.id === activeSessionId;
    const statusDetails = statusDetailsMap[child.id];
    const alertId = getAlertId(child.id, child.status, statusDetails?.detectedPrompt || statusDetails?.reason);
    const isAcknowledged = acknowledgedAlerts.has(alertId);

    return (
      <button
        key={child.id}
        type="button"
        data-testid={`session-item-${child.id}`}
        aria-current={isSelected ? 'page' : undefined}
        onClick={() => onSelectSession(child.id)}
        className={`w-full flex items-center justify-between p-2 rounded-md border text-left transition-all cursor-pointer ${
          isSelected
            ? 'bg-purple-950/50 border-purple-500/70 text-white ring-1 ring-purple-500/30'
            : 'bg-[#12161c]/60 border-[#21262d] hover:bg-[#1f242c]/50 hover:border-purple-500/40 text-zinc-300'
        }`}
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span
            data-testid={`session-child-alias-${child.id}`}
            className="text-[10px] font-mono font-medium px-1.5 py-0.2 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30 shrink-0"
          >
            {child.childAlias || 'child'}
          </span>
          <span
            data-testid={`session-title-${child.id}`}
            className="text-xs truncate font-medium text-zinc-200"
            title={child.name}
          >
            {child.name}
          </span>
        </div>
        <StatusBadge
          status={child.status}
          isFocused={isSelected}
          isAcknowledged={isAcknowledged}
          iconOnly
          className="shrink-0 ml-1.5"
        />
      </button>
    );
  };

  // Consistent session card renderer (FG-4.1.4, FG-4.1.5)
  const renderSessionCard = (session: Session) => {
    const children = childrenByParentId.get(session.id) || [];
    const hasFilter = Boolean(normalizedSearchTerm || statusFilter !== 'all');
    const matchingChildren = hasFilter
      ? children.filter(
          (c) =>
            sessionMatchesStatus(c) &&
            (!normalizedSearchTerm || sessionMatchesSearch(c, normalizedSearchTerm))
        )
      : children;
    const isExpanded =
      expandedParents.has(session.id) ||
      (hasFilter && matchingChildren.length > 0);
    const visibleChildren = hasFilter ? matchingChildren : children;
    const isSelected = session.id === activeSessionId;
    const shortcut = shortcutLabels.get(session.id);
    const server = getServer(session.serverId);
    const hostInfo = hostInfoMap?.[session.serverId];
    const osString = hostInfo?.osName || server?.name || server?.host;
    const agent = getAgent(session.agentId);
    const project = getProject(session.projectId);
    const statusDetails = statusDetailsMap[session.id];
    const alertId = getAlertId(session.id, session.status, statusDetails?.detectedPrompt || statusDetails?.reason);
    const isAcknowledged = acknowledgedAlerts.has(alertId);

    // Primary descriptive title (prevents duplicate title/task text)
    const displayTitle = session.name || session.task;

    // Project root / worktree path
    const displayPath = session.worktreePath || project?.rootPath || session.projectId;
    const hasUncommittedChanges = gitDirtyBySessionId[session.id] === true;
    const gitChangeCount = gitChangeCountBySessionId[session.id] ?? (hasUncommittedChanges ? 1 : 0);
    const formattedPath = formatSessionPath(displayPath);

    const cardStyle = isSelected
      ? session.isExternal
        ? 'bg-[#1f242c] border-cyan-500/60 text-white shadow-md ring-1 ring-cyan-500/30'
        : 'bg-[#1f242c] border-emerald-500/50 text-white shadow-md ring-1 ring-emerald-500/20'
      : session.isExternal
      ? 'bg-[#12161c]/60 border-cyan-950/60 hover:bg-[#1f242c]/50 hover:border-cyan-800/50 text-zinc-300'
      : 'bg-[#12161c]/60 border-[#21262d] hover:bg-[#1f242c]/50 hover:border-[#30363d] text-zinc-300';

    const renderCardHeader = () => (
      <div className="flex items-center justify-between gap-1.5 w-full">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <OsIcon osName={osString} className="w-3.5 h-3.5 shrink-0" />
          <AgentIcon
            harness={agent?.harness}
            agentName={agent?.name || session.agentId}
            command={agent?.command}
            className="w-3.5 h-3.5 shrink-0"
          />
          <div className="flex items-center gap-1 min-w-0 font-mono text-[11px] text-zinc-400 truncate">
            <GitBranch className="w-3 h-3 text-zinc-500 shrink-0" />
            <span className="truncate" title={session.branch}>
              {session.branch}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <StatusBadge
            status={session.status}
            isFocused={isSelected}
            isAcknowledged={isAcknowledged}
            promptSnippet={statusDetails?.detectedPrompt}
            errorReason={statusDetails?.reason}
            iconOnly={true}
            className="shrink-0"
          />
          {shortcut && (
            <span
              data-testid={`session-shortcut-badge-${session.id}`}
              className="text-[9px] font-mono font-medium px-1 py-0.2 rounded bg-[#0d1117] text-zinc-400 border border-[#30363d] group-hover:text-emerald-300 group-hover:border-emerald-500/40 transition-colors shrink-0"
              title={`Keyboard shortcut: ${shortcut}`}
            >
              {shortcut}
            </span>
          )}
        </div>
      </div>
    );

    const renderCardTitle = () => (
      <div className="flex w-full min-w-0 items-center justify-between gap-1.5 overflow-hidden">
        <span
          data-testid={`session-title-${session.id}`}
          className="block min-w-0 max-w-full flex-1 truncate text-xs font-semibold leading-snug text-zinc-100"
          title={displayTitle}
        >
          {displayTitle}
        </span>
        {session.managedWorktree && (
          <span
            data-testid={`session-worktree-badge-${session.id}`}
            className="flex items-center gap-1 text-[9px] font-mono font-bold px-1.5 py-0.2 rounded bg-teal-950/80 text-teal-300 border border-teal-500/40 shrink-0"
            title={`Managed Git worktree\nBranch: ${session.branch}\nPath: ${displayPath}${hasUncommittedChanges ? '\nUncommitted Git changes' : ''}`}
          >
            <GitFork className="w-2.5 h-2.5" />
            <span>Worktree</span>
            {hasUncommittedChanges && (
              <span className="inline-flex items-center gap-0.5 text-amber-300" title={`${gitChangeCount} uncommitted Git change${gitChangeCount === 1 ? '' : 's'}`}>
                <FileDiff data-testid={`session-worktree-dirty-indicator-${session.id}`} aria-label="Uncommitted Git changes" className="w-2.5 h-2.5" />
                <span data-testid={`session-worktree-change-count-${session.id}`}>{gitChangeCount}</span>
              </span>
            )}
          </span>
        )}
        {!session.managedWorktree && hasUncommittedChanges && (
          <span className="inline-flex items-center gap-0.5 text-amber-300" title={`${gitChangeCount} uncommitted Git change${gitChangeCount === 1 ? '' : 's'}`}>
            <FileDiff data-testid={`session-git-dirty-indicator-${session.id}`} aria-label="Uncommitted Git changes" className="w-3 h-3" />
            <span data-testid={`session-git-change-count-${session.id}`}>{gitChangeCount}</span>
          </span>
        )}
        {session.isExternal && (
          <span
            data-testid={`session-external-badge-${session.id}`}
            className="text-[9px] font-mono font-bold px-1.5 py-0.2 rounded bg-cyan-950/80 text-cyan-300 border border-cyan-500/40 shrink-0"
            title="External tmux session adopted into Spawnea"
          >
            EXT
          </span>
        )}
        <SessionSourceBadge session={session} />
      </div>
    );

    const renderCardSnippets = () => (
      <>
        {session.status === 'needs_input' && statusDetails?.detectedPrompt && (
          <span
            data-testid={`session-prompt-snippet-${session.id}`}
            className="sr-only"
          >
            {statusDetails.detectedPrompt}
          </span>
        )}
        {session.status === 'error' && statusDetails?.reason && (
          <span
            data-testid={`session-error-snippet-${session.id}`}
            className="sr-only"
          >
            {statusDetails.reason}
          </span>
        )}
      </>
    );

    const renderCardFooter = () => (
      <div className="flex min-w-0 items-center justify-between text-[10px] text-zinc-500 pt-1 border-t border-[#262c36] gap-2">
        <span
          data-testid={`session-path-${session.id}`}
          className="min-w-0 truncate font-mono text-zinc-400 flex-1"
          title={displayPath}
        >
          {formattedPath}
        </span>
        <span
          className="truncate font-mono text-zinc-500 text-[10px] max-w-[80px] shrink-0"
          title={session.tmuxSessionName}
        >
          {session.tmuxSessionName}
        </span>
      </div>
    );

    if (children.length === 0) {
      return (
        <button
          type="button"
          key={session.id}
          data-testid={`session-item-${session.id}`}
          aria-current={isSelected ? 'page' : undefined}
          onClick={() => onSelectSession(session.id)}
          className={`group w-full min-w-0 text-left p-2.5 rounded-lg border transition-all cursor-pointer flex flex-col gap-1.5 relative ${cardStyle}`}
        >
          {renderCardHeader()}
          {renderCardTitle()}
          {renderCardSnippets()}
          {renderCardFooter()}
        </button>
      );
    }

    return (
      <div
        key={session.id}
        data-testid={`session-parent-group-${session.id}`}
        className="space-y-1"
      >
        <div
          className={`group w-full min-w-0 text-left p-2.5 rounded-lg border transition-all flex flex-col gap-1.5 relative ${cardStyle}`}
        >
          {/* Main button for session selection */}
          <button
            type="button"
            data-testid={`session-item-${session.id}`}
            aria-current={isSelected ? 'page' : undefined}
            onClick={() => onSelectSession(session.id)}
            className="w-full text-left flex flex-col gap-1.5 cursor-pointer focus:outline-none"
          >
            {renderCardHeader()}
            {renderCardTitle()}
            {renderCardSnippets()}
          </button>

          {/* Children expand/collapse combo in normal flow (below the name) */}
          <div className="flex items-center justify-between gap-1.5 w-full">
            <button
              type="button"
              data-testid={`session-toggle-children-${session.id}`}
              aria-label={`${isExpanded ? 'Hide' : 'Show'} ${children.length} child session${children.length === 1 ? '' : 's'}`}
              aria-expanded={isExpanded}
              aria-controls={`session-child-list-${session.id}`}
              onClick={(e) => {
                e.stopPropagation();
                toggleParentExpanded(session.id);
              }}
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono bg-purple-950/90 hover:bg-purple-900 text-purple-300 border border-purple-500/40 cursor-pointer transition-colors shadow-xs"
              title={`${children.length} child session${children.length === 1 ? '' : 's'} (click to ${isExpanded ? 'collapse' : 'expand'})`}
            >
              <GitFork className="w-2.5 h-2.5 text-purple-400" />
              <span>{children.length} child{children.length === 1 ? '' : 'ren'}</span>
              <ChevronDown className={`w-3 h-3 text-purple-400 transition-transform duration-150 ${isExpanded ? 'rotate-180' : ''}`} />
            </button>
          </div>

          {/* Card footer (Path + tmux session) */}
          <div
            onClick={() => onSelectSession(session.id)}
            className="cursor-pointer"
          >
            {renderCardFooter()}
          </div>
        </div>

        {isExpanded && (
          <div
            id={`session-child-list-${session.id}`}
            data-testid={`session-child-list-${session.id}`}
            className="ml-3 pl-2 border-l-2 border-purple-500/30 space-y-1 py-0.5 max-h-48 overflow-y-auto"
          >
            {visibleChildren.map((child) => renderChildListItem(child))}
          </div>
        )}
      </div>
    );
  };

  const renderDenseSessionCard = (session: Session) => {
    const children = childrenByParentId.get(session.id) || [];
    const isSelected = session.id === activeSessionId;
    const shortcut = shortcutLabels.get(session.id);
    const server = getServer(session.serverId);
    const project = getProject(session.projectId);
    const agent = getAgent(session.agentId);
    const statusDetails = statusDetailsMap[session.id];
    const alertId = getAlertId(session.id, session.status, statusDetails?.detectedPrompt || statusDetails?.reason);
    const isAcknowledged = acknowledgedAlerts.has(alertId);
    const displayTitle = session.name || session.task;
    const displayProject = project?.name || session.projectId;
    const displayPath = session.worktreePath || project?.rootPath || session.projectId;
    const hasUncommittedChanges = gitDirtyBySessionId[session.id] === true;
    const gitChangeCount = gitChangeCountBySessionId[session.id] ?? (hasUncommittedChanges ? 1 : 0);
    const descriptionId = `session-dense-description-${session.id}`;

    const denseCard = (
      <div
        key={session.id}
        data-testid={`session-dense-item-${session.id}`}
        className="group/dense relative min-w-0"
        onMouseEnter={() => setDenseHoveredSessionId(session.id)}
        onMouseLeave={() => setDenseHoveredSessionId((current) => current === session.id ? null : current)}
        onFocusCapture={() => setDenseFocusedSessionId(session.id)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDenseFocusedSessionId((current) => current === session.id ? null : current);
          }
        }}
      >
        <button
          type="button"
          data-testid={`session-item-${session.id}`}
          data-layout-card="dense"
          aria-current={isSelected ? 'page' : undefined}
          aria-describedby={descriptionId}
          onClick={() => onSelectSession(session.id)}
          className={`w-full h-[82px] min-w-0 rounded-lg border p-2 text-left flex flex-col justify-between transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/80 ${
            isSelected
              ? session.isExternal
                ? 'bg-[#1f242c] border-cyan-500/70 ring-1 ring-cyan-500/30'
                : 'bg-[#1f242c] border-emerald-500/60 ring-1 ring-emerald-500/30'
              : session.isExternal
              ? 'bg-[#12161c]/70 border-cyan-950/70 hover:border-cyan-700/70'
              : 'bg-[#12161c]/70 border-[#30363d] hover:bg-[#1f242c]/70 hover:border-zinc-500'
          }`}
        >
          <span className="flex items-center justify-between gap-1 min-w-0">
            <span className="flex items-center gap-1 min-w-0">
              <AgentIcon
                harness={agent?.harness}
                agentName={agent?.name || session.agentId}
                command={agent?.command}
                className="w-3.5 h-3.5 shrink-0"
              />
              {session.managedWorktree && (
                <span
                  data-testid={`session-dense-worktree-badge-${session.id}`}
                  className="relative inline-flex items-center justify-center w-4 h-4 rounded bg-teal-950/90 text-teal-300 border border-teal-500/40 shrink-0"
                  title={`Managed Git worktree${hasUncommittedChanges ? '\nUncommitted Git changes' : ''}`}
                >
                  <GitFork className="w-2.5 h-2.5" />
                  {hasUncommittedChanges && (
                    <span className="absolute -top-1 -right-1 inline-flex items-center rounded-sm bg-[#12161c] text-amber-300">
                      <FileDiff data-testid={`session-dense-worktree-dirty-indicator-${session.id}`} aria-label="Uncommitted Git changes" className="w-2.5 h-2.5" />
                      <span data-testid={`session-dense-worktree-change-count-${session.id}`} className="text-[8px]">{gitChangeCount}</span>
                    </span>
                  )}
                </span>
              )}
              {!session.managedWorktree && hasUncommittedChanges && (
                <span className="inline-flex items-center gap-0.5 text-amber-300" title={`${gitChangeCount} uncommitted Git change${gitChangeCount === 1 ? '' : 's'}`}>
                  <FileDiff data-testid={`session-dense-git-dirty-indicator-${session.id}`} aria-label="Uncommitted Git changes" className="w-3 h-3" />
                  <span data-testid={`session-dense-git-change-count-${session.id}`} className="text-[8px]">{gitChangeCount}</span>
                </span>
              )}
              {session.isExternal && (
                <span className="text-[8px] font-bold text-cyan-300">EXT</span>
              )}
              <SessionSourceBadge session={session} compact />
            </span>
            <StatusBadge
              status={session.status}
              isFocused={isSelected}
              isAcknowledged={isAcknowledged}
              promptSnippet={statusDetails?.detectedPrompt}
              errorReason={statusDetails?.reason}
              iconOnly
              className="shrink-0"
            />
          </span>

          <span className="block w-full min-w-0 max-w-full overflow-hidden">
            <span
              data-testid={`session-dense-title-${session.id}`}
              className="block min-w-0 max-w-full truncate text-[11px] font-semibold leading-tight text-zinc-100"
              title={displayTitle}
            >
              {displayTitle}
            </span>
            <span className="mt-1 flex items-center justify-between gap-1 min-w-0">
              <span className="truncate text-[9px] text-zinc-500" title={displayProject}>
                {displayProject}
              </span>
              {shortcut && (
                <span
                  data-testid={`session-dense-shortcut-${session.id}`}
                  className="shrink-0 font-mono text-[8px] text-zinc-600 group-hover/dense:text-emerald-400 group-focus-within/dense:text-emerald-400"
                  title={`Keyboard shortcut: ${shortcut}`}
                >
                  {shortcut.replace('Ctrl-', '')}
                </span>
              )}
            </span>
          </span>
        </button>
        <span id={descriptionId} className="sr-only">
          {displayTitle}. Project {displayProject}. Status {session.status}. Host {server?.name || session.serverId}.
          Branch {session.branch}. Path {displayPath}. tmux session {session.tmuxSessionName}.
          {shortcut ? ` Keyboard shortcut ${shortcut}.` : ''}
          {session.managedWorktree ? ' Managed Git worktree.' : ''}
        </span>
      </div>
    );

    const hasFilter = Boolean(normalizedSearchTerm || statusFilter !== 'all');
    const matchingChildren = hasFilter
      ? children.filter(
          (c) =>
            sessionMatchesStatus(c) &&
            (!normalizedSearchTerm || sessionMatchesSearch(c, normalizedSearchTerm))
        )
      : children;
    const visibleChildren = hasFilter ? matchingChildren : children;

    if (visibleChildren.length === 0) {
      return denseCard;
    }

    return (
      <div key={session.id} className="flex flex-col gap-1 min-w-0">
        {denseCard}
        <div
          data-testid={`session-dense-subgrid-${session.id}`}
          className="grid grid-cols-1 gap-1 pl-1.5 border-l-2 border-purple-500/40 mt-0.5"
        >
          {visibleChildren.map((child) => (
            <button
              key={child.id}
              type="button"
              data-testid={`session-item-${child.id}`}
              onClick={() => onSelectSession(child.id)}
              className={`px-1.5 py-1 rounded border text-left flex items-center justify-between text-[11px] cursor-pointer transition-colors ${
                child.id === activeSessionId
                  ? 'bg-purple-950/60 border-purple-500 text-white'
                  : 'bg-[#12161c] border-[#30363d] text-zinc-300 hover:border-purple-400'
              }`}
            >
              <span className="truncate flex items-center gap-1 min-w-0">
                <span
                  data-testid={`session-child-alias-${child.id}`}
                  className="font-mono text-[9px] text-purple-400 font-medium px-1 rounded bg-purple-500/10 shrink-0"
                >
                  {child.childAlias || 'child'}
                </span>
                <span className="truncate text-[10px]">{child.name}</span>
              </span>
              <StatusBadge status={child.status} iconOnly className="shrink-0 scale-75" />
            </button>
          ))}
        </div>
      </div>
    );
  };

  const denseDetailSessionId = denseHoveredSessionId ?? denseFocusedSessionId;
  const denseDetailSession = denseDetailSessionId
    ? visibleSessions.find((session) => session.id === denseDetailSessionId)
    : undefined;

  const renderDenseDetails = () => {
    if (!isDenseLayout || !denseDetailSession) return null;
    const project = getProject(denseDetailSession.projectId);
    const server = getServer(denseDetailSession.serverId);
    const agent = getAgent(denseDetailSession.agentId);
    const displayPath = denseDetailSession.worktreePath || project?.rootPath || denseDetailSession.projectId;
    return (
      <div
        data-testid={`session-dense-details-${denseDetailSession.id}`}
        aria-hidden="true"
        className="pointer-events-none absolute bottom-12 left-2 right-2 z-40 rounded-lg border border-emerald-500/40 bg-[#0d1117]/95 p-2 shadow-xl backdrop-blur"
      >
        <div className="flex items-center justify-between gap-2 text-[10px]">
          <span
            className="min-w-0 flex-1 truncate font-semibold text-zinc-200"
            title={denseDetailSession.name || denseDetailSession.task}
          >
            {denseDetailSession.name || denseDetailSession.task}
          </span>
          <span className="text-zinc-500 shrink-0">{denseDetailSession.status.replace('_', ' ')}</span>
        </div>
        <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] font-mono text-zinc-500">
          <span className="truncate" title={server?.name || denseDetailSession.serverId}>Host: {server?.name || denseDetailSession.serverId}</span>
          <span className="truncate" title={agent?.name || denseDetailSession.agentId}>Agent: {agent?.name || denseDetailSession.agentId}</span>
          <span className="truncate" title={denseDetailSession.branch}>Branch: {denseDetailSession.branch}</span>
          <span className="truncate" title={denseDetailSession.tmuxSessionName}>tmux: {denseDetailSession.tmuxSessionName}</span>
          <span className="col-span-2 truncate text-zinc-400" title={displayPath}>Path: {formatSessionPath(displayPath)}</span>
        </div>
      </div>
    );
  };

  // Compact session icon renderer with hover popup card
  const renderCompactSessionCard = (session: Session) => {
    const children = childrenByParentId.get(session.id) || [];
    const hasFilter = Boolean(normalizedSearchTerm || statusFilter !== 'all');
    const matchingChildren = hasFilter
      ? children.filter(
          (c) =>
            sessionMatchesStatus(c) &&
            (!normalizedSearchTerm || sessionMatchesSearch(c, normalizedSearchTerm))
        )
      : children;
    const visibleChildren = hasFilter ? matchingChildren : children;
    const isSelected = session.id === activeSessionId;
    const shortcut = shortcutLabels.get(session.id);
    const server = getServer(session.serverId);
    const hostInfo = hostInfoMap?.[session.serverId];
    const osString = hostInfo?.osName || server?.name || server?.host;
    const project = getProject(session.projectId);
    const agent = getAgent(session.agentId);
    const statusDetails = statusDetailsMap?.[session.id];
    const alertId = getAlertId(session.id, session.status, statusDetails?.detectedPrompt || statusDetails?.reason);
    const isAcknowledged = acknowledgedAlerts.has(alertId);

    const displayTitle = session.name || session.task;
    const displayPath = session.worktreePath || project?.rootPath || session.projectId;
    const hasUncommittedChanges = gitDirtyBySessionId[session.id] === true;
    const gitChangeCount = gitChangeCountBySessionId[session.id] ?? (hasUncommittedChanges ? 1 : 0);
    const formattedPath = formatSessionPath(displayPath);

    return (
      <div
        key={session.id}
        data-testid={`session-compact-item-${session.id}`}
        className="relative group/compact flex justify-center py-1"
      >
        <button
          type="button"
          data-testid={`session-item-${session.id}`}
          onClick={() => onSelectSession(session.id)}
          className={`w-10 h-10 rounded-lg flex flex-col items-center justify-center relative transition-all cursor-pointer ${
            isSelected
              ? session.isExternal
                ? 'bg-[#1f242c] border-2 border-cyan-500 text-cyan-400 shadow-md ring-2 ring-cyan-500/20'
                : 'bg-[#1f242c] border-2 border-emerald-500 text-emerald-400 shadow-md ring-2 ring-emerald-500/20'
              : session.isExternal
              ? 'bg-[#12161c] border border-cyan-900/60 text-cyan-400 hover:bg-[#21262d] hover:text-cyan-200 hover:border-cyan-500'
              : 'bg-[#12161c] border border-[#30363d] text-zinc-400 hover:bg-[#21262d] hover:text-zinc-200 hover:border-zinc-500'
          }`}
          title={`${displayTitle} (${session.status})${shortcut ? ` — ${shortcut}` : ''}`}
        >
          {/* Child Count Badge (for parents with children) */}
          {children.length > 0 && (
            <span
              data-testid={`session-compact-child-count-${session.id}`}
              className="absolute -top-1 -left-1 px-1 min-w-[14px] h-[14px] rounded-full bg-purple-600 text-white font-mono text-[9px] font-bold flex items-center justify-center border border-[#161b22] z-10"
              title={`${children.length} child session${children.length === 1 ? '' : 's'}`}
            >
              {children.length}
            </span>
          )}

          {agent?.harness && agent.harness !== 'none' ? (
            <AgentIcon
              harness={agent?.harness}
              agentName={agent?.name || session.agentId}
              command={agent?.command}
              className="w-4 h-4"
            />
          ) : (
            <Terminal className="w-4 h-4 text-cyan-400/80" />
          )}

          {/* Status Indicator Dot */}
          <span
            data-testid={`session-compact-status-${session.id}`}
            className={`absolute top-1 right-1 w-2 h-2 rounded-full border border-[#161b22] ${
              session.status === 'working' || session.status === 'starting'
                ? 'bg-amber-400 animate-pulse'
                : session.status === 'needs_input'
                ? `bg-purple-400 ${isAcknowledged || isSelected ? '' : 'animate-pulse'}`
                : session.status === 'done' || session.status === 'idle'
                ? 'bg-emerald-400'
                : session.status === 'error'
                ? 'bg-rose-400'
                : 'bg-zinc-500'
            }`}
          />

          {/* Mini Shortcut Indicator (1..0) */}
          {shortcut && (
            <span
              data-testid={`session-compact-shortcut-${session.id}`}
              className="absolute bottom-0.5 left-1 text-[8px] font-mono text-zinc-500 group-hover/compact:text-emerald-400 font-bold"
              title={`Keyboard shortcut: ${shortcut}`}
            >
              {shortcut.replace('Ctrl-', '')}
            </span>
          )}
        </button>

        {/* Floating Hover Popup Card */}
        <div
          data-testid={`session-popup-${session.id}`}
          className="hidden group-hover/compact:flex group-focus-within/compact:flex flex-col gap-1.5 absolute left-[52px] top-0 ml-2 w-72 p-2.5 rounded-lg border border-emerald-500/50 bg-[#161b22] shadow-2xl z-50 pointer-events-auto backdrop-blur-md"
          onClick={() => onSelectSession(session.id)}
        >
          {/* Row 1: [IconHost] [IconProvider]  branch  [IconStatus] [Shortcut] */}
          <div className="flex items-center justify-between gap-1.5 w-full">
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <OsIcon osName={osString} className="w-3.5 h-3.5 shrink-0" />
              <AgentIcon
                harness={agent?.harness}
                agentName={agent?.name || session.agentId}
                command={agent?.command}
                className="w-3.5 h-3.5 shrink-0"
              />
              <div className="flex items-center gap-1 min-w-0 font-mono text-[11px] text-zinc-400 truncate">
                <GitBranch className="w-3 h-3 text-zinc-500 shrink-0" />
                <span className="truncate" title={session.branch}>
                  {session.branch}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <StatusBadge
                status={session.status}
                isFocused={isSelected}
                isAcknowledged={isAcknowledged}
                promptSnippet={statusDetails?.detectedPrompt}
                errorReason={statusDetails?.reason}
                iconOnly={true}
                className="shrink-0"
              />
              {shortcut && (
                <span
                  data-testid={`session-shortcut-badge-${session.id}`}
                  className="text-[9px] font-mono font-medium px-1 py-0.2 rounded bg-[#0d1117] text-zinc-400 border border-[#30363d] text-emerald-300 border-emerald-500/40 shrink-0"
                  title={`Keyboard shortcut: ${shortcut}`}
                >
                  {shortcut}
                </span>
              )}
            </div>
          </div>

          {/* Row 2: Title */}
          <div className="flex w-full min-w-0 items-center justify-between gap-1.5 overflow-hidden">
            <span
              data-testid={`session-compact-title-${session.id}`}
              className="block min-w-0 max-w-full flex-1 truncate text-xs font-semibold leading-snug text-zinc-100"
              title={displayTitle}
            >
              {displayTitle}
            </span>
            {session.managedWorktree && (
              <span
                data-testid={`session-compact-worktree-badge-${session.id}`}
                className="flex items-center gap-1 text-[9px] font-mono font-bold px-1.5 py-0.2 rounded bg-teal-950/80 text-teal-300 border border-teal-500/40 shrink-0"
                title={`Managed Git worktree\nBranch: ${session.branch}\nPath: ${displayPath}${hasUncommittedChanges ? `\n${gitChangeCount} uncommitted Git change${gitChangeCount === 1 ? '' : 's'}` : ''}`}
              >
                <GitFork className="w-2.5 h-2.5" />
                <span>Worktree</span>
                {hasUncommittedChanges && (
                  <span className="inline-flex items-center gap-0.5 text-amber-300" title={`${gitChangeCount} uncommitted Git change${gitChangeCount === 1 ? '' : 's'}`}>
                    <FileDiff
                      data-testid={`session-compact-worktree-dirty-indicator-${session.id}`}
                      aria-label="Uncommitted Git changes"
                      className="w-2.5 h-2.5"
                    />
                    <span data-testid={`session-compact-worktree-change-count-${session.id}`}>{gitChangeCount}</span>
                  </span>
                )}
              </span>
            )}
            {!session.managedWorktree && hasUncommittedChanges && (
              <span className="inline-flex items-center gap-0.5 text-amber-300 shrink-0" title={`${gitChangeCount} uncommitted Git change${gitChangeCount === 1 ? '' : 's'}`}>
                <FileDiff
                  data-testid={`session-compact-git-dirty-indicator-${session.id}`}
                  aria-label="Uncommitted Git changes"
                  className="w-3 h-3"
                />
                <span data-testid={`session-compact-git-change-count-${session.id}`}>{gitChangeCount}</span>
              </span>
            )}
            {session.isExternal && (
              <span
                data-testid={`session-compact-external-badge-${session.id}`}
                className="text-[9px] font-mono font-bold px-1.5 py-0.2 rounded bg-cyan-950/80 text-cyan-300 border border-cyan-500/40 shrink-0"
              >
                EXT
              </span>
            )}
            <SessionSourceBadge session={session} />
          </div>

          {/* Row 3: Path + tmux session */}
          <div className="flex min-w-0 items-center justify-between text-[10px] text-zinc-500 pt-1 border-t border-[#262c36] gap-2">
            <span className="min-w-0 truncate font-mono text-zinc-400 flex-1" title={displayPath}>
              {formattedPath}
            </span>
            <span
              className="truncate font-mono text-zinc-500 text-[10px] max-w-[80px] shrink-0"
              title={session.tmuxSessionName}
            >
              {session.tmuxSessionName}
            </span>
          </div>

          {/* Child Sessions in Hover Popup */}
          {visibleChildren.length > 0 && (
            <div className="mt-1 pt-1.5 border-t border-[#30363d]/60 space-y-1">
              <div className="text-[10px] font-semibold text-purple-300 uppercase tracking-wider flex items-center justify-between">
                <span>Child Sessions</span>
                <span className="font-mono text-[9px] text-purple-400">({visibleChildren.length})</span>
              </div>
              <div className="space-y-1 max-h-36 overflow-y-auto pr-0.5">
                {visibleChildren.map((child) => (
                  <button
                    key={child.id}
                    type="button"
                    data-testid={`session-compact-child-item-${child.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectSession(child.id);
                    }}
                    className={`flex w-full items-center justify-between p-1.5 rounded text-xs cursor-pointer transition-colors text-left ${
                      child.id === activeSessionId
                        ? 'bg-purple-500/20 text-purple-200 border border-purple-500/40'
                        : 'hover:bg-[#21262d] text-zinc-300'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 truncate">
                      <span className="text-[9px] font-mono font-medium px-1 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20 shrink-0">
                        {child.childAlias || 'child'}
                      </span>
                      <span className="truncate text-xs">{child.name}</span>
                    </div>
                    <StatusBadge status={child.status} iconOnly className="shrink-0" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <aside
      data-testid="sidebar"
      data-session-layout={isCollapsed ? 'collapsed' : isDenseLayout ? 'dense' : 'comfortable'}
      data-session-layout-preference={sessionLayoutPreference}
      className={`${
        isCollapsed ? 'w-16' : 'w-80 xl:w-96'
      } bg-[#161b22] border-r border-[#30363d] flex flex-col justify-between select-none shrink-0 h-full relative z-30 transition-all duration-200 overflow-visible`}
    >
      <div className="flex flex-col h-full overflow-visible">
        {/* Brand Header */}
        <div
          className={`h-14 px-3 border-b border-[#30363d] flex items-center ${
            isCollapsed ? 'justify-center' : 'justify-between'
          } shrink-0`}
        >
          {!isCollapsed ? (
            <>
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-bold text-xs tracking-wider">
                  AM
                </div>
                <div className="flex flex-col">
                  <span className="font-semibold text-sm tracking-tight text-white leading-none">Spawnea</span>
                  <span className="text-[10px] text-zinc-500 leading-tight mt-0.5">Desktop IDE</span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  data-testid="sidebar-new-session-button"
                  title="Create new session"
                  onClick={onOpenCreateModal}
                  className="flex items-center gap-1 px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-md text-xs font-medium transition-colors shadow-sm cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>New</span>
                </button>
                {onOpenCreateChildModal && (
                  <button
                    type="button"
                    data-testid="sidebar-new-child-session-button"
                    title={
                      targetParentSession
                        ? `Create child session under "${targetParentSession.name || targetParentSession.task}"`
                        : 'Select a parent session to create a child session'
                    }
                    disabled={!targetParentSession}
                    onClick={() => targetParentSession && onOpenCreateChildModal(targetParentSession.id)}
                    className="flex items-center gap-1 px-2.5 py-1 bg-purple-700 hover:bg-purple-600 text-white rounded-md text-xs font-medium transition-colors shadow-sm cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Child</span>
                  </button>
                )}
                <SidebarActionsMenu
                  onRefresh={onRefresh}
                  onReloadCatalog={onReloadCatalog}
                  onOpenAdoptModal={onOpenAdoptModal}
                  onOpenNewProject={onOpenNewProject}
                  onOpenLocalDiscovery={onOpenLocalDiscovery}
                  onOpenSettings={onOpenSettings}
                  isReloadingCatalog={isReloadingCatalog}
                  isLoading={isLoading}
                />
              </div>
            </>
          ) : (
            <div className="w-7 h-7 rounded-lg bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-bold text-xs tracking-wider">
              AM
            </div>
          )}
        </div>

        {/* Collapsed quick actions */}
        {isCollapsed && (
          <div className="p-2 border-b border-[#30363d] flex flex-col items-center gap-2 shrink-0">
            <div className="flex items-center gap-1">
              <button
                type="button"
                data-testid="sidebar-new-session-button"
                title="Create new session"
                onClick={onOpenCreateModal}
                className="w-8 h-8 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white flex items-center justify-center shadow-sm cursor-pointer transition-colors"
              >
                <Plus className="w-4 h-4" />
              </button>
              {onOpenCreateChildModal && (
                <button
                  type="button"
                  data-testid="sidebar-new-child-session-button-collapsed"
                  title={
                    targetParentSession
                      ? `Create child session under "${targetParentSession.name || targetParentSession.task}"`
                      : 'Select a parent session to create a child session'
                  }
                  disabled={!targetParentSession}
                  onClick={() => targetParentSession && onOpenCreateChildModal(targetParentSession.id)}
                  className="w-8 h-8 rounded-lg bg-purple-700 hover:bg-purple-600 text-white flex items-center justify-center shadow-sm cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <GitFork className="w-4 h-4" />
                </button>
              )}
              <SidebarActionsMenu
                collapsed
                onRefresh={onRefresh}
                onReloadCatalog={onReloadCatalog}
                onOpenAdoptModal={onOpenAdoptModal}
                onOpenNewProject={onOpenNewProject}
                onOpenLocalDiscovery={onOpenLocalDiscovery}
                onOpenSettings={onOpenSettings}
                isReloadingCatalog={isReloadingCatalog}
                isLoading={isLoading}
              />
            </div>

            {/* Compact Grouping Mode Selector */}
            <div className="flex flex-col items-center bg-[#0d1117] p-1 rounded-lg border border-[#30363d] gap-1 mt-1">
              <button
                type="button"
                data-testid="grouping-mode-all"
                onClick={() => setGroupingMode('all')}
                className={`p-1.5 rounded transition-colors cursor-pointer ${
                  groupingMode === 'all' ? 'bg-[#21262d] text-emerald-400' : 'text-zinc-500 hover:text-zinc-300'
                }`}
                title="All sessions flat"
              >
                <ListFilter className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                data-testid="grouping-mode-host"
                onClick={() => setGroupingMode('host')}
                className={`p-1.5 rounded transition-colors cursor-pointer ${
                  groupingMode === 'host' ? 'bg-[#21262d] text-emerald-400' : 'text-zinc-500 hover:text-zinc-300'
                }`}
                title="Group by Host"
              >
                <ServerIcon className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                data-testid="grouping-mode-project"
                onClick={() => setGroupingMode('project')}
                className={`p-1.5 rounded transition-colors cursor-pointer ${
                  groupingMode === 'project' ? 'bg-[#21262d] text-emerald-400' : 'text-zinc-500 hover:text-zinc-300'
                }`}
                title="Group by Project"
              >
                <Folder className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                data-testid="grouping-mode-harness"
                onClick={() => setGroupingMode('harness')}
                className={`p-1.5 rounded transition-colors cursor-pointer ${
                  groupingMode === 'harness' ? 'bg-[#21262d] text-emerald-400' : 'text-zinc-500 hover:text-zinc-300'
                }`}
                title="Group by Harness"
              >
                <Bot className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Grouping Mode Selector & Search Filter (when expanded) */}
        {!isCollapsed && (
          <div className="px-3 pt-3 pb-1 shrink-0 space-y-2">
            {/* Grouping Tabs */}
            <div className="flex items-center bg-[#0d1117] p-0.5 rounded-lg border border-[#30363d] text-[11px]">
              <button
                type="button"
                data-testid="grouping-mode-all"
                onClick={() => setGroupingMode('all')}
                className={`flex-1 py-1 px-1.5 rounded-md font-medium text-center transition-colors cursor-pointer ${
                  groupingMode === 'all'
                    ? 'bg-[#21262d] text-emerald-400 font-semibold shadow-xs'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
                title="View all sessions flat"
              >
                All
              </button>
              <button
                type="button"
                data-testid="grouping-mode-host"
                onClick={() => setGroupingMode('host')}
                className={`flex-1 py-1 px-1.5 rounded-md font-medium text-center transition-colors cursor-pointer flex items-center justify-center gap-1 ${
                  groupingMode === 'host'
                    ? 'bg-[#21262d] text-emerald-400 font-semibold shadow-xs'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
                title="Group sessions by host connection profile"
              >
                <ServerIcon className="w-3 h-3 shrink-0" />
                <span>Host</span>
              </button>
              <button
                type="button"
                data-testid="grouping-mode-project"
                onClick={() => setGroupingMode('project')}
                className={`flex-1 py-1 px-1.5 rounded-md font-medium text-center transition-colors cursor-pointer flex items-center justify-center gap-1 ${
                  groupingMode === 'project'
                    ? 'bg-[#21262d] text-emerald-400 font-semibold shadow-xs'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
                title="Group sessions by project"
              >
                <Folder className="w-3 h-3 shrink-0" />
                <span>Project</span>
              </button>
              <button
                type="button"
                data-testid="grouping-mode-harness"
                onClick={() => setGroupingMode('harness')}
                className={`flex-1 py-1 px-1.5 rounded-md font-medium text-center transition-colors cursor-pointer flex items-center justify-center gap-1 ${
                  groupingMode === 'harness'
                    ? 'bg-[#21262d] text-emerald-400 font-semibold shadow-xs'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
                title="Group sessions by agent harness"
              >
                <Bot className="w-3 h-3 shrink-0" />
                <span>Harness</span>
              </button>
            </div>

            {/* Search Bar */}
            <div className="relative w-full">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-zinc-500" />
              <input
                type="text"
                data-testid="session-search-input"
                placeholder="Filter sessions..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 bg-[#0d1117] border border-[#30363d] rounded-md text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/50"
              />
            </div>

            {/* Attention Status Filter Buttons (Icon + Count + Tooltips) */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 pt-0.5 no-scrollbar text-[11px]">
              {/* All */}
              <button
                type="button"
                data-testid="status-filter-all"
                disabled={sessions.length === 0}
                onClick={() => setStatusFilter('all')}
                title={`All Sessions (${sessions.length})`}
                className={`flex items-center gap-1 px-2 py-1 rounded-md font-medium transition-all shrink-0 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed disabled:pointer-events-none ${
                  statusFilter === 'all'
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-xs'
                    : 'bg-[#0d1117] text-zinc-400 border border-[#30363d] hover:text-zinc-200 hover:border-zinc-500'
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                <span className="text-[10px] font-semibold">{sessions.length}</span>
              </button>

              {/* Needs Input / Attention (Violet) */}
              <button
                type="button"
                data-testid="status-filter-needs_attention"
                disabled={countNeedsAttention === 0}
                onClick={() => setStatusFilter('needs_attention')}
                title={countNeedsAttention > 0 ? `Input Required (${countNeedsAttention})` : 'No sessions requiring input'}
                className={`flex items-center gap-1 px-2 py-1 rounded-md font-medium transition-all shrink-0 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed disabled:pointer-events-none ${
                  statusFilter === 'needs_attention'
                    ? 'bg-purple-500/25 text-purple-200 border border-purple-500/50 shadow-xs'
                    : countNeedsAttention > 0
                    ? 'bg-[#0d1117] text-purple-300 border border-purple-500/30 hover:border-purple-400'
                    : 'bg-[#0d1117] text-zinc-600 border border-[#21262d]'
                }`}
              >
                <MessageSquare className={`w-3.5 h-3.5 ${countNeedsAttention > 0 ? 'text-purple-400' : 'text-zinc-600'}`} />
                <span className="text-[10px] font-semibold">{countNeedsAttention}</span>
                {countUnacknowledgedAttention > 0 && (
                  <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse shrink-0" />
                )}
              </button>

              {/* Working (Yellow) */}
              <button
                type="button"
                data-testid="status-filter-working"
                disabled={countWorking === 0}
                onClick={() => setStatusFilter('working')}
                title={countWorking > 0 ? `Working (${countWorking})` : 'No sessions working'}
                className={`flex items-center gap-1 px-2 py-1 rounded-md font-medium transition-all shrink-0 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed disabled:pointer-events-none ${
                  statusFilter === 'working'
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-xs'
                    : countWorking > 0
                    ? 'bg-[#0d1117] text-amber-400/90 border border-amber-500/20 hover:border-amber-500/40 hover:text-amber-300'
                    : 'bg-[#0d1117] text-zinc-600 border border-[#21262d]'
                }`}
              >
                <Radio
                  className={`w-3.5 h-3.5 ${countWorking > 0 ? 'text-amber-400 animate-pulse' : 'text-zinc-600'}`}
                />
                <span className="text-[10px] font-semibold">{countWorking}</span>
              </button>

              {/* Idle / Done (Green) */}
              <button
                type="button"
                data-testid="status-filter-idle_done"
                disabled={countIdleDone === 0}
                onClick={() => setStatusFilter('idle_done')}
                title={countIdleDone > 0 ? `Idle / Done (${countIdleDone})` : 'No idle sessions'}
                className={`flex items-center gap-1 px-2 py-1 rounded-md font-medium transition-all shrink-0 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed disabled:pointer-events-none ${
                  statusFilter === 'idle_done'
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-xs'
                    : countIdleDone > 0
                    ? 'bg-[#0d1117] text-emerald-400/90 border border-emerald-500/30 hover:border-emerald-400 hover:text-zinc-200'
                    : 'bg-[#0d1117] text-zinc-600 border border-[#21262d]'
                }`}
              >
                <CheckCircle2 className={`w-3.5 h-3.5 ${countIdleDone > 0 ? 'text-emerald-400' : 'text-zinc-600'}`} />
                <span className="text-[10px] font-semibold">{countIdleDone}</span>
              </button>

              {/* Offline / Disconnected (Zinc) */}
              <button
                type="button"
                data-testid="status-filter-disconnected"
                disabled={countDisconnected === 0}
                onClick={() => setStatusFilter('disconnected')}
                title={countDisconnected > 0 ? `Offline / Disconnected (${countDisconnected})` : 'No disconnected sessions'}
                className={`flex items-center gap-1 px-2 py-1 rounded-md font-medium transition-all shrink-0 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed disabled:pointer-events-none ${
                  statusFilter === 'disconnected'
                    ? 'bg-zinc-800 text-zinc-300 border border-zinc-600 shadow-xs'
                    : countDisconnected > 0
                    ? 'bg-[#0d1117] text-zinc-400 border border-[#30363d] hover:text-zinc-300 hover:border-zinc-500'
                    : 'bg-[#0d1117] text-zinc-600 border border-[#21262d]'
                }`}
              >
                <Unplug className={`w-3.5 h-3.5 ${countDisconnected > 0 ? 'text-zinc-400' : 'text-zinc-600'}`} />
                <span className="text-[10px] font-semibold">{countDisconnected}</span>
              </button>
            </div>
          </div>
        )}

        {/* Sessions List Header (when expanded) */}
        {!isCollapsed && (
          <div className="px-3 pt-2 pb-1 flex items-center justify-between gap-2 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase shrink-0">
            <span>
              {statusFilter !== 'all'
                ? `Filtered Sessions (${filteredSessions.length})`
                : groupingMode === 'all'
                ? `Active Sessions (${filteredSessions.length})`
                : `${groupingMode.toUpperCase()} Groups (${groups.length})`}
            </span>
            <div className="flex items-center gap-1 shrink-0">
              <div
                role="group"
                aria-label="Session card layout"
                className="flex items-center rounded-md border border-[#30363d] bg-[#0d1117] p-0.5"
              >
                {([
                  { value: 'auto' as const, label: 'Automatic session layout', icon: Gauge },
                  { value: 'comfortable' as const, label: 'Comfortable session list', icon: List },
                  { value: 'dense' as const, label: 'Dense three-column session grid', icon: LayoutGrid },
                ]).map(({ value, label, icon: Icon }) => (
                  <button
                    key={value}
                    type="button"
                    data-testid={`session-layout-${value}`}
                    aria-label={label}
                    aria-pressed={sessionLayoutPreference === value}
                    title={value === 'auto' ? `${label} (dense at ${DENSE_SESSION_THRESHOLD}+ visible sessions)` : label}
                    onClick={() => setSessionLayoutPreference(value)}
                    className={`p-1 rounded transition-colors cursor-pointer ${
                      sessionLayoutPreference === value
                        ? 'bg-[#21262d] text-emerald-400'
                        : 'text-zinc-500 hover:text-zinc-200'
                    }`}
                  >
                    <Icon className="w-3 h-3" />
                  </button>
                ))}
              </div>
              {onClearDoneSessions && sessions.some((s) => s.status === 'done') && (
                <button
                  type="button"
                  data-testid="sidebar-clear-done-button"
                  onClick={onClearDoneSessions}
                  className="text-[10px] lowercase text-zinc-500 hover:text-rose-400 transition-colors cursor-pointer"
                  title="Remove all finished/concluded sessions"
                >
                  clear
                </button>
              )}
            </div>
          </div>
        )}

        {/* Scrollable Sessions List */}
        <div
          data-testid="session-list"
          data-layout={isCollapsed ? 'collapsed' : isDenseLayout ? 'dense' : 'comfortable'}
          className={`flex-1 overflow-y-auto overflow-x-hidden ${isCollapsed ? 'px-1 py-2 space-y-1' : 'px-2 py-1 space-y-2'}`}
        >
          {filteredSessions.length === 0 ? (
            <div className={`text-center text-zinc-500 text-xs ${isCollapsed ? 'py-4' : 'px-4 py-8'}`}>
              {!isCollapsed ? (
                searchTerm || statusFilter !== 'all' ? (
                  <div className="space-y-1">
                    <p>No sessions match current filters</p>
                    <button
                      type="button"
                      onClick={() => {
                        setSearchTerm('');
                        setStatusFilter('all');
                      }}
                      className="text-xs text-emerald-400 hover:underline cursor-pointer"
                    >
                      Reset filters
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2">
                    <Terminal className="w-8 h-8 text-zinc-600" />
                    <p className="text-zinc-400 font-medium">No sessions running</p>
                    <button
                      type="button"
                      onClick={onOpenCreateModal}
                      className="text-xs text-emerald-400 hover:underline cursor-pointer"
                    >
                      Start a session
                    </button>
                  </div>
                )
              ) : (
                <Terminal className="w-5 h-5 mx-auto text-zinc-600" />
              )}
            </div>
          ) : isCollapsed ? (
            /* Collapsed Session Icons */
            groupingMode === 'all' ? (
              <div className="space-y-1">
                {sortedFilteredSessions.map((session) => renderCompactSessionCard(session))}
              </div>
            ) : (
              <div className="space-y-2">
                {groups.map((group) => {
                  const Icon = group.icon;
                  return (
                    <div key={group.id} className="space-y-1 border-b border-[#21262d]/50 pb-2">
                      <div
                        className="w-8 h-4 mx-auto flex items-center justify-center text-zinc-500"
                        title={`${group.title} (${group.sessions.length})`}
                      >
                        <Icon className="w-3 h-3" />
                      </div>
                      {group.sessions.map((session) => renderCompactSessionCard(session))}
                    </div>
                  );
                })}
              </div>
            )
          ) : groupingMode === 'all' ? (
            /* Expanded Flat Sessions */
            <>
              <div
                data-testid="session-flat-layout"
                className={isDenseLayout ? 'grid grid-cols-3 gap-1.5' : 'space-y-1.5'}
              >
                {sortedFilteredSessions.map((session) => (
                  isDenseLayout ? renderDenseSessionCard(session) : renderSessionCard(session)
                ))}
              </div>
            </>
          ) : (
            /* Expanded Grouped Sessions */
            <div className="space-y-3">
              {groups.map((group) => {
                const Icon = group.icon;
                return (
                  <div
                    key={group.id}
                    data-testid={`session-group-${group.id}`}
                    className="rounded-lg border border-[#21262d] bg-[#12161c]/40 p-2 space-y-1.5"
                  >
                    <div className="flex items-center justify-between px-1 pb-1 border-b border-[#21262d]/60 text-xs">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Icon className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                        <span className="font-semibold text-zinc-200 truncate" title={group.title}>
                          {group.title}
                        </span>
                        {group.subtitle && (
                          <span
                            className="text-[10px] text-zinc-500 font-mono truncate max-w-[90px]"
                            title={group.subtitle}
                          >
                            ({group.subtitle})
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {groupingMode === 'host' && (
                          <HostHealthDot
                            health={hostHealthMap[group.id.replace('host-', '')]}
                            showLatency={true}
                          />
                        )}
                        <span className="text-[10px] text-zinc-400 font-mono bg-[#161b22] px-1.5 py-0.5 rounded border border-[#30363d]">
                          {group.sessions.length}
                        </span>
                      </div>
                    </div>

                    <div className={isDenseLayout ? 'grid grid-cols-3 gap-1.5 pt-1' : 'space-y-1.5 pt-1'}>
                      {group.sessions.map((session) => (
                        isDenseLayout ? renderDenseSessionCard(session) : renderSessionCard(session)
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {!isCollapsed && renderDenseDetails()}

        {/* System Inventory Footer */}
        {!isCollapsed ? (
          <div className="p-3 border-t border-[#30363d] bg-[#12161c] text-xs text-zinc-400 shrink-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {/* Servers Counter & Hover Popup */}
                <div className="relative group cursor-pointer">
                  <div className="flex items-center gap-1.5 py-0.5">
                    <ServerIcon className="w-3.5 h-3.5 text-zinc-500 group-hover:text-zinc-300 transition-colors" />
                    <span className="text-zinc-300 font-medium">{servers.length}</span>
                  </div>
                  <div className="hidden group-hover:block absolute bottom-full left-0 mb-2 p-2.5 bg-[#161b22] border border-[#30363d] rounded-md shadow-2xl z-50 min-w-56 max-w-xs pointer-events-auto">
                    <div className="flex items-center justify-between text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-1.5 pb-1 border-b border-[#30363d]/60">
                      <span>Servers ({servers.length})</span>
                      {onCheckHostHealth && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onCheckHostHealth();
                          }}
                          className="text-zinc-400 hover:text-zinc-200 transition-colors p-0.5 rounded hover:bg-[#21262d]"
                          title="Check host connectivity now"
                        >
                          <RefreshCw className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      {servers.length === 0 ? (
                        <div className="text-zinc-500 text-xs italic">No servers registered</div>
                      ) : (
                        servers.map((s) => {
                          const health = hostHealthMap[s.id];
                          return (
                            <div key={s.id} className="text-xs text-zinc-200 flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <HostHealthDot health={health} />
                                <span className="font-medium truncate">{s.name}</span>
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                {health && health.latencyMs !== undefined && health.status !== 'unreachable' && (
                                  <span className="text-[10px] text-emerald-400 font-mono">{health.latencyMs}ms</span>
                                )}
                                <span className="text-[10px] text-zinc-400 font-mono">{s.host}</span>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>

                {/* Projects Counter & Hover Popup */}
                <div className="relative group cursor-pointer">
                  <div className="flex items-center gap-1.5 py-0.5">
                    <Layers className="w-3.5 h-3.5 text-zinc-500 group-hover:text-zinc-300 transition-colors" />
                    <span className="text-zinc-300 font-medium">{projects.length}</span>
                  </div>
                  <div className="hidden group-hover:block absolute bottom-full left-0 mb-2 p-2.5 bg-[#161b22] border border-[#30363d] rounded-md shadow-2xl z-50 min-w-56 max-w-sm pointer-events-none">
                    <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-1.5 pb-1 border-b border-[#30363d]/60">
                      Projects ({projects.length})
                    </div>
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {projects.length === 0 ? (
                        <div className="text-zinc-500 text-xs italic">No projects registered</div>
                      ) : (
                        projects.map((p) => {
                          const srv = servers.find((s) => s.id === p.serverId);
                          return (
                            <div key={p.id} className="text-xs">
                              <div className="text-zinc-200 font-medium flex items-center justify-between gap-2">
                                <span>{p.name}</span>
                                {srv && <span className="text-[10px] text-zinc-400 font-mono">({srv.name})</span>}
                              </div>
                              <div className="text-[10px] text-zinc-500 font-mono truncate max-w-[260px]">
                                {p.rootPath}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>

                {/* Agents Counter & Hover Popup */}
                <div className="relative group cursor-pointer">
                  <div className="flex items-center gap-1.5 py-0.5">
                    <Bot className="w-3.5 h-3.5 text-zinc-500 group-hover:text-zinc-300 transition-colors" />
                    <span className="text-zinc-300 font-medium">{agents.length}</span>
                  </div>
                  <div className="hidden group-hover:block absolute bottom-full left-0 mb-2 p-2.5 bg-[#161b22] border border-[#30363d] rounded-md shadow-2xl z-50 min-w-52 max-w-xs pointer-events-none">
                    <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-1.5 pb-1 border-b border-[#30363d]/60">
                      Harnesses ({agents.length})
                    </div>
                    <div className="space-y-1.5 max-h-48 overflow-y-auto">
                      {agents.length === 0 ? (
                        <div className="text-zinc-500 text-xs italic">No harnesses registered</div>
                      ) : (
                        agents.map((a) => (
                          <div key={a.id} className="text-xs flex items-center justify-between gap-2">
                            <span className="text-zinc-200 font-medium truncate">{a.name}</span>
                            <span className="text-[10px] text-emerald-400 font-mono bg-emerald-950/40 px-1 py-0.5 rounded shrink-0">
                              {a.harness}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Catalog Status / Config File Info & Collapse Button */}
              <div className="flex items-center gap-2 font-mono text-[10px]">
                {catalogErrorCount > 0 ? (
                  <span
                    data-testid="sidebar-catalog-error-badge"
                    className="flex items-center gap-1 text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20"
                    title={`${catalogErrorCount} catalog validation error(s)`}
                  >
                    <AlertTriangle className="w-3 h-3 shrink-0" />
                    <span>{catalogErrorCount} err</span>
                  </span>
                ) : (
                  <div className="relative group cursor-pointer">
                    <span className="text-zinc-500 hover:text-zinc-400 uppercase tracking-wider transition-colors">
                      YAML v1
                    </span>
                    <div className="hidden group-hover:block absolute bottom-full right-0 mb-2 p-2.5 bg-[#161b22] border border-[#30363d] rounded-md shadow-2xl z-50 min-w-64 max-w-xs pointer-events-none">
                      <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-1 pb-0.5 border-b border-[#30363d]/60">
                        Operational Catalog
                      </div>
                      <div className="text-[10px] text-zinc-300 font-mono break-all">
                        {catalogPath ?? 'Loaded from defaults'}
                      </div>
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  data-testid="sidebar-toggle-collapse"
                  title="Collapse sidebar (Ctrl+Shift+B)"
                  onClick={toggleCollapse}
                  className="p-1 hover:bg-[#21262d] rounded text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer ml-1"
                >
                  <PanelLeftClose className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="p-2 border-t border-[#30363d] bg-[#12161c] flex flex-col items-center gap-2.5 text-zinc-500 shrink-0">
            <div className="relative group cursor-pointer" title={`${servers.length} Servers`}>
              <ServerIcon className="w-3.5 h-3.5 hover:text-zinc-300 transition-colors" />
            </div>
            <div className="relative group cursor-pointer" title={`${projects.length} Projects`}>
              <Layers className="w-3.5 h-3.5 hover:text-zinc-300 transition-colors" />
            </div>
            <div className="relative group cursor-pointer" title={`${agents.length} Harnesses`}>
              <Bot className="w-3.5 h-3.5 hover:text-zinc-300 transition-colors" />
            </div>

            <div className="w-full h-px bg-[#30363d]/60 my-0.5" />

            <button
              type="button"
              data-testid="sidebar-toggle-collapse"
              title="Expand sidebar (Ctrl+Shift+B)"
              onClick={toggleCollapse}
              className="p-1.5 hover:bg-[#21262d] rounded text-zinc-400 hover:text-emerald-400 transition-colors cursor-pointer"
            >
              <PanelLeftOpen className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
