import React, { useState, useEffect, useCallback } from 'react';
import type {
  Server,
  Project,
  Agent,
  DiscoveredTmuxSession,
  AdoptSessionInput,
} from '@spawnea/domain';
import {
  X,
  Bot,
  Server as ServerIcon,
  Layers,
  Terminal,
  AlertCircle,
  Loader2,
  RefreshCw,

  Radio,
  CheckCircle2,

} from 'lucide-react';

interface AdoptSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (input: AdoptSessionInput) => Promise<void>;
  servers: Server[];
  projects: Project[];
  agents: Agent[];
  hostHealthMap?: Record<string, import('@spawnea/domain').HostHealthResult>;
}

export function AdoptSessionModal({
  isOpen,
  onClose,
  onSubmit,
  servers,
  projects,
  agents,
  hostHealthMap = {},
}: AdoptSessionModalProps): React.JSX.Element | null {
  const [serverId, setServerId] = useState<string>('');
  const [discoveredSessions, setDiscoveredSessions] = useState<DiscoveredTmuxSession[]>([]);
  const [isLoadingDiscovery, setIsLoadingDiscovery] = useState<boolean>(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

  // Selected session to adopt
  const [selectedTmuxSession, setSelectedTmuxSession] = useState<DiscoveredTmuxSession | null>(null);
  const [sessionName, setSessionName] = useState<string>('');
  const [projectId, setProjectId] = useState<string>('');
  const [agentId, setAgentId] = useState<string>('none');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDiscoveredSessions = useCallback(async (targetServerId: string) => {
    if (!targetServerId) return;
    setIsLoadingDiscovery(true);
    setDiscoveryError(null);
    setSelectedTmuxSession(null);

    try {
      if (window.spawneaApi?.discoverExternalSessions) {
        const list = await window.spawneaApi.discoverExternalSessions(targetServerId);
        setDiscoveredSessions(list);
      } else {
        // Standalone / mock fallback
        setDiscoveredSessions([
          {
            sessionName: 'external-cli-agent',
            windowsCount: 1,
            createdAt: new Date(),
            panePid: 4200,
            currentCommand: 'claude',
            currentPath: '/workspace/code/my-app',
          },
          {
            sessionName: 'manual-dev-terminal',
            windowsCount: 2,
            createdAt: new Date(Date.now() - 3600000),
            panePid: 4205,
            currentCommand: 'bash',
            currentPath: '/workspace/spawnea',
          },
        ]);
      }
    } catch (err: any) {
      setDiscoveryError(err?.message || 'Failed to query host for tmux sessions');
      setDiscoveredSessions([]);
    } finally {
      setIsLoadingDiscovery(false);
    }
  }, []);

  // Initialize server when modal opens
  useEffect(() => {
    if (isOpen) {
      const initialServerId =
        servers.length > 0 ? (serverId && servers.some((s) => s.id === serverId) ? serverId : servers[0].id) : '';
      if (initialServerId && initialServerId !== serverId) {
        setServerId(initialServerId);
      }
      setError(null);
      if (initialServerId) {
        fetchDiscoveredSessions(initialServerId);
      }
    }
  }, [isOpen, servers]);

  // Handle server change
  const handleServerChange = (newServerId: string) => {
    setServerId(newServerId);
    fetchDiscoveredSessions(newServerId);
  };

  const availableProjects = projects.filter((p) => !serverId || p.serverId === serverId);
  const availableAgents = agents.filter(
    (a) => !serverId || !a.id.includes(':') || a.id.startsWith(`${serverId}:`)
  );

  // Auto-configure form when a tmux session is clicked
  const handleSelectTmuxSession = (discovered: DiscoveredTmuxSession) => {
    setSelectedTmuxSession(discovered);
    setSessionName(discovered.sessionName);

    // Auto-match project path
    if (discovered.currentPath) {
      const matched = availableProjects.find((p) => p.rootPath === discovered.currentPath);
      if (matched) {
        setProjectId(matched.id);
      } else {
        setProjectId(''); // Ad-hoc / Use session directory
      }
    } else {
      setProjectId('');
    }

    // Auto-match agent harness by command
    if (discovered.currentCommand) {
      const cmd = discovered.currentCommand.toLowerCase();
      const matchedAgent = availableAgents.find(
        (a) =>
          a.command.toLowerCase() === cmd ||
          a.harness.toLowerCase() === cmd ||
          a.name.toLowerCase().includes(cmd)
      );
      if (matchedAgent) {
        setAgentId(matchedAgent.id);
      } else {
        setAgentId('none');
      }
    } else {
      setAgentId('none');
    }
  };

  // Escape key handler
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

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting || !selectedTmuxSession) return;

    if (!sessionName.trim()) {
      setError('Please provide a name for the adopted session');
      return;
    }

    try {
      setIsSubmitting(true);
      setError(null);

      await onSubmit({
        serverId,
        tmuxSessionName: selectedTmuxSession.sessionName,
        sessionName: sessionName.trim(),
        projectId: projectId || undefined,
        projectPath: selectedTmuxSession.currentPath,
        agentId: agentId === 'none' ? undefined : agentId,
        harnessCommand: selectedTmuxSession.currentCommand,
        task: sessionName.trim(),
      });

      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to adopt session. Please check details.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedServer = servers.find((s) => s.id === serverId);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="adopt-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) {
          onClose();
        }
      }}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150"
    >
      <div className="bg-[#161b22] border border-[#30363d] rounded-xl shadow-2xl w-full max-w-xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="h-14 px-5 border-b border-[#30363d] flex items-center justify-between bg-[#12161c] shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-cyan-500/20 text-cyan-400 flex items-center justify-center">
              <Radio className="w-3.5 h-3.5" />
            </div>
            <div>
              <h3 id="adopt-modal-title" className="font-semibold text-sm text-white">
                Discover & Adopt External tmux Sessions
              </h3>
            </div>
          </div>
          <button
            type="button"
            data-testid="adopt-modal-close-button"
            onClick={onClose}
            className="p-1 hover:bg-[#21262d] rounded-md text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          {error && (
            <div
              data-testid="adopt-session-error-banner"
              className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg flex items-start gap-2.5 text-rose-400 text-xs leading-relaxed"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="flex-1">
                <span className="font-semibold block mb-0.5">Adoption Failed</span>
                <span className="break-all">{error}</span>
              </div>
            </div>
          )}

          {/* Host Selector */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-semibold text-zinc-300 flex items-center gap-1">
                <ServerIcon className="w-3.5 h-3.5 text-zinc-400" />
                <span>Target Host</span>
              </label>
              <button
                type="button"
                data-testid="refresh-discovery-button"
                onClick={() => fetchDiscoveredSessions(serverId)}
                disabled={isLoadingDiscovery || !serverId}
                className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-cyan-400 transition-colors cursor-pointer disabled:opacity-50"
                title="Rescan host for external tmux sessions"
              >
                <RefreshCw className={`w-3 h-3 ${isLoadingDiscovery ? 'animate-spin text-cyan-400' : ''}`} />
                <span>Rescan Host</span>
              </button>
            </div>
            <select
              data-testid="adopt-select-server"
              value={serverId}
              onChange={(e) => handleServerChange(e.target.value)}
              disabled={isSubmitting || isLoadingDiscovery}
              className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs text-zinc-200 focus:outline-none focus:border-cyan-500 cursor-pointer disabled:opacity-50"
            >
              {servers.map((s) => {
                const health = hostHealthMap[s.id];
                const latency = health?.latencyMs !== undefined && health.status !== 'unreachable' ? ` • ${health.latencyMs}ms` : '';
                const statusLabel = health?.status === 'unreachable' ? ' (unreachable)' : '';
                return (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.host}){latency}{statusLabel}
                  </option>
                );
              })}
            </select>
          </div>

          {/* Discovered Sessions List */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-semibold text-zinc-300">
                Discovered Sessions ({discoveredSessions.length})
              </label>
              {selectedServer && (
                <span className="text-[10px] text-zinc-500 font-mono">Host: {selectedServer.host}</span>
              )}
            </div>

            {isLoadingDiscovery ? (
              <div className="p-8 bg-[#0d1117] border border-[#30363d] rounded-lg flex flex-col items-center justify-center gap-2 text-zinc-400 text-xs">
                <Loader2 className="w-5 h-5 animate-spin text-cyan-400" />
                <span>Scanning {selectedServer?.name || 'host'} for unmanaged tmux sessions...</span>
              </div>
            ) : discoveryError ? (
              <div className="p-4 bg-rose-950/20 border border-rose-500/30 rounded-lg text-xs text-rose-400">
                <span>Failed to scan host: {discoveryError}</span>
              </div>
            ) : discoveredSessions.length === 0 ? (
              <div className="p-8 bg-[#0d1117] border border-[#30363d] rounded-lg text-center text-zinc-500 text-xs space-y-1">
                <Terminal className="w-6 h-6 mx-auto text-zinc-600 mb-1.5" />
                <p className="font-medium text-zinc-400">No unmanaged tmux sessions found</p>
                <p className="text-[11px] text-zinc-500">
                  All active tmux sessions on this host are already managed, or no external sessions are running.
                </p>
              </div>
            ) : (
              <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                {discoveredSessions.map((disc) => {
                  const isSelected = selectedTmuxSession?.sessionName === disc.sessionName;
                  return (
                    <div
                      key={disc.sessionName}
                      data-testid={`discovered-session-${disc.sessionName}`}
                      onClick={() => handleSelectTmuxSession(disc)}
                      className={`p-2.5 rounded-lg border transition-all cursor-pointer flex items-center justify-between gap-2 ${
                        isSelected
                          ? 'bg-[#1f242c] border-cyan-500 text-white ring-1 ring-cyan-500/30'
                          : 'bg-[#0d1117] border-[#21262d] hover:bg-[#161b22] text-zinc-300'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-xs text-zinc-100 font-mono">
                            {disc.sessionName}
                          </span>
                          {disc.currentCommand && (
                            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[#21262d] text-cyan-300 border border-[#30363d]">
                              {disc.currentCommand}
                            </span>
                          )}
                          <span className="text-[10px] text-zinc-500 font-mono">
                            {disc.windowsCount} win
                          </span>
                        </div>
                        <div className="text-[11px] text-zinc-400 font-mono truncate mt-0.5" title={disc.currentPath}>
                          {disc.currentPath || 'Unknown path'}
                        </div>
                      </div>

                      {isSelected ? (
                        <CheckCircle2 className="w-4 h-4 text-cyan-400 shrink-0" />
                      ) : (
                        <div className="w-4 h-4 rounded-full border border-zinc-600 shrink-0" />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Adoption Configuration Form (when a session is selected) */}
          {selectedTmuxSession && (
            <div className="space-y-3 pt-2 border-t border-[#30363d]">
              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">
                  Session Display Name / Task <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  data-testid="adopt-input-name"
                  value={sessionName}
                  onChange={(e) => setSessionName(e.target.value)}
                  disabled={isSubmitting}
                  placeholder="e.g. My External Session"
                  className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-cyan-500 disabled:opacity-50"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                {/* Project Binding */}
                <div>
                  <label className="block text-xs font-semibold text-zinc-300 mb-1 flex items-center gap-1">
                    <Layers className="w-3 h-3 text-zinc-400" />
                    <span>Project Binding</span>
                  </label>
                  <select
                    data-testid="adopt-select-project"
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                    disabled={isSubmitting}
                    className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs text-zinc-200 focus:outline-none focus:border-cyan-500 cursor-pointer disabled:opacity-50"
                  >
                    <option value="">
                      Use session directory ({selectedTmuxSession.currentPath ? selectedTmuxSession.currentPath.split('/').pop() : 'Ad-hoc'})
                    </option>
                    {availableProjects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.rootPath})
                      </option>
                    ))}
                  </select>
                </div>

                {/* Harness Binding */}
                <div>
                  <label className="block text-xs font-semibold text-zinc-300 mb-1 flex items-center gap-1">
                    <Bot className="w-3 h-3 text-zinc-400" />
                    <span>Harness / Tool</span>
                  </label>
                  <select
                    data-testid="adopt-select-harness"
                    value={agentId}
                    onChange={(e) => setAgentId(e.target.value)}
                    disabled={isSubmitting}
                    className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs text-zinc-200 focus:outline-none focus:border-cyan-500 cursor-pointer disabled:opacity-50"
                  >
                    <option value="none">None / Terminal Only</option>
                    {availableAgents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.command})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Adoption Summary Alert */}
              <div className="p-3 bg-[#12161c] border border-[#21262d] rounded-lg text-[11px] text-zinc-400 space-y-1 font-mono">
                <div className="flex items-center justify-between text-zinc-300 font-semibold">
                  <span>Adoption Mode</span>
                  <span className="text-cyan-400 font-normal">Non-invasive</span>
                </div>
                <p className="text-[10px] text-zinc-500 leading-relaxed font-sans">
                  The session will be registered in Spawnea and attached via interactive PTY. Your catalog configuration files will remain untouched.
                </p>
              </div>

              {/* Form Actions */}
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
                  type="button"
                  data-testid="submit-adopt-session"
                  onClick={handleSubmit}
                  disabled={isSubmitting || !selectedTmuxSession}
                  className="flex items-center gap-1.5 px-4 py-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white rounded-md text-xs font-semibold transition-colors shadow-sm cursor-pointer"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Adopting Session...</span>
                    </>
                  ) : (
                    <>
                      <Radio className="w-3.5 h-3.5" />
                      <span>Adopt & Open Session</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
