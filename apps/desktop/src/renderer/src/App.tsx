import React, { useState, useEffect, useCallback, useRef } from 'react';
import type {
  Session,
  Server,
  Project,
  Agent,
  CreateSessionInput,
  CreateChildSessionInput,
  ParentCloseAction,
  AdoptSessionInput,
  OperationalCatalog,
  CatalogValidationError,
  HostSystemInfo,
  HostHealthResult,
  GitStatusResult,
  FinishSessionAction,
  FinishSessionOptions,
  AddProjectToCatalogInput,
  ControlFinalizationRequest,
} from '@spawnea/domain';
import { Sidebar } from './components/Sidebar';
import { ContextBar } from './components/ContextBar';
import { WorkspaceTabs, type WorkspaceTabType } from './components/WorkspaceTabs';
import { CreateSessionModal } from './components/CreateSessionModal';
import { CreateChildSessionModal } from './components/CreateChildSessionModal';
import { CloseParentModal } from './components/CloseParentModal';
import { AdoptSessionModal } from './components/AdoptSessionModal';
import { StopSessionModal } from './components/StopSessionModal';
import { UnadoptSessionModal } from './components/UnadoptSessionModal';
import { FinishSessionModal } from './components/FinishSessionModal';
import { StateFeedbackModal } from './components/StateFeedbackModal';
import { CatalogErrorBanner } from './components/CatalogErrorBanner';
import { QuickSwitcherModal } from './components/QuickSwitcherModal';
import { NewProjectModal } from './components/NewProjectModal';
import { LocalDiscoveryModal } from './components/LocalDiscoveryModal';
import { ControlFinalizationModal } from './components/ControlFinalizationModal';
import { spawneaSessionTabKey } from './product-storage';
import { Terminal, Plus } from 'lucide-react';

/**
 * Orders sessions hierarchically for keyboard cycling (Ctrl-Tab / Ctrl-Shift-Tab):
 * Root (father) session first, immediately followed by its children in order (child-1, child-2, ..., child-N).
 */
export function getHierarchicalSessionOrder(sessions: Session[]): Session[] {
  const rootSessions = sessions
    .filter((s) => !s.parentSessionId)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));

  const childrenByParent = new Map<string, Session[]>();
  for (const s of sessions) {
    if (s.parentSessionId) {
      const list = childrenByParent.get(s.parentSessionId) || [];
      list.push(s);
      childrenByParent.set(s.parentSessionId, list);
    }
  }

  // Sort children under each parent by childAlias (child-1, child-2, ...), falling back to name
  for (const list of childrenByParent.values()) {
    list.sort((a, b) =>
      (a.childAlias || a.name).localeCompare(b.childAlias || b.name, undefined, {
        numeric: true,
        sensitivity: 'base',
      })
    );
  }

  const result: Session[] = [];
  const visitedIds = new Set<string>();

  for (const parent of rootSessions) {
    result.push(parent);
    visitedIds.add(parent.id);
    const children = childrenByParent.get(parent.id) || [];
    for (const child of children) {
      result.push(child);
      visitedIds.add(child.id);
    }
  }

  // Fallback: append any orphaned child sessions
  for (const s of sessions) {
    if (!visitedIds.has(s.id)) {
      result.push(s);
    }
  }

  return result;
}

export function App(): React.JSX.Element {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [hostInfoMap, setHostInfoMap] = useState<Record<string, HostSystemInfo>>({});
  const [hostHealthMap, setHostHealthMap] = useState<Record<string, HostHealthResult>>({});
  const [gitDirtyBySessionId, setGitDirtyBySessionId] = useState<Record<string, boolean>>({});
  const [gitChangeCountBySessionId, setGitChangeCountBySessionId] = useState<Record<string, number>>({});
  const [gitSyncBySessionId, setGitSyncBySessionId] = useState<Record<string, { ahead: number; behind: number }>>({});
  const [gitRefreshNonce, setGitRefreshNonce] = useState(0);
  const [statusDetailsMap, setStatusDetailsMap] = useState<Record<string, import('@spawnea/domain').SessionStatusResult>>({});
  const [catalog, setCatalog] = useState<OperationalCatalog | null>(null);
  const [catalogPath, setCatalogPath] = useState<string | undefined>(undefined);
  const [catalogErrors, setCatalogErrors] = useState<CatalogValidationError[] | null>(null);
  const [isReloadingCatalog, setIsReloadingCatalog] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTabType>('terminal');
  const [isQuickSwitcherOpen, setIsQuickSwitcherOpen] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isNewProjectModalOpen, setIsNewProjectModalOpen] = useState(false);
  const [isLocalDiscoveryOpen, setIsLocalDiscoveryOpen] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [isAdoptModalOpen, setIsAdoptModalOpen] = useState(false);
  const [sessionToStop, setSessionToStop] = useState<Session | null>(null);
  const [isStoppingSession, setIsStoppingSession] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [sessionToUnadopt, setSessionToUnadopt] = useState<Session | null>(null);
  const [isUnadoptingSession, setIsUnadoptingSession] = useState(false);
  const [unadoptError, setUnadoptError] = useState<string | null>(null);
  const [sessionToFinish, setSessionToFinish] = useState<Session | null>(null);
  const [sessionToCreateChildFor, setSessionToCreateChildFor] = useState<Session | null>(null);
  const [parentSessionToClose, setParentSessionToClose] = useState<Session | null>(null);
  const [pendingCloseAllParentId, setPendingCloseAllParentId] = useState<string | null>(null);
  const [isFeedbackModalOpen, setIsFeedbackModalOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [controlFinalizationRequests, setControlFinalizationRequests] = useState<ControlFinalizationRequest[]>([]);
  const gitRequestGeneration = useRef(0);

  const handleGitStatusChange = useCallback((sessionId: string, status: GitStatusResult) => {
    gitRequestGeneration.current += 1;
    setGitDirtyBySessionId((current) => ({
      ...current,
      [sessionId]: status.isGitRepo && !status.isClean,
    }));
    setGitChangeCountBySessionId((current) => ({
      ...current,
      [sessionId]: status.isGitRepo ? status.totalChanges : 0,
    }));
    setGitSyncBySessionId((current) => ({
      ...current,
      [sessionId]: { ahead: status.ahead, behind: status.behind },
    }));
  }, []);

  // Tab persistence helper
  const getSavedTab = (sessionId: string | null): WorkspaceTabType => {
    if (!sessionId) return 'terminal';
    try {
      const saved = localStorage.getItem(spawneaSessionTabKey(sessionId));
      if (
        saved === 'terminal' ||
        saved === 'files' ||
        saved === 'diff' ||
        saved === 'artifacts' ||
        saved === 'details'
      ) {
        return saved as WorkspaceTabType;
      }
    } catch {}
    return 'terminal';
  };

  const handleTabChange = useCallback((tab: WorkspaceTabType) => {
    setActiveTab(tab);
    if (activeSessionId) {
      try {
        localStorage.setItem(spawneaSessionTabKey(activeSessionId), tab);
      } catch {}
    }
  }, [activeSessionId]);

  const handleRenameSession = useCallback(async (sessionId: string, title: string): Promise<void> => {
    if (!window.spawneaApi?.renameSession) {
      throw new Error('Session title editing is unavailable');
    }
    const updated = await window.spawneaApi.renameSession(sessionId, title);
    setSessions((current) => current.map((session) => (
      session.id === updated.id ? updated : session
    )));
  }, []);

  // Restore saved active tab when active session changes
  useEffect(() => {
    if (activeSessionId) {
      const savedTab = getSavedTab(activeSessionId);
      setActiveTab(savedTab);
    }
  }, [activeSessionId]);

  // Sync activeSessionId to Main process for Notification suppression
  useEffect(() => {
    if (window.spawneaApi?.setActiveSession) {
      window.spawneaApi.setActiveSession(activeSessionId);
    }
    window.spawneaApi?.syncControlUiState?.({ activeSessionId, activeTab });
  }, [activeSessionId, activeTab]);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      if (window.spawneaApi) {
        const [loadedSessions, loadedServers, loadedProjects, loadedAgents, catalogState, pendingControlRequests] = await Promise.all([
          window.spawneaApi.listSessions(),
          window.spawneaApi.listServers(),
          window.spawneaApi.listProjects(),
          window.spawneaApi.listAgents(),
          window.spawneaApi.getCatalog ? window.spawneaApi.getCatalog() : Promise.resolve(null),
          window.spawneaApi.listControlFinalizationRequests
            ? window.spawneaApi.listControlFinalizationRequests(false)
            : Promise.resolve([]),
        ]);

        setSessions(loadedSessions);
        setServers(loadedServers);
        setProjects(loadedProjects);
        setAgents(loadedAgents);
        setControlFinalizationRequests(pendingControlRequests);

        if (window.spawneaApi.getHostSystemInfo) {
          loadedServers.forEach(async (srv) => {
            const credentialBacked = srv.host === 'credential-backed'
              || catalogState?.catalog?.hosts[srv.id]?.ssh?.target === '1Password-backed';
            if (credentialBacked) return;
            try {
              const info = await window.spawneaApi.getHostSystemInfo(srv.id);
              if (info) {
                setHostInfoMap((prev) => ({ ...prev, [srv.id]: info }));
              }
            } catch {
              // ignore
            }
          });
        }

        if (window.spawneaApi.getHostHealth) {
          try {
            const initialHealth = await window.spawneaApi.getHostHealth();
            if (initialHealth) {
              setHostHealthMap((prev) => ({ ...prev, ...initialHealth }));
            }
          } catch {
            // ignore
          }
        }

        if (catalogState) {
          setCatalog(catalogState.catalog);
          setCatalogPath(catalogState.filePath);
          setCatalogErrors(catalogState.errors);
        }

        setActiveSessionId((current) => {
          if (current && loadedSessions.some((s) => s.id === current)) {
            return current;
          }
          return loadedSessions.length > 0 ? loadedSessions[0].id : null;
        });
      } else {
        setStartupError(
          'The Electron preload bridge is unavailable. Spawnea cannot load operational data.'
        );
      }
    } catch (err) {
      console.error('Failed to load Spawnea data:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();

    const unsubs: (() => void)[] = [];

    if (window.spawneaApi?.onStatusChanged) {
      const unStatus = window.spawneaApi.onStatusChanged((sessionId, status, result) => {
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, status, lastActivityAt: new Date() } : s))
        );
        if (result) {
          setStatusDetailsMap((prev) => ({ ...prev, [sessionId]: result }));
        }
        setGitRefreshNonce((current) => current + 1);
      });
      unsubs.push(unStatus);
    }

    if (window.spawneaApi?.onSessionActivate) {
      const unActivate = window.spawneaApi.onSessionActivate((sessionId) => {
        setActiveSessionId(sessionId);
      });
      unsubs.push(unActivate);
    }

    if (window.spawneaApi?.onHostHealthUpdated) {
      const unHealth = window.spawneaApi.onHostHealthUpdated((health) => {
        setHostHealthMap((prev) => ({ ...prev, [health.hostId]: health }));
      });
      unsubs.push(unHealth);
    }

    if (window.spawneaApi?.onHostsHealthChanged) {
      const unAllHealth = window.spawneaApi.onHostsHealthChanged((healthMap) => {
        setHostHealthMap((prev) => ({ ...prev, ...healthMap }));
      });
      unsubs.push(unAllHealth);
    }

    if (window.spawneaApi?.onControlNavigate) {
      const unNavigate = window.spawneaApi.onControlNavigate((state) => {
        if (state.activeSessionId) {
          try {
            localStorage.setItem(spawneaSessionTabKey(state.activeSessionId), state.activeTab);
          } catch {}
        }
        setActiveSessionId(state.activeSessionId);
        setActiveTab(state.activeTab);
      });
      unsubs.push(unNavigate);
    }

    if (window.spawneaApi?.onControlFinalizationRequested) {
      const unFinalization = window.spawneaApi.onControlFinalizationRequested((request) => {
        if (request.mode !== 'ui-confirmation') {
          void loadData();
          return;
        }
        setControlFinalizationRequests((current) => {
          const withoutExisting = current.filter((item) => item.id !== request.id);
          return [...withoutExisting, request];
        });
      });
      unsubs.push(unFinalization);
    }

    if (window.spawneaApi?.onControlDataChanged) {
      const unDataChanged = window.spawneaApi.onControlDataChanged(() => {
        void loadData();
      });
      unsubs.push(unDataChanged);
    }

    return () => {
      unsubs.forEach((fn) => fn());
    };
  }, [loadData]);

  const sessionIdsKey = sessions
    .map((session) => session.id)
    .sort()
    .join('\0');

  useEffect(() => {
    const getGitStatus = window.spawneaApi?.getGitStatus;
    if (!getGitStatus || !sessionIdsKey) {
      setGitDirtyBySessionId({});
      setGitChangeCountBySessionId({});
      setGitSyncBySessionId({});
      return;
    }

    const sessionIds = sessionIdsKey.split('\0');
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    const refreshGitStatus = async (): Promise<void> => {
      const requestGeneration = ++gitRequestGeneration.current;
      const results = await Promise.allSettled(
        sessionIds.map(async (sessionId) => ({
          sessionId,
          status: await getGitStatus(sessionId),
        }))
      );

      if (cancelled) return;
      if (requestGeneration !== gitRequestGeneration.current) {
        pollTimer = setTimeout(refreshGitStatus, 15_000);
        return;
      }

      setGitDirtyBySessionId((current) => {
        const next: Record<string, boolean> = {};
        results.forEach((result, index) => {
          const sessionId = sessionIds[index];
          if (result.status === 'fulfilled') {
            next[sessionId] = result.value.status.isGitRepo && !result.value.status.isClean;
          } else if (sessionId in current) {
            next[sessionId] = current[sessionId];
          }
        });
        return next;
      });

      setGitChangeCountBySessionId((current) => {
        const next: Record<string, number> = {};
        results.forEach((result, index) => {
          const sessionId = sessionIds[index];
          if (result.status === 'fulfilled') {
            next[sessionId] = result.value.status.isGitRepo ? result.value.status.totalChanges : 0;
          } else if (sessionId in current) {
            next[sessionId] = current[sessionId];
          }
        });
        return next;
      });

      setGitSyncBySessionId((current) => {
        const next: Record<string, { ahead: number; behind: number }> = {};
        results.forEach((result, index) => {
          const sessionId = sessionIds[index];
          if (result.status === 'fulfilled') {
            next[sessionId] = {
              ahead: result.value.status.ahead,
              behind: result.value.status.behind,
            };
          } else if (sessionId in current) {
            next[sessionId] = current[sessionId];
          }
        });
        return next;
      });

      pollTimer = setTimeout(refreshGitStatus, 15_000);
    };

    void refreshGitStatus();

    return () => {
      cancelled = true;
      if (pollTimer !== undefined) clearTimeout(pollTimer);
    };
  }, [sessionIdsKey, gitRefreshNonce]);

  const handleControlFinalizationDecision = async (
    requestId: string,
    decision: 'approve' | 'reject'
  ): Promise<void> => {
    if (!window.spawneaApi?.resolveControlFinalizationRequest) return;
    setControlFinalizationRequests((current) => current.map((request) => (
      request.id === requestId ? { ...request, status: 'executing' } : request
    )));
    try {
      const resolved = await window.spawneaApi.resolveControlFinalizationRequest(requestId, decision);
      setControlFinalizationRequests((current) => current.map((request) => (
        request.id === requestId ? resolved : request
      )));
      if (resolved.status === 'completed') {
        await loadData();
        setControlFinalizationRequests((current) => (
          current.some((request) => request.id === resolved.id)
            ? current.map((request) => request.id === resolved.id ? resolved : request)
            : [resolved, ...current]
        ));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setControlFinalizationRequests((current) => current.map((request) => (
        request.id === requestId ? { ...request, status: 'failed', error: message } : request
      )));
    }
  };

  const handleCreateSession = async (input: CreateSessionInput) => {
    if (window.spawneaApi) {
      const created = await window.spawneaApi.createSession(input);
      setSessions((prev) => [created, ...prev]);
      setActiveSessionId(created.id);
    } else {
      const slug = input.task
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 30) || 'task';

      const mockSession: Session = {
        id: `sess-${Date.now()}`,
        name: input.task,
        serverId: input.serverId,
        projectId: input.projectId,
        agentId: input.agentId,
        task: input.task,
        worktreePath: `/workspace/worktrees/${slug}`,
        branch: input.baseBranch || `task/${slug}`,
        tmuxSessionName: `spawnea-${slug}`,
        status: 'starting',
        createdAt: new Date(),
        lastActivityAt: new Date(),
      };
      setSessions((prev) => [mockSession, ...prev]);
      setActiveSessionId(mockSession.id);
    }
  };

  const handleAddProject = async (input: AddProjectToCatalogInput): Promise<{ success: boolean; error?: string }> => {
    if (!window.spawneaApi?.addProjectToCatalog) {
      return { success: false, error: 'Project catalog editing is unavailable in this app runtime.' };
    }

    const result = await window.spawneaApi.addProjectToCatalog(input);
    if (!result.success) {
      return {
        success: false,
        error: result.errors?.map((item) => `${item.path}: ${item.message}`).join('; ') || 'Could not update catalog.',
      };
    }

    setCatalog(result.catalog);
    setCatalogPath(result.filePath);
    setCatalogErrors(null);
    const [loadedServers, loadedProjects, loadedAgents] = await Promise.all([
      window.spawneaApi.listServers(),
      window.spawneaApi.listProjects(),
      window.spawneaApi.listAgents(),
    ]);
    setServers(loadedServers);
    setProjects(loadedProjects);
    setAgents(loadedAgents);
    return { success: true };
  };

  const handleOpenSettings = async (): Promise<{ success: boolean; error?: string }> => {
    setSettingsError(null);
    if (!window.spawneaApi?.openConfig) {
      const error = 'Settings are unavailable in this app runtime.';
      setSettingsError(error);
      return { success: false, error };
    }
    const result = await window.spawneaApi.openConfig();
    if (!result.success) setSettingsError(result.error || 'Could not open configuration file.');
    return result;
  };

  const handleAdoptSession = async (input: AdoptSessionInput) => {
    if (window.spawneaApi?.adoptSession) {
      const adopted = await window.spawneaApi.adoptSession(input);
      setSessions((prev) => [adopted, ...prev]);
      setActiveSessionId(adopted.id);
    } else {
      const mockAdopted: Session = {
        id: `sess-adopted-${Date.now()}`,
        name: input.sessionName || input.tmuxSessionName,
        serverId: input.serverId,
        projectId: input.projectId || 'proj-adhoc',
        agentId: input.agentId || 'agent-terminal',
        task: input.task || input.sessionName || input.tmuxSessionName,
        worktreePath: input.projectPath || '/tmp',
        branch: 'main',
        tmuxSessionName: input.tmuxSessionName,
        status: 'working',
        isExternal: true,
        createdAt: new Date(),
        lastActivityAt: new Date(),
      };
      setSessions((prev) => [mockAdopted, ...prev]);
      setActiveSessionId(mockAdopted.id);
    }
  };

  const handleDetachSession = async (sessionId: string) => {
    if (window.spawneaApi) {
      await window.spawneaApi.detachSession(sessionId);
    }
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, status: 'disconnected' } : s))
    );
  };

  const handleRequestStopSession = (sessionId: string) => {
    const target = sessions.find((s) => s.id === sessionId) || null;
    setSessionToStop(target);
    setStopError(null);
    setIsStoppingSession(false);
  };

  const handleConfirmStopSession = async (sessionId: string) => {
    setIsStoppingSession(true);
    setStopError(null);
    try {
      if (window.spawneaApi) {
        await window.spawneaApi.stopSession(sessionId);
      }
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, status: 'done' } : s))
      );
      setSessionToStop(null);
    } catch (err: any) {
      setStopError(err?.message || 'Failed to terminate session on host');
    } finally {
      setIsStoppingSession(false);
    }
  };

  const handleRequestUnadoptSession = (sessionId: string) => {
    const target = sessions.find((s) => s.id === sessionId) || null;
    setSessionToUnadopt(target);
    setUnadoptError(null);
    setIsUnadoptingSession(false);
  };

  const handleConfirmUnadoptSession = async (sessionId: string) => {
    setIsUnadoptingSession(true);
    setUnadoptError(null);
    try {
      if (window.spawneaApi?.unadoptSession) {
        await window.spawneaApi.unadoptSession(sessionId);
      }
      setSessions((prev) =>
        prev
          .filter((s) => s.id !== sessionId)
          .map((s) =>
            s.parentSessionId === sessionId
              ? { ...s, parentSessionId: undefined, childAlias: undefined }
              : s
          )
      );
      setActiveSessionId((currentActiveId) => {
        if (currentActiveId === sessionId) {
          const remaining = sessions.filter((s) => s.id !== sessionId);
          return remaining.length > 0 ? remaining[0].id : null;
        }
        return currentActiveId;
      });
      setSessionToUnadopt(null);
    } catch (err: any) {
      setUnadoptError(err?.message || 'Failed to release session');
    } finally {
      setIsUnadoptingSession(false);
    }
  };

  const handleRequestFinishSession = (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (session) {
      setSessionToFinish(session);
    }
  };

  const handleFinishSession = async (
    sessionId: string,
    action: FinishSessionAction,
    options?: FinishSessionOptions
  ) => {
    if (action === 'ignore') {
      setSessionToFinish(null);
      return;
    }

    if (window.spawneaApi?.finishSession) {
      const result = await window.spawneaApi.finishSession(sessionId, action, options);
      if (result.removed) {
        setSessions((prev) =>
          prev
            .filter((s) => s.id !== sessionId)
            .map((s) =>
              s.parentSessionId === sessionId
                ? { ...s, parentSessionId: undefined, childAlias: undefined }
                : s
            )
        );
        setActiveSessionId((currentActiveId) => {
          if (currentActiveId === sessionId) {
            const remaining = sessions.filter((s) => s.id !== sessionId);
            return remaining.length > 0 ? remaining[0].id : null;
          }
          return currentActiveId;
        });

        if (pendingCloseAllParentId) {
          const parentId = pendingCloseAllParentId;
          const remainingChildren = sessions.filter(
            (s) => s.parentSessionId === parentId && s.id !== sessionId
          );
          const nextDirtyChild = remainingChildren.find(
            (c) => c.managedWorktree && gitDirtyBySessionId[c.id]
          );
          if (nextDirtyChild) {
            setSessionToFinish(nextDirtyChild);
            return;
          } else {
            setPendingCloseAllParentId(null);
            await executeDeleteSession(parentId, 'close-all', { skipDirtyChildCheck: true });
          }
        }
      } else {
        setPendingCloseAllParentId(null);
      }
    }
    setSessionToFinish(null);
  };

  const handleAttachSession = async (sessionId: string) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, status: 'working' } : s))
    );
  };

  const handleSessionStatusChange = (sessionId: string, status: Session['status']) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, status } : s))
    );
  };

  const executeDeleteSession = async (
    sessionId: string,
    childAction: ParentCloseAction = 'leave-children',
    options?: { skipDirtyChildCheck?: boolean }
  ) => {
    if (childAction === 'close-all' && !options?.skipDirtyChildCheck) {
      const children = sessions.filter((s) => s.parentSessionId === sessionId);
      const dirtyChild = children.find((c) => c.managedWorktree && gitDirtyBySessionId[c.id]);
      if (dirtyChild) {
        setPendingCloseAllParentId(sessionId);
        setSessionToFinish(dirtyChild);
        return;
      }
    }

    if (window.spawneaApi?.deleteSession) {
      try {
        if (childAction === 'close-all') {
          await window.spawneaApi.deleteSession(sessionId, childAction);
        } else {
          await window.spawneaApi.deleteSession(sessionId);
        }
      } catch (err) {
        console.error('Failed to delete session on backend:', err);
        return;
      }
    }

    setSessions((prev) => {
      if (childAction === 'close-all') {
        return prev.filter((s) => s.id !== sessionId && s.parentSessionId !== sessionId);
      } else {
        return prev
          .filter((s) => s.id !== sessionId)
          .map((s) =>
            s.parentSessionId === sessionId
              ? { ...s, parentSessionId: undefined, childAlias: undefined }
              : s
          );
      }
    });

    setActiveSessionId((currentActiveId) => {
      if (
        currentActiveId === sessionId ||
        (childAction === 'close-all' &&
          sessions.find((s) => s.id === currentActiveId)?.parentSessionId === sessionId)
      ) {
        const remaining = sessions.filter(
          (s) =>
            s.id !== sessionId && (childAction !== 'close-all' || s.parentSessionId !== sessionId)
        );
        return remaining.length > 0 ? remaining[0].id : null;
      }
      return currentActiveId;
    });
  };

  const handleDeleteSession = async (sessionId: string) => {
    const target = sessions.find((s) => s.id === sessionId);
    const children = sessions.filter((s) => s.parentSessionId === sessionId);
    if (target && children.length > 0) {
      setParentSessionToClose(target);
      return;
    }
    await executeDeleteSession(sessionId, 'leave-children');
  };

  const handleCloseCreateChildModal = useCallback(() => {
    setSessionToCreateChildFor(null);
  }, []);

  const handleSubmitCreateChildSession = useCallback(async (input: CreateChildSessionInput) => {
    if (!window.spawneaApi?.createChildSession) {
      throw new Error('Child session creation is unavailable in this app runtime.');
    }
    const created = await window.spawneaApi.createChildSession(input);
    setSessions((prev) => [...prev, created]);
    setActiveSessionId(created.id);
  }, []);

  const handleCloseParentModal = useCallback(() => {
    setParentSessionToClose(null);
  }, []);

  const handleConfirmCloseParentModal = useCallback(async (action: ParentCloseAction) => {
    const parent = parentSessionToClose;
    setParentSessionToClose(null);
    if (parent) {
      await executeDeleteSession(parent.id, action);
    }
  }, [parentSessionToClose, executeDeleteSession]);

  const handleClearDoneSessions = async () => {
    const doneSessions = sessions.filter((s) => s.status === 'done');
    setSessions((prev) => prev.filter((s) => s.status !== 'done'));

    setActiveSessionId((currentActiveId) => {
      if (doneSessions.some((s) => s.id === currentActiveId)) {
        const remaining = sessions.filter((s) => s.status !== 'done');
        return remaining.length > 0 ? remaining[0].id : null;
      }
      return currentActiveId;
    });

    for (const s of doneSessions) {
      if (window.spawneaApi?.deleteSession) {
        try {
          await window.spawneaApi.deleteSession(s.id);
        } catch (err) {
          console.error('Failed to delete session on backend:', err);
        }
      }
    }
  };

  const [reloadNotice, setReloadNotice] = useState<string | null>(null);

  const handleLocalDiscoveryApplied = async () => {
    if (!window.spawneaApi) return;
    const [loadedServers, loadedProjects, loadedAgents, catalogState] = await Promise.all([
      window.spawneaApi.listServers(),
      window.spawneaApi.listProjects(),
      window.spawneaApi.listAgents(),
      window.spawneaApi.getCatalog(),
    ]);
    setServers(loadedServers);
    setProjects(loadedProjects);
    setAgents(loadedAgents);
    setCatalog(catalogState.catalog);
    setCatalogPath(catalogState.filePath);
    setCatalogErrors(catalogState.errors);
    setReloadNotice('Confirmed discovery changes were written to the catalog.');
    setTimeout(() => setReloadNotice(null), 4000);
  };

  const handleReloadCatalog = async () => {
    if (window.spawneaApi?.reloadCatalog) {
      setIsReloadingCatalog(true);
      try {
        const result = await window.spawneaApi.reloadCatalog();
        if (result.catalog) {
          setCatalog(result.catalog);
        }
        setCatalogPath(result.filePath);
        setCatalogErrors(result.errors);
        // Refresh server/project/agent lists
        const [loadedServers, loadedProjects, loadedAgents] = await Promise.all([
          window.spawneaApi.listServers(),
          window.spawneaApi.listProjects(),
          window.spawneaApi.listAgents(),
        ]);
        setServers(loadedServers);
        setProjects(loadedProjects);
        setAgents(loadedAgents);

        if (result.success && result.catalog) {
          const hostCount = Object.keys(result.catalog.hosts).length;
          setReloadNotice(
            `Config reloaded: ${hostCount} host(s), ${loadedProjects.length} project(s), ${loadedAgents.length} harness(es)`
          );
          setTimeout(() => setReloadNotice(null), 4000);
        }
      } catch (err) {
        console.error('Failed to reload operational catalog:', err);
      } finally {
        setIsReloadingCatalog(false);
      }
    }
  };

  const handleRefresh = async () => {
    setIsLoading(true);
    try {
      if (window.spawneaApi?.reconcileSessions) {
        const [reconciledSessions, loadedServers, loadedProjects, loadedAgents] = await Promise.all([
          window.spawneaApi.reconcileSessions(),
          window.spawneaApi.listServers(),
          window.spawneaApi.listProjects(),
          window.spawneaApi.listAgents(),
        ]);
        setSessions(reconciledSessions);
        setServers(loadedServers);
        setProjects(loadedProjects);
        setAgents(loadedAgents);
      } else {
        await loadData();
      }
      setGitRefreshNonce((current) => current + 1);
    } catch (err) {
      console.error('Failed to refresh/reconcile data:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('spawnea:sidebar:collapsed') === 'true';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('spawnea:sidebar:collapsed', String(isSidebarCollapsed));
    } catch {}
  }, [isSidebarCollapsed]);

  // Global keyboard navigation shortcuts:
  // - Quick Switcher: Ctrl+P / Cmd+P / Ctrl+K / Cmd+K
  // - Workspace Tabs: Alt+1..5
  // - Sidebar Toggle: Ctrl+Shift+B
  // - Session Navigation: Ctrl+1..0, Ctrl+Tab, Ctrl+Shift+Tab
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isCtrl = e.ctrlKey || e.metaKey;

      // 1. Quick Switcher: Ctrl+P / Cmd+P / Ctrl+K / Cmd+K
      if (isCtrl && !e.shiftKey && !e.altKey && (e.key === 'p' || e.key === 'P' || e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        e.stopPropagation();
        setIsQuickSwitcherOpen((prev) => !prev);
        return;
      }

      // 2. Tab Navigation: Alt+1..5
      if (e.altKey && !isCtrl && !e.shiftKey) {
        const tabKeyMap: Record<string, WorkspaceTabType> = {
          '1': 'terminal',
          '2': 'files',
          '3': 'diff',
          '4': 'artifacts',
          '5': 'details',
        };
        if (e.key in tabKeyMap) {
          e.preventDefault();
          e.stopPropagation();
          handleTabChange(tabKeyMap[e.key]);
          return;
        }
      }

      if (!isCtrl) return;

      // 3. Handle Ctrl+Shift+B / Cmd+Shift+B to toggle sidebar collapse
      if ((e.key === 'b' || e.key === 'B') && e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        setIsSidebarCollapsed((prev) => !prev);
        return;
      }

      // Top (father/root) sessions for direct number navigation (Ctrl-1..0)
      const rootSessions = sessions
        .filter((s) => !s.parentSessionId)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));

      // Hierarchical ordered list for Ctrl-Tab / Ctrl-Shift-Tab cycling: father first, then children in order
      const cyclingSessions = getHierarchicalSessionOrder(sessions);

      if (cyclingSessions.length === 0) return;

      // 4. Handle Ctrl+Tab / Ctrl+Shift+Tab
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();

        const currentIndex = cyclingSessions.findIndex((s) => s.id === activeSessionId);
        if (e.shiftKey) {
          // Previous session
          const prevIndex = currentIndex <= 0 ? cyclingSessions.length - 1 : currentIndex - 1;
          setActiveSessionId(cyclingSessions[prevIndex].id);
        } else {
          // Next session
          const nextIndex = currentIndex === -1 || currentIndex >= cyclingSessions.length - 1 ? 0 : currentIndex + 1;
          setActiveSessionId(cyclingSessions[nextIndex].id);
        }
        return;
      }

      // 5. Handle Ctrl+1 ... Ctrl+9, Ctrl+0 (Always targets the top / father sessions)
      const keyMap: Record<string, number> = {
        '1': 0,
        '2': 1,
        '3': 2,
        '4': 3,
        '5': 4,
        '6': 5,
        '7': 6,
        '8': 7,
        '9': 8,
        '0': 9,
      };

      if (e.key in keyMap && !e.shiftKey && !e.altKey) {
        const targetIndex = keyMap[e.key];
        if (targetIndex < rootSessions.length) {
          e.preventDefault();
          e.stopPropagation();
          setActiveSessionId(rootSessions[targetIndex].id);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [sessions, activeSessionId, handleTabChange]);

  const activeSession = sessions.find((s) => s.id === activeSessionId) || null;
  const activeServer = activeSession ? servers.find((s) => s.id === activeSession.serverId) : undefined;
  const activeProject = activeSession ? projects.find((p) => p.id === activeSession.projectId) : undefined;
  const activeAgent = activeSession ? agents.find((a) => a.id === activeSession.agentId) : undefined;

  if (startupError || !window.spawneaApi) {
    return (
      <main className="flex h-screen w-screen items-center justify-center bg-[#0d1117] px-6 text-[#c9d1d9]">
        <section className="w-full max-w-2xl rounded-lg border border-red-500/40 bg-[#161b22] p-6 shadow-xl">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-red-400">Spawnea startup failure</p>
          <h1 className="mb-3 text-xl font-semibold text-white">The desktop bridge is unavailable</h1>
          <p className="mb-4 text-sm text-zinc-300">
            Spawnea stopped before loading your operational catalog. No fallback data was loaded.
          </p>
          <pre className="overflow-x-auto rounded bg-[#0d1117] p-3 text-xs text-red-300">
            {startupError ?? 'window.spawneaApi is not available'}
          </pre>
          <p className="mt-4 text-xs text-zinc-500">Check the Electron terminal and log.txt for the preload error.</p>
        </section>
      </main>
    );
  }

  return (
    <div className="flex h-screen w-screen bg-[#0d1117] text-[#c9d1d9] overflow-hidden select-none font-sans">
      {/* Navigation Sidebar */}
      <Sidebar
        sessions={sessions}
        servers={servers}
        projects={projects}
        agents={agents}
        hostInfoMap={hostInfoMap}
        hostHealthMap={hostHealthMap}
        statusDetailsMap={statusDetailsMap}
        gitDirtyBySessionId={gitDirtyBySessionId}
        gitChangeCountBySessionId={gitChangeCountBySessionId}
        activeSessionId={activeSessionId}
        onSelectSession={setActiveSessionId}
        onOpenCreateModal={() => setIsCreateModalOpen(true)}
        onOpenCreateChildModal={(parentId) => {
          const target = (parentId ? sessions.find((s) => s.id === parentId) : null) ||
            (activeSession
              ? activeSession.parentSessionId
                ? sessions.find((s) => s.id === activeSession.parentSessionId)
                : activeSession
              : sessions.find((s) => !s.parentSessionId)) ||
            null;
          if (target) setSessionToCreateChildFor(target);
        }}
        onOpenNewProject={() => setIsNewProjectModalOpen(true)}
        onOpenLocalDiscovery={() => setIsLocalDiscoveryOpen(true)}
        onOpenSettings={() => { void handleOpenSettings(); }}
        onOpenAdoptModal={() => setIsAdoptModalOpen(true)}
        onRefresh={handleRefresh}
        onReloadCatalog={handleReloadCatalog}
        onCheckHostHealth={(id) => window.spawneaApi?.checkHostHealth(id)}
        onDeleteSession={handleDeleteSession}
        onClearDoneSessions={handleClearDoneSessions}
        isReloadingCatalog={isReloadingCatalog}
        catalogErrorCount={catalogErrors ? catalogErrors.length : 0}
        catalogPath={catalogPath}
        isLoading={isLoading}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapse={() => setIsSidebarCollapsed((prev) => !prev)}
      />

      {/* Main Workspace Area */}
      <main className="flex-1 flex flex-col bg-[#0d1117] overflow-hidden">
        {reloadNotice && (
          <div
            data-testid="catalog-reload-success-banner"
            className="bg-emerald-950/60 border-b border-emerald-500/30 text-emerald-300 px-4 py-2 text-xs flex items-center justify-between transition-all"
          >
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span>{reloadNotice}</span>
            </div>
            <button
              type="button"
              onClick={() => setReloadNotice(null)}
              className="text-emerald-400 hover:text-white text-xs cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {catalogErrors && catalogErrors.length > 0 && (
          <CatalogErrorBanner
            errors={catalogErrors}
            activeCatalog={catalog}
            onReload={handleReloadCatalog}
            isReloading={isReloadingCatalog}
          />
        )}

        {sessions.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-[#0d1117]">
            <div className="w-16 h-16 rounded-2xl bg-[#161b22] border border-[#30363d] flex items-center justify-center text-emerald-400 mb-4 shadow-xl">
              <Terminal className="w-8 h-8" />
            </div>
            <h2 className="text-lg font-bold text-white mb-2">No Active Agent Sessions</h2>
            <p className="text-xs text-zinc-400 max-w-md mb-6 leading-relaxed">
              Spawnea runs AI coding agents inside persistent remote or local tmux sessions.
              Closing this application will not terminate running agents.
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                data-testid="empty-state-new-session-button"
                onClick={() => setIsCreateModalOpen(true)}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold transition-all shadow-md hover:shadow-emerald-600/20 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>Create Your First Session</span>
              </button>
              <button
                type="button"
                data-testid="empty-state-adopt-session-button"
                onClick={() => setIsAdoptModalOpen(true)}
                className="flex items-center gap-2 px-4 py-2 bg-cyan-950/80 hover:bg-cyan-900 text-cyan-300 border border-cyan-500/40 rounded-lg text-xs font-semibold transition-all shadow-md cursor-pointer"
              >
                <span>Adopt External tmux Session</span>
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Context Driver Bar */}
            <ContextBar
              session={activeSession}
              server={activeServer}
              project={activeProject}
              agent={activeAgent}
              hostInfo={activeSession ? hostInfoMap[activeSession.serverId] : undefined}
              hasUncommittedChanges={activeSession ? gitDirtyBySessionId[activeSession.id] : false}
              gitChangeCount={activeSession ? gitChangeCountBySessionId[activeSession.id] : 0}
              onDetach={handleDetachSession}
              onStop={handleRequestStopSession}
              onAttach={handleAttachSession}
              onDelete={handleDeleteSession}
              onUnadopt={handleRequestUnadoptSession}
              onFinish={handleRequestFinishSession}
              onReportFeedback={() => setIsFeedbackModalOpen(true)}
              onOpenQuickSwitcher={() => setIsQuickSwitcherOpen(true)}
              onRename={handleRenameSession}
              onCreateChild={(parentId) => {
                const target = sessions.find((s) => s.id === parentId);
                if (target) setSessionToCreateChildFor(target);
              }}
            />

            {/* Tabbed Workspace Surface */}
            <WorkspaceTabs
              session={activeSession}
              server={activeServer}
              project={activeProject}
              agent={activeAgent}
              hasUncommittedChanges={activeSession ? gitDirtyBySessionId[activeSession.id] : false}
              gitChangeCount={activeSession ? gitChangeCountBySessionId[activeSession.id] : 0}
              gitAhead={activeSession ? gitSyncBySessionId[activeSession.id]?.ahead : 0}
              gitBehind={activeSession ? gitSyncBySessionId[activeSession.id]?.behind : 0}
              onGitStatusChange={handleGitStatusChange}
              activeTab={activeTab}
              onTabChange={handleTabChange}
              onAttach={handleAttachSession}
              onDetach={handleDetachSession}
              onDelete={handleDeleteSession}
              onStatusChange={handleSessionStatusChange}
            />
          </>
        )}
      </main>

      {/* Quick Switcher Modal (Ctrl+P / Ctrl+K / Cmd+P / Cmd+K) */}
      <QuickSwitcherModal
        isOpen={isQuickSwitcherOpen}
        onClose={() => setIsQuickSwitcherOpen(false)}
        sessions={sessions}
        servers={servers}
        projects={projects}
        agents={agents}
        activeSessionId={activeSessionId}
        activeTab={activeTab}
        onSelectSession={setActiveSessionId}
        onSelectTab={handleTabChange}
        onOpenCreateModal={() => setIsCreateModalOpen(true)}
        onOpenAdoptModal={() => setIsAdoptModalOpen(true)}
        onReloadCatalog={handleReloadCatalog}
        onRefresh={handleRefresh}
        onToggleSidebar={() => setIsSidebarCollapsed((prev) => !prev)}
        onClearDoneSessions={handleClearDoneSessions}
        statusDetailsMap={statusDetailsMap}
      />

      {/* Create Session Modal */}
      <CreateSessionModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onSubmit={handleCreateSession}
        servers={servers}
        projects={projects}
        agents={agents}
        catalog={catalog}
        hostHealthMap={hostHealthMap}
      />

      <NewProjectModal
        isOpen={isNewProjectModalOpen}
        onClose={() => setIsNewProjectModalOpen(false)}
        onSubmit={handleAddProject}
        servers={servers}
        onOpenSettings={handleOpenSettings}
      />

      <LocalDiscoveryModal
        isOpen={isLocalDiscoveryOpen}
        catalog={catalog}
        onClose={() => setIsLocalDiscoveryOpen(false)}
        onApplied={handleLocalDiscoveryApplied}
      />

      {settingsError && (
        <div data-testid="settings-error" className="fixed bottom-4 right-4 z-[60] max-w-sm rounded-lg border border-rose-500/40 bg-[#2b1620] px-4 py-3 text-xs text-rose-200 shadow-2xl">
          <div className="flex items-start justify-between gap-3"><span>{settingsError}</span><button type="button" onClick={() => setSettingsError(null)} className="text-rose-300 hover:text-white" aria-label="Dismiss settings error">×</button></div>
        </div>
      )}

      {/* Adopt External Tmux Session Modal */}
      <AdoptSessionModal
        isOpen={isAdoptModalOpen}
        onClose={() => setIsAdoptModalOpen(false)}
        onSubmit={handleAdoptSession}
        servers={servers}
        projects={projects}
        agents={agents}
        hostHealthMap={hostHealthMap}
      />

      {/* Stop Session Active-Work Warning Modal (FG-2.7.1, FG-2.7.2) */}
      <StopSessionModal
        isOpen={sessionToStop !== null}
        session={sessionToStop}
        server={sessionToStop ? servers.find((s) => s.id === sessionToStop.serverId) : undefined}
        project={sessionToStop ? projects.find((p) => p.id === sessionToStop.projectId) : undefined}
        agent={sessionToStop ? agents.find((a) => a.id === sessionToStop.agentId) : undefined}
        onClose={() => {
          setSessionToStop(null);
          setStopError(null);
        }}
        onDetach={handleDetachSession}
        onConfirmStop={handleConfirmStopSession}
        isStopping={isStoppingSession}
        error={stopError}
      />

      {/* Unadopt / Release Session Modal (FG-7.2.3) */}
      <UnadoptSessionModal
        isOpen={sessionToUnadopt !== null}
        session={sessionToUnadopt}
        server={sessionToUnadopt ? servers.find((s) => s.id === sessionToUnadopt.serverId) : undefined}
        project={sessionToUnadopt ? projects.find((p) => p.id === sessionToUnadopt.projectId) : undefined}
        agent={sessionToUnadopt ? agents.find((a) => a.id === sessionToUnadopt.agentId) : undefined}
        onClose={() => {
          setSessionToUnadopt(null);
          setUnadoptError(null);
        }}
        onConfirmUnadopt={handleConfirmUnadoptSession}
        isUnadopting={isUnadoptingSession}
        error={unadoptError}
      />

      {/* Finish / Integrate Managed Worktree Session Modal (Task 6.2.1) */}
      <FinishSessionModal
        isOpen={sessionToFinish !== null}
        session={sessionToFinish}
        onClose={() => {
          setSessionToFinish(null);
          setPendingCloseAllParentId(null);
        }}
        onFinish={handleFinishSession}
      />

      {/* Create Child Session Modal */}
      <CreateChildSessionModal
        isOpen={Boolean(sessionToCreateChildFor)}
        parentSession={sessionToCreateChildFor}
        agents={agents}
        servers={servers}
        onClose={handleCloseCreateChildModal}
        onSubmit={handleSubmitCreateChildSession}
      />

      {/* Close Parent Session Modal */}
      <CloseParentModal
        isOpen={Boolean(parentSessionToClose)}
        parentSession={parentSessionToClose}
        childrenSessions={
          parentSessionToClose
            ? sessions.filter((s) => s.parentSessionId === parentSessionToClose.id)
            : []
        }
        gitDirtyBySessionId={gitDirtyBySessionId}
        onClose={handleCloseParentModal}
        onConfirm={handleConfirmCloseParentModal}
      />

      <ControlFinalizationModal
        request={controlFinalizationRequests[0] ?? null}
        onDecision={handleControlFinalizationDecision}
        onDismiss={(requestId) => setControlFinalizationRequests((current) => (
          current.filter((request) => request.id !== requestId)
        ))}
      />

      {/* State Misclassification Feedback Modal (FG-4.2.5) */}
      <StateFeedbackModal
        isOpen={isFeedbackModalOpen}
        session={activeSession}
        server={activeServer}
        agent={activeAgent}
        onClose={() => setIsFeedbackModalOpen(false)}
      />
    </div>
  );
}
