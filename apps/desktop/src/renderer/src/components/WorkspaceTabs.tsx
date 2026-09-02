import React, { useState, useEffect, useCallback } from 'react';
import type {
  Session,
  Server,
  Project,
  Agent,
  Artifact,
  HostSystemInfo,
  HostConnectionEndpoint,
  GitStatusResult,
  GitDiffResult,
} from '@spawnea/domain';
import { isLoopbackHost } from '@spawnea/domain/hosts';
import { TerminalView } from './TerminalView';
import { FileBrowser } from './FileBrowser';
import { GitStatusView } from './GitStatusView';
import { DiffViewer } from './DiffViewer';
import { ArtifactGallery } from './ArtifactGallery';
import { ArtifactPreviewModal } from './ArtifactPreviewModal';
import { DetectedOutputBanner } from './DetectedOutputBanner';
import { ToastNotification, type ToastAction } from './ToastNotification';
import { OsIcon } from './OsIcon';
import { SessionSourceBadge } from './SessionSourceBadge';
import {
  Terminal,
  FolderTree,
  GitBranch,
  GitFork,
  FileCode2,
  Info,
  Copy,
  Check,
  RefreshCw,
  Server as ServerIcon,
  Loader2,
  AlertCircle,
  UploadCloud,
  FileDiff,
} from 'lucide-react';

export type WorkspaceTabType = 'terminal' | 'files' | 'diff' | 'artifacts' | 'details';

function isLocalClipboardBridgeEndpoint(endpoint?: HostConnectionEndpoint | null): boolean {
  return endpoint?.transport === 'local' && isLoopbackHost(endpoint.hostname);
}

interface WorkspaceTabsProps {
  session: Session | null;
  server?: Server;
  project?: Project;
  agent?: Agent;
  hasUncommittedChanges?: boolean;
  gitChangeCount?: number;
  activeTab: WorkspaceTabType;
  onTabChange: (tab: WorkspaceTabType) => void;
  onAttach?: (sessionId: string) => void;
  onDetach?: (sessionId: string) => void;
  onDelete?: (sessionId: string) => void;
  onStatusChange?: (sessionId: string, status: Session['status']) => void;
}

interface DetailCardProps {
  label: string;
  value: string;
  displayNode?: React.ReactNode;
  mono?: boolean;
  testId?: string;
}

function DetailCard({
  label,
  value,
  displayNode,
  mono = true,
  testId,
}: DetailCardProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!value) return;
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="p-3 bg-[#12161c] border border-[#21262d] rounded-lg flex items-start justify-between gap-2 group hover:border-[#30363d] transition-colors">
      <div className="flex-1 min-w-0">
        <dt className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-1">{label}</dt>
        <dd className={`text-xs break-all ${mono ? 'font-mono' : ''} text-zinc-200`}>
          {displayNode ?? value}
        </dd>
      </div>
      <button
        type="button"
        onClick={handleCopy}
        data-testid={testId ? `copy-${testId}-button` : undefined}
        title={`Copy ${label}`}
        className="p-1.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-[#21262d] transition-colors shrink-0 opacity-70 group-hover:opacity-100 cursor-pointer"
        aria-label={`Copy ${label}`}
      >
        {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

export function WorkspaceTabs({
  session,
  server,
  project,
  agent,
  hasUncommittedChanges = false,
  gitChangeCount = hasUncommittedChanges ? 1 : 0,
  activeTab,
  onTabChange,
  onAttach,
  onDetach,
  onDelete,
  onStatusChange,
}: WorkspaceTabsProps): React.JSX.Element {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [isLoadingArtifacts, setIsLoadingArtifacts] = useState(false);
  const [hostInfo, setHostInfo] = useState<HostSystemInfo | null>(null);
  const [isLoadingHostInfo, setIsLoadingHostInfo] = useState(false);
  const [clipboardBridgeState, setClipboardBridgeState] = useState<{
    sessionId: string | null;
    available: boolean;
  }>({ sessionId: null, available: false });

  // Output detection banner and modal preview
  const [detectedOutput, setDetectedOutput] = useState<Artifact | null>(null);
  const [previewingArtifact, setPreviewingArtifact] = useState<Artifact | null>(null);

  // Drag & drop state
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  // Toast state
  const [toast, setToast] = useState<{
    id: string;
    title: string;
    message?: string;
    type?: 'success' | 'info' | 'warning';
    actions?: ToastAction[];
  } | null>(null);

  // Git State
  const [gitStatus, setGitStatus] = useState<GitStatusResult | null>(null);
  const [gitStatusSessionId, setGitStatusSessionId] = useState<string | null>(null);
  const [gitDiff, setGitDiff] = useState<GitDiffResult | null>(null);
  const [selectedDiffFilePath, setSelectedDiffFilePath] = useState<string | null>(null);
  const [isLoadingGit, setIsLoadingGit] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);

  const fetchArtifacts = useCallback(async (sessionId: string) => {
    if (!window.spawneaApi?.getArtifacts) {
      setArtifacts([]);
      return;
    }
    setIsLoadingArtifacts(true);
    try {
      const list = await window.spawneaApi.getArtifacts(sessionId);
      setArtifacts(list);
    } catch {
      setArtifacts([]);
    } finally {
      setIsLoadingArtifacts(false);
    }
  }, []);

  const fetchHostInfo = useCallback(async (serverId: string) => {
    if (!window.spawneaApi?.getHostSystemInfo) {
      setHostInfo(null);
      return;
    }

    setIsLoadingHostInfo(true);
    try {
      const info = await window.spawneaApi.getHostSystemInfo(serverId);
      setHostInfo(info);
    } catch {
      setHostInfo(null);
    } finally {
      setIsLoadingHostInfo(false);
    }
  }, []);

  const fetchGitData = useCallback(async (sessionId: string, filePath?: string | null) => {
    if (!window.spawneaApi?.getGitStatus) {
      setGitStatus({
        isGitRepo: true,
        branch: session?.branch || 'main',
        ahead: 0,
        behind: 0,
        isClean: false,
        staged: [],
        unstaged: [{ path: 'apps/desktop/src/App.tsx', status: 'modified', staged: false, statusCode: 'M' }],
        untracked: [],
        totalChanges: 1,
      });
      setGitStatusSessionId(sessionId);
      return;
    }

    setIsLoadingGit(true);
    setGitError(null);

    try {
      const status = await window.spawneaApi.getGitStatus(sessionId);
      setGitStatus(status);
      setGitStatusSessionId(sessionId);

      const diff = await window.spawneaApi.getGitDiff(sessionId, {
        filePath: filePath || undefined,
      });
      setGitDiff(diff);
    } catch (err: any) {
      setGitError(err.message || 'Failed to inspect Git repository');
      setGitStatus(null);
      setGitStatusSessionId(null);
      setGitDiff(null);
    } finally {
      setIsLoadingGit(false);
    }
  }, [session?.branch]);

  useEffect(() => {
    if (!session) {
      setClipboardBridgeState({ sessionId: null, available: false });
      setArtifacts([]);
      setHostInfo(null);
      setGitStatus(null);
      setGitStatusSessionId(null);
      setGitDiff(null);
      setSelectedDiffFilePath(null);
      setDetectedOutput(null);
      return;
    }

    setDetectedOutput(null);
    fetchArtifacts(session.id);
  }, [session?.id, fetchArtifacts]);

  useEffect(() => {
    let isCurrent = true;
    const sessionId = session?.id ?? null;
    setClipboardBridgeState({ sessionId: null, available: false });

    if (!session || typeof window.spawneaApi?.getHostConnectionEndpoint !== 'function') {
      return () => {
        isCurrent = false;
      };
    }

    void window.spawneaApi.getHostConnectionEndpoint(session.serverId)
      .then((endpoint) => {
        if (isCurrent) {
          setClipboardBridgeState({
            sessionId,
            available: isLocalClipboardBridgeEndpoint(endpoint),
          });
        }
      })
      .catch(() => {
        if (isCurrent) {
          setClipboardBridgeState({ sessionId, available: false });
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [session?.id, session?.serverId]);

  useEffect(() => {
    if (!session) return;

    if (activeTab === 'artifacts') {
      fetchArtifacts(session.id);
      setDetectedOutput(null);
    } else if (activeTab === 'diff') {
      fetchGitData(session.id, selectedDiffFilePath);
    } else if (activeTab === 'details') {
      fetchHostInfo(session.serverId);
    }
  }, [session?.id, session?.serverId, activeTab, selectedDiffFilePath, fetchArtifacts, fetchGitData, fetchHostInfo]);

  // Listen to artifact creation events from supervisor or upload
  useEffect(() => {
    if (!window.spawneaApi?.onArtifactCreated || !session) return;

    const cleanup = window.spawneaApi.onArtifactCreated((sId, art) => {
      if (sId === session.id) {
        fetchArtifacts(session.id);
        if (art.direction === 'output') {
          setDetectedOutput(art);
        }
      }
    });

    return cleanup;
  }, [session?.id, fetchArtifacts]);

  // Global Clipboard Paste Handler (Ctrl+V / Cmd+V for image pasting)
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      if (!session || !e.clipboardData) return;

      const items = e.clipboardData.items;
      let imageItem: DataTransferItem | null = null;

      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          imageItem = items[i];
          break;
        }
      }

      if (!imageItem) return;

      const file = imageItem.getAsFile();
      if (!file) return;

      e.preventDefault();
      try {
        const buffer = new Uint8Array(await file.arrayBuffer());
        const filename = `screenshot-${Date.now()}.png`;

        if (window.spawneaApi?.uploadArtifactData) {
          const art = await window.spawneaApi.uploadArtifactData(
            session.id,
            buffer,
            filename,
            file.type || 'image/png',
            'input'
          );

          fetchArtifacts(session.id);

          const relativePath = `.spawnea/artifacts/${art.filename}`;
          setToast({
            id: `toast-${Date.now()}`,
            title: 'Pasted image saved to workspace',
            message: relativePath,
            type: 'success',
            actions: [
              {
                label: 'Copy Path',
                icon: Copy,
                onClick: () => {
                  navigator.clipboard.writeText(relativePath);
                },
              },
              {
                label: 'Insert into Terminal',
                icon: Terminal,
                primary: true,
                onClick: () => {
                  if (window.spawneaApi?.writePty) {
                    window.spawneaApi.writePty(`pty-${session.id}`, `${relativePath} `);
                  }
                },
              },
            ],
          });
        }
      } catch (err: any) {
        setToast({
          id: `toast-err-${Date.now()}`,
          title: 'Failed to upload pasted image',
          message: err.message,
          type: 'warning',
        });
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [session?.id, fetchArtifacts]);

  // Drag & Drop Ingestion Handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!isDraggingOver) setIsDraggingOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDraggingOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);
    if (!session || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;

    const files = e.dataTransfer.files;
    let uploadedCount = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        if (window.spawneaApi?.uploadArtifactData) {
          const buf = new Uint8Array(await file.arrayBuffer());
          await window.spawneaApi.uploadArtifactData(
            session.id,
            buf,
            file.name,
            file.type || 'application/octet-stream',
            'input'
          );
          uploadedCount++;
        }
      } catch (err: any) {
        console.error('Failed to drop upload file', err);
        setToast({
          id: `toast-err-${Date.now()}`,
          title: 'Failed to upload dropped file',
          message: err.message,
          type: 'warning',
        });
      }
    }

    if (uploadedCount > 0) {
      fetchArtifacts(session.id);
      setToast({
        id: `toast-drop-${Date.now()}`,
        title: `Uploaded ${uploadedCount} file${uploadedCount > 1 ? 's' : ''} to workspace`,
        message: `.spawnea/artifacts/`,
        type: 'success',
      });
    }
  };


  const tabs: {
    id: WorkspaceTabType;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    shortcut: string;
    badge?: number | string;
  }[] = [
    { id: 'terminal', label: 'Terminal (tmux)', icon: Terminal, shortcut: 'Alt+1' },
    { id: 'files', label: 'Files', icon: FolderTree, shortcut: 'Alt+2' },
    {
      id: 'diff',
      label: 'Git Diff',
      badge: gitStatusSessionId === session?.id && gitStatus && gitStatus.totalChanges > 0
        ? gitStatus.totalChanges
        : (gitChangeCount > 0 ? gitChangeCount : undefined),
      icon: GitBranch,
      shortcut: 'Alt+3',
    },
    {
      id: 'artifacts',
      label: 'Artifacts',
      badge: artifacts.length > 0 ? artifacts.length : undefined,
      icon: FileCode2,
      shortcut: 'Alt+4',
    },
    { id: 'details', label: 'Session Info', icon: Info, shortcut: 'Alt+5' },
  ];

  if (!session) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-zinc-500 bg-[#0d1117]">
        <Terminal className="w-12 h-12 text-zinc-600 mb-3" />
        <h3 className="text-sm font-semibold text-zinc-300">No Session Selected</h3>
        <p className="text-xs text-zinc-500 max-w-sm mt-1">
          Select a session from the sidebar or click "New Session" to start operating an agent.
        </p>
      </div>
    );
  }

  return (
    <div
      className="flex-1 flex flex-col bg-[#0d1117] overflow-hidden relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag and Drop Overlay */}
      {isDraggingOver && (
        <div className="absolute inset-0 z-40 bg-emerald-950/80 border-2 border-dashed border-emerald-400 backdrop-blur-sm flex flex-col items-center justify-center pointer-events-none animate-in fade-in duration-100">
          <UploadCloud className="w-16 h-16 text-emerald-300 mb-3 animate-bounce" />
          <h3 className="text-lg font-bold text-white">Drop files to upload to session</h3>
          <p className="text-xs text-emerald-200 mt-1">
            Files will be saved in <code className="font-mono bg-emerald-900/60 px-1 py-0.5 rounded">.spawnea/artifacts/</code> for the LLM
          </p>
        </div>
      )}

      {/* Tab Navigation Rail */}
      <div className="h-10 px-4 border-b border-[#30363d] bg-[#0d1117] flex items-center justify-between shrink-0 select-none">
        <div className="flex items-center gap-1">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                type="button"
                key={tab.id}
                data-testid={`workspace-tab-${tab.id}`}
                onClick={() => onTabChange(tab.id)}
                title={`${tab.label} (${tab.shortcut})`}
                className={`group flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md transition-all cursor-pointer ${
                  isActive
                    ? 'bg-[#21262d] text-emerald-400 border border-[#30363d] shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-[#161b22]'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
                {typeof tab.badge !== 'undefined' && (
                  <span
                    className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono font-bold ${
                      tab.id === 'artifacts'
                        ? 'bg-blue-950 text-blue-300 border border-blue-800/60'
                        : 'bg-amber-950 text-amber-300 border border-amber-800/60'
                    }`}
                  >
                    {tab.badge}
                  </span>
                )}
                <kbd
                  data-testid={`workspace-tab-shortcut-${tab.id}`}
                  className="hidden md:inline-block px-1 py-0.2 text-[9px] font-mono rounded bg-[#0d1117]/80 text-zinc-500 border border-[#30363d]/60 group-hover:text-zinc-300 group-hover:border-[#484f58] transition-colors"
                >
                  {tab.shortcut}
                </kbd>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 text-[11px] text-zinc-500 font-mono">
          <SessionSourceBadge session={session} />
          {session.managedWorktree && (
            <span
              data-testid="workspace-worktree-badge"
              className="flex items-center gap-1.5 px-2 py-0.5 rounded border border-teal-500/25 bg-teal-500/10 text-teal-300 font-sans font-medium"
              title={`Managed Git worktree\nBranch: ${session.branch}\nPath: ${session.worktreePath}${hasUncommittedChanges ? '\nUncommitted Git changes' : ''}`}
            >
              <GitFork className="w-3 h-3" />
              <span>Worktree</span>
              {hasUncommittedChanges && (
                <>
                  <FileDiff data-testid="workspace-worktree-dirty-indicator" aria-label="Uncommitted Git changes" className="w-3 h-3 text-amber-300" />
                  <span data-testid="workspace-worktree-change-count">{gitChangeCount}</span>
                </>
              )}
            </span>
          )}
          {!session.managedWorktree && hasUncommittedChanges && (
            <>
              <FileDiff data-testid="workspace-git-dirty-indicator" aria-label="Uncommitted Git changes" className="w-3.5 h-3.5 text-amber-300 shrink-0" />
              <span data-testid="workspace-git-change-count">{gitChangeCount}</span>
            </>
          )}
          <span>tmux: {session.tmuxSessionName}</span>
        </div>
      </div>

      {/* Tab Content Panels */}
      <div className="flex-1 p-5 overflow-auto">
        {/* Terminal Panel */}
        {activeTab === 'terminal' && (
          <div className="h-full flex flex-col gap-3">
            {detectedOutput && (
              <DetectedOutputBanner
                artifact={detectedOutput}
                onPreview={(art) => setPreviewingArtifact(art)}
                onViewInArtifacts={() => {
                  onTabChange('artifacts');
                  setDetectedOutput(null);
                }}
                onDismiss={() => setDetectedOutput(null)}
              />
            )}
            <div className="flex-1 min-h-0">
              <TerminalView
                session={session}
                agent={agent}
                clipboardBridgeAvailable={clipboardBridgeState.sessionId === session?.id && clipboardBridgeState.available}
                onAttach={onAttach}
                onDetach={onDetach}
                onDelete={onDelete}
                onStatusChange={onStatusChange}
              />
            </div>
          </div>
        )}

        {/* Files Panel (FileBrowser) */}
        {activeTab === 'files' && (
          <FileBrowser
            sessionId={session.id}
            worktreePath={session.worktreePath}
          />
        )}

        {/* Git Diff Panel (GitStatusView + DiffViewer) */}
        {activeTab === 'diff' && (
          <div className="h-full flex flex-col gap-4 overflow-hidden">
            <GitStatusView
              status={gitStatus}
              selectedFilePath={selectedDiffFilePath}
              onSelectFile={(path) => setSelectedDiffFilePath(path)}
              onRefresh={() => fetchGitData(session.id, selectedDiffFilePath)}
              isLoading={isLoadingGit}
              error={gitError}
            />

            <div className="flex-1 overflow-hidden min-h-[300px]">
              <DiffViewer
                diffResult={gitDiff}
                worktreePath={session.worktreePath}
                selectedFilePath={selectedDiffFilePath}
                onSelectFile={(path) => setSelectedDiffFilePath(path)}
                isLoading={isLoadingGit}
                error={gitError}
              />
            </div>
          </div>
        )}

        {/* Artifacts Panel (ArtifactGallery) */}
        {activeTab === 'artifacts' && (
          <ArtifactGallery
            sessionId={session.id}
            artifacts={artifacts}
            isLoading={isLoadingArtifacts}
            onRefresh={() => fetchArtifacts(session.id)}
          />
        )}

        {/* Details Panel */}
        {activeTab === 'details' && (
          <div className="h-full rounded-lg border border-[#30363d] bg-[#161b22] p-5 text-xs text-zinc-300 overflow-y-auto">
            <h4 className="text-sm font-semibold text-white mb-4 pb-2 border-b border-[#30363d]">
              Session Entity Details
            </h4>
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <DetailCard
                label="Session ID"
                value={session.id}
                testId="session-id"
              />

              <DetailCard
                label="Server Host"
                value={server ? `${server.name} (${server.host}:${server.sshPort})` : session.serverId}
                mono={false}
                testId="server-host"
              />

              <DetailCard
                label="Project Root"
                value={project ? project.rootPath : session.projectId}
                testId="project-root"
              />

              <DetailCard
                label="Worktree Path"
                value={session.worktreePath}
                displayNode={<span className="text-emerald-400">{session.worktreePath}</span>}
                testId="worktree-path"
              />

              <DetailCard
                label="Branch"
                value={session.branch}
                testId="branch"
              />

              <DetailCard
                label="tmux Target"
                value={session.tmuxSessionName}
                testId="tmux-target"
              />

              <DetailCard
                label="Agent Harness"
                value={agent ? `${agent.name} (${agent.command})` : session.agentId}
                mono={false}
                testId="agent-harness"
              />

              <DetailCard
                label="Created At"
                value={new Date(session.createdAt).toLocaleString()}
                testId="created-at"
              />
            </dl>

            {/* Host System Telemetry */}
            <div className="mt-6 pt-5 border-t border-[#30363d]">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <ServerIcon className="w-4 h-4 text-emerald-400" />
                  <h4 className="text-sm font-semibold text-white">Host System Environment</h4>
                  {hostInfo?.fetchedAt && (
                    <span className="text-[10px] text-zinc-500 font-mono">
                      (Probed {new Date(hostInfo.fetchedAt).toLocaleTimeString()})
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  data-testid="refresh-host-info-button"
                  onClick={() => session?.serverId && fetchHostInfo(session.serverId)}
                  disabled={isLoadingHostInfo}
                  className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#21262d] hover:bg-[#30363d] text-zinc-300 text-[11px] transition-colors cursor-pointer disabled:opacity-50"
                  title="Refresh host telemetry"
                >
                  <RefreshCw className={`w-3 h-3 ${isLoadingHostInfo ? 'animate-spin text-emerald-400' : ''}`} />
                  <span>Refresh</span>
                </button>
              </div>

              {isLoadingHostInfo && !hostInfo ? (
                <div className="p-6 bg-[#12161c] border border-[#21262d] rounded-lg flex items-center justify-center gap-2 text-zinc-400 text-xs">
                  <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
                  <span>Querying host system telemetry...</span>
                </div>
              ) : hostInfo ? (
                <dl className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <DetailCard
                    label="Operating System"
                    value={hostInfo.osName || 'Linux'}
                    displayNode={
                      <div className="flex items-center gap-1.5">
                        <OsIcon osName={hostInfo.osName} className="w-4 h-4 shrink-0" />
                        <span>{hostInfo.osName || 'Linux'}</span>
                      </div>
                    }
                    mono={false}
                    testId="host-os"
                  />
                  <DetailCard
                    label="Kernel & Architecture"
                    value={hostInfo.kernel || 'Linux'}
                    testId="host-kernel"
                  />
                  <DetailCard
                    label="CPU Model"
                    value={hostInfo.cpuModel || 'Unavailable'}
                    mono={false}
                    testId="host-cpu"
                  />
                  <DetailCard
                    label="Memory (RAM)"
                    value={hostInfo.totalMemory || 'Unavailable'}
                    testId="host-memory"
                  />
                  <DetailCard
                    label="Host Uptime"
                    value={hostInfo.uptime || 'Unavailable'}
                    testId="host-uptime"
                  />
                  <DetailCard
                    label="Default Shell"
                    value={hostInfo.shell || 'bash'}
                    testId="host-shell"
                  />
                </dl>
              ) : (
                <div className="p-4 bg-[#12161c] border border-[#21262d] rounded-lg flex items-center justify-between text-zinc-400 text-xs">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-zinc-500 shrink-0" />
                    <span>Host system telemetry unavailable (host may be offline).</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => session?.serverId && fetchHostInfo(session.serverId)}
                    className="px-2.5 py-1 bg-[#21262d] hover:bg-[#30363d] text-zinc-200 rounded text-[11px] transition-colors cursor-pointer"
                  >
                    Retry
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Floating Toast Notification */}
      {toast && (
        <ToastNotification
          id={toast.id}
          title={toast.title}
          message={toast.message}
          type={toast.type}
          actions={toast.actions}
          onClose={() => setToast(null)}
        />
      )}

      {/* Quick Preview Modal for Detected Output */}
      {previewingArtifact && (
        <ArtifactPreviewModal
          artifact={previewingArtifact}
          sessionId={session.id}
          onClose={() => setPreviewingArtifact(null)}
          onDelete={async (id) => {
            if (window.spawneaApi?.deleteArtifact) {
              await window.spawneaApi.deleteArtifact(session.id, id);
              fetchArtifacts(session.id);
            }
          }}
        />
      )}
    </div>
  );
}
