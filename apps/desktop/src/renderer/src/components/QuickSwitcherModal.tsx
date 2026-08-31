import React, { useState, useEffect, useRef, useMemo } from 'react';
import type { Session, Server, Project, Agent, SessionStatusResult } from '@spawnea/domain';
import type { WorkspaceTabType } from './WorkspaceTabs';
import type { StatusFilterMode, GroupingMode } from './Sidebar';
import { StatusBadge } from './StatusBadge';

import { AgentIcon } from './AgentIcon';
import {
  Search,
  Terminal,
  FolderTree,
  GitBranch,
  FileCode2,
  Info,
  Plus,
  RefreshCw,
  FileCode,
  PanelLeft,
  Trash2,
  Layers,
  Bot,
  Server as ServerIcon,
  Filter,

  CornerDownLeft,
  X,
  Radio,
} from 'lucide-react';

export interface QuickSwitcherItem {
  id: string;
  category: 'Sessions' | 'Tabs' | 'Actions' | 'Filters' | 'Grouping';
  title: string;
  subtitle?: string;
  keywords?: string[];
  shortcut?: string;
  icon?: React.ComponentType<{ className?: string }>;
  session?: Session;
  onSelect: () => void;
}

interface QuickSwitcherModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessions: Session[];
  servers: Server[];
  projects: Project[];
  agents: Agent[];
  activeSessionId: string | null;
  activeTab: WorkspaceTabType;
  onSelectSession: (id: string) => void;
  onSelectTab: (tab: WorkspaceTabType) => void;
  onOpenCreateModal: () => void;
  onOpenAdoptModal?: () => void;
  onReloadCatalog?: () => void;
  onRefresh: () => void;
  onToggleSidebar: () => void;
  onClearDoneSessions?: () => void;
  onSetStatusFilter?: (filter: StatusFilterMode) => void;
  onSetGroupingMode?: (mode: GroupingMode) => void;
  statusDetailsMap?: Record<string, SessionStatusResult>;
}

export function QuickSwitcherModal({
  isOpen,
  onClose,
  sessions,
  servers,
  projects,
  agents,
  activeSessionId,
  activeTab: _activeTab,
  onSelectSession,
  onSelectTab,
  onOpenCreateModal,
  onOpenAdoptModal,
  onReloadCatalog,
  onRefresh,
  onToggleSidebar,
  onClearDoneSessions,
  onSetStatusFilter,
  onSetGroupingMode,
  statusDetailsMap: _statusDetailsMap = {},
}: QuickSwitcherModalProps): React.JSX.Element | null {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    }
  }, [isOpen]);

  const getServer = (serverId: string) => servers.find((s) => s.id === serverId);
  const getProject = (projectId: string) => projects.find((p) => p.id === projectId);
  const getAgent = (agentId: string) => agents.find((a) => a.id === agentId);

  // Build all searchable items
  const allItems = useMemo<QuickSwitcherItem[]>(() => {
    const items: QuickSwitcherItem[] = [];

    // 1. Sessions
    for (const session of sessions) {
      const server = getServer(session.serverId);
      const project = getProject(session.projectId);
      const agent = getAgent(session.agentId);

      items.push({
        id: `session-${session.id}`,
        category: 'Sessions',
        title: session.name,
        subtitle: `${project?.name || session.projectId} • ${session.branch} • ${session.tmuxSessionName}${
          server ? ` (${server.name})` : ''
        }`,
        keywords: [
          session.task,
          session.branch,
          session.tmuxSessionName,
          session.status,
          project?.name || '',
          server?.name || '',
          agent?.name || '',
          agent?.harness || '',
        ],
        icon: Terminal,
        session,
        onSelect: () => {
          onSelectSession(session.id);
          onClose();
        },
      });
    }

    // 2. Workspace Tabs
    const tabsConfig: { id: WorkspaceTabType; title: string; subtitle: string; shortcut: string; icon: any }[] = [
      {
        id: 'terminal',
        title: 'Switch to Terminal',
        subtitle: 'Interactive SSH & tmux terminal stream',
        shortcut: 'Alt+1',
        icon: Terminal,
      },
      {
        id: 'files',
        title: 'Switch to Files',
        subtitle: 'Session workspace file tree and previews',
        shortcut: 'Alt+2',
        icon: FolderTree,
      },
      {
        id: 'diff',
        title: 'Switch to Git Diff',
        subtitle: 'Inspect git status and colorized file diffs',
        shortcut: 'Alt+3',
        icon: GitBranch,
      },
      {
        id: 'artifacts',
        title: 'Switch to Artifacts',
        subtitle: 'Input/output artifact gallery and viewer',
        shortcut: 'Alt+4',
        icon: FileCode2,
      },
      {
        id: 'details',
        title: 'Switch to Session Info',
        subtitle: 'Session details and host environment telemetry',
        shortcut: 'Alt+5',
        icon: Info,
      },
    ];

    for (const t of tabsConfig) {
      items.push({
        id: `tab-${t.id}`,
        category: 'Tabs',
        title: t.title,
        subtitle: t.subtitle,
        keywords: ['tab', 'view', t.id, t.title.toLowerCase()],
        shortcut: t.shortcut,
        icon: t.icon,
        onSelect: () => {
          onSelectTab(t.id);
          onClose();
        },
      });
    }

    // 3. System Actions & Commands
    items.push({
      id: 'action-new-session',
      category: 'Actions',
      title: 'New Session',
      subtitle: 'Create and launch a new agent persistent session',
      keywords: ['create', 'new', 'start', 'launch', 'agent'],
      shortcut: 'New',
      icon: Plus,
      onSelect: () => {
        onOpenCreateModal();
        onClose();
      },
    });

    if (onOpenAdoptModal) {
      items.push({
        id: 'action-adopt-session',
        category: 'Actions',
        title: 'Adopt Tmux Session',
        subtitle: 'Discover and adopt active external tmux sessions',
        keywords: ['adopt', 'discover', 'external', 'tmux', 'attach'],
        icon: Radio,
        onSelect: () => {
          onOpenAdoptModal();
          onClose();
        },
      });
    }

    if (onReloadCatalog) {
      items.push({
        id: 'action-reload-catalog',
        category: 'Actions',
        title: 'Reload Config',
        subtitle: 'Re-read and validate operational catalog YAML',
        keywords: ['reload', 'config', 'yaml', 'catalog', 'hosts', 'projects'],
        icon: FileCode,
        onSelect: () => {
          onReloadCatalog();
          onClose();
        },
      });
    }

    items.push({
      id: 'action-refresh',
      category: 'Actions',
      title: 'Refresh & Reconcile Sessions',
      subtitle: 'Reconcile local sessions with remote reality',
      keywords: ['refresh', 'reconcile', 'sync', 'status'],
      icon: RefreshCw,
      onSelect: () => {
        onRefresh();
        onClose();
      },
    });

    items.push({
      id: 'action-toggle-sidebar',
      category: 'Actions',
      title: 'Toggle Sidebar',
      subtitle: 'Expand or collapse the navigation sidebar',
      keywords: ['sidebar', 'toggle', 'collapse', 'expand', 'hide', 'show'],
      shortcut: 'Ctrl+Shift+B',
      icon: PanelLeft,
      onSelect: () => {
        onToggleSidebar();
        onClose();
      },
    });

    if (onClearDoneSessions) {
      items.push({
        id: 'action-clear-done',
        category: 'Actions',
        title: 'Clear Done Sessions',
        subtitle: 'Remove all completed/done sessions from list',
        keywords: ['clear', 'done', 'cleanup', 'delete finished'],
        icon: Trash2,
        onSelect: () => {
          onClearDoneSessions();
          onClose();
        },
      });
    }

    // 4. Status Filters
    if (onSetStatusFilter) {
      items.push(
        {
          id: 'filter-needs-attention',
          category: 'Filters',
          title: 'Filter: Needs Attention',
          subtitle: 'Show only sessions waiting for input or in error',
          keywords: ['filter', 'needs attention', 'attention', 'input', 'error', 'prompt'],
          icon: Filter,
          onSelect: () => {
            onSetStatusFilter('needs_attention');
            onClose();
          },
        },
        {
          id: 'filter-working',
          category: 'Filters',
          title: 'Filter: Working',
          subtitle: 'Show only actively running sessions',
          keywords: ['filter', 'working', 'active', 'busy', 'running'],
          icon: Filter,
          onSelect: () => {
            onSetStatusFilter('working');
            onClose();
          },
        },
        {
          id: 'filter-idle-done',
          category: 'Filters',
          title: 'Filter: Idle & Done',
          subtitle: 'Show finished or idle sessions',
          keywords: ['filter', 'idle', 'done', 'completed', 'finished'],
          icon: Filter,
          onSelect: () => {
            onSetStatusFilter('idle_done');
            onClose();
          },
        },
        {
          id: 'filter-disconnected',
          category: 'Filters',
          title: 'Filter: Offline',
          subtitle: 'Show disconnected sessions',
          keywords: ['filter', 'disconnected', 'offline'],
          icon: Filter,
          onSelect: () => {
            onSetStatusFilter('disconnected');
            onClose();
          },
        },
        {
          id: 'filter-all',
          category: 'Filters',
          title: 'Filter: Show All',
          subtitle: 'Clear status filters and show all sessions',
          keywords: ['filter', 'all', 'show all', 'reset filter'],
          icon: Filter,
          onSelect: () => {
            onSetStatusFilter('all');
            onClose();
          },
        }
      );
    }

    // 5. Grouping Modes
    if (onSetGroupingMode) {
      items.push(
        {
          id: 'grouping-all',
          category: 'Grouping',
          title: 'Group by: All (Flat)',
          subtitle: 'Display flat session list in sidebar',
          keywords: ['group', 'flat', 'all'],
          icon: Layers,
          onSelect: () => {
            onSetGroupingMode('all');
            onClose();
          },
        },
        {
          id: 'grouping-host',
          category: 'Grouping',
          title: 'Group by: Host',
          subtitle: 'Group sessions by host connection profile',
          keywords: ['group', 'host', 'server'],
          icon: ServerIcon,
          onSelect: () => {
            onSetGroupingMode('host');
            onClose();
          },
        },
        {
          id: 'grouping-project',
          category: 'Grouping',
          title: 'Group by: Project',
          subtitle: 'Group sessions by workspace project',
          keywords: ['group', 'project', 'repo'],
          icon: FolderTree,
          onSelect: () => {
            onSetGroupingMode('project');
            onClose();
          },
        },
        {
          id: 'grouping-harness',
          category: 'Grouping',
          title: 'Group by: Harness',
          subtitle: 'Group sessions by AI agent harness',
          keywords: ['group', 'harness', 'agent', 'claude', 'codex'],
          icon: Bot,
          onSelect: () => {
            onSetGroupingMode('harness');
            onClose();
          },
        }
      );
    }

    return items;
  }, [
    sessions,
    servers,
    projects,
    agents,
    activeSessionId,
    onSelectSession,
    onSelectTab,
    onOpenCreateModal,
    onReloadCatalog,
    onRefresh,
    onToggleSidebar,
    onClearDoneSessions,
    onSetStatusFilter,
    onSetGroupingMode,
    onClose,
  ]);

  // Filter items by search query
  const filteredItems = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return allItems;

    return allItems.filter((item) => {
      const matchTitle = item.title.toLowerCase().includes(term);
      const matchSubtitle = item.subtitle ? item.subtitle.toLowerCase().includes(term) : false;
      const matchCategory = item.category.toLowerCase().includes(term);
      const matchKeywords = item.keywords?.some((k) => k.toLowerCase().includes(term)) || false;
      return matchTitle || matchSubtitle || matchCategory || matchKeywords;
    });
  }, [allItems, query]);

  // Keep selected index within bounds
  useEffect(() => {
    if (selectedIndex >= filteredItems.length) {
      setSelectedIndex(Math.max(0, filteredItems.length - 1));
    }
  }, [filteredItems.length, selectedIndex]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selectedEl = listRef.current.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`);
    if (selectedEl && typeof selectedEl.scrollIntoView === 'function') {
      selectedEl.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1 >= filteredItems.length ? 0 : prev + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 < 0 ? filteredItems.length - 1 : prev - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredItems[selectedIndex]) {
        filteredItems[selectedIndex].onSelect();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div
      data-testid="quick-switcher-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Quick Switcher"
      className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-100"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="w-full max-w-2xl bg-[#161b22] border border-[#30363d] rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[75vh] ring-1 ring-emerald-500/20">
        {/* Search Input Header */}
        <div className="p-3 border-b border-[#30363d] bg-[#0d1117] flex items-center gap-3 shrink-0">
          <Search className="w-5 h-5 text-emerald-400 shrink-0 ml-1" />
          <input
            ref={inputRef}
            data-testid="quick-switcher-input"
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Type to search sessions, tabs, actions, or filters... (↑↓ to navigate, Enter to select)"
            className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-500 focus:outline-hidden font-sans"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setSelectedIndex(0);
                inputRef.current?.focus();
              }}
              className="p-1 text-zinc-400 hover:text-zinc-200 rounded cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          )}
          <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] font-mono text-zinc-400 bg-[#21262d] border border-[#30363d] rounded">
            ESC
          </kbd>
        </div>

        {/* Results List */}
        <div
          ref={listRef}
          data-testid="quick-switcher-list"
          className="flex-1 overflow-y-auto p-2 divide-y divide-[#21262d]/40"
        >
          {filteredItems.length === 0 ? (
            <div className="py-12 px-4 text-center text-zinc-500 text-xs">
              No matching sessions, commands, or tabs found for &ldquo;{query}&rdquo;
            </div>
          ) : (
            filteredItems.map((item, idx) => {
              const isSelected = idx === selectedIndex;
              const Icon = item.icon || Terminal;
              const isSession = item.category === 'Sessions' && item.session;

              return (
                <div
                  key={item.id}
                  data-index={idx}
                  data-testid={`quick-switcher-item-${item.id}`}
                  onClick={item.onSelect}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg flex items-center justify-between gap-3 transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-[#21262d] text-white ring-1 ring-emerald-500/40 shadow-xs'
                      : 'text-zinc-300 hover:bg-[#1f242c]'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div
                      className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${
                        isSelected
                          ? 'bg-emerald-500/20 text-emerald-400'
                          : 'bg-[#12161c] text-zinc-400 border border-[#30363d]'
                      }`}
                    >
                      {isSession ? (
                        agents.find((a) => a.id === item.session!.agentId)?.harness &&
                        agents.find((a) => a.id === item.session!.agentId)?.harness !== 'none' ? (
                          <AgentIcon
                            harness={agents.find((a) => a.id === item.session!.agentId)?.harness}
                            agentName={agents.find((a) => a.id === item.session!.agentId)?.name || item.session!.agentId}
                            command={agents.find((a) => a.id === item.session!.agentId)?.command}
                            className="w-4 h-4"
                          />
                        ) : (
                          <Terminal className="w-4 h-4 text-cyan-400/80" />
                        )
                      ) : (
                        <Icon className="w-4 h-4" />
                      )}
                    </div>

                    <div className="flex flex-col min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-xs text-zinc-100 truncate">
                          {item.title}
                        </span>
                        {isSession && item.session!.isExternal && (
                          <span
                            data-testid={`quick-switcher-external-badge-${item.session!.id}`}
                            className="text-[9px] font-mono font-bold px-1.5 py-0.2 rounded bg-cyan-950/80 text-cyan-300 border border-cyan-500/40"
                          >
                            EXT
                          </span>
                        )}
                        {item.category && (
                          <span
                            className={`text-[9px] uppercase tracking-wider font-semibold px-1.5 py-0.2 rounded border ${
                              item.category === 'Sessions'
                                ? 'bg-emerald-950/60 text-emerald-300 border-emerald-800/40'
                                : item.category === 'Tabs'
                                ? 'bg-blue-950/60 text-blue-300 border-blue-800/40'
                                : item.category === 'Actions'
                                ? 'bg-purple-950/60 text-purple-300 border-purple-800/40'
                                : 'bg-zinc-800 text-zinc-400 border-zinc-700'
                            }`}
                          >
                            {item.category}
                          </span>
                        )}
                        {isSession && (
                          <StatusBadge
                            status={item.session!.status}
                            iconOnly={true}
                            className="shrink-0 scale-90"
                          />
                        )}
                      </div>
                      {item.subtitle && (
                        <span className="text-[11px] text-zinc-400 truncate mt-0.5">
                          {item.subtitle}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {item.shortcut && (
                      <kbd className="px-1.5 py-0.5 text-[10px] font-mono text-zinc-400 bg-[#0d1117] border border-[#30363d] rounded">
                        {item.shortcut}
                      </kbd>
                    )}
                    {isSelected && (
                      <CornerDownLeft className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Keyboard Hints Footer */}
        <div className="px-4 py-2 border-t border-[#30363d] bg-[#0d1117] flex items-center justify-between text-[11px] text-zinc-500 font-sans select-none shrink-0">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.2 text-[9px] font-mono bg-[#21262d] border border-[#30363d] rounded text-zinc-400">
                ↑
              </kbd>
              <kbd className="px-1 py-0.2 text-[9px] font-mono bg-[#21262d] border border-[#30363d] rounded text-zinc-400">
                ↓
              </kbd>
              <span className="ml-0.5">Navigate</span>
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.2 text-[9px] font-mono bg-[#21262d] border border-[#30363d] rounded text-zinc-400">
                ↵
              </kbd>
              <span className="ml-0.5">Select</span>
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.2 text-[9px] font-mono bg-[#21262d] border border-[#30363d] rounded text-zinc-400">
                ESC
              </kbd>
              <span className="ml-0.5">Dismiss</span>
            </span>
          </div>
          <span className="text-[10px] text-zinc-500 font-mono">
            {filteredItems.length} result{filteredItems.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>
    </div>
  );
}
