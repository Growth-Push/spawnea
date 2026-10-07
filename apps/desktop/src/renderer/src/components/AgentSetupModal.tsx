import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { OperationalCatalog } from '@spawnea/domain';
import { getAgentSkillPrompt } from '@spawnea/domain';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Folder,
  Layers,
  Loader2,
  Server as ServerIcon,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react';

export interface AgentSetupModalProps {
  isOpen: boolean;
  uiZoom?: number;
  catalog?: OperationalCatalog | null;
  profile?: string | null;
  onClose: () => void;
}

export function AgentSetupModal({
  isOpen,
  uiZoom = 1,
  catalog,
  profile: propProfile,
  onClose,
}: AgentSetupModalProps): React.JSX.Element | null {
  const [copyPromptStatus, setCopyPromptStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [activeShellTab, setActiveShellTab] = useState<'bash' | 'zsh'>('zsh');
  const [copyCompletionStatus, setCopyCompletionStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [cliPathStatus, setCliPathStatus] = useState<{
    installed: boolean;
    targetPath: string;
    symlinkPath: string;
    isValid: boolean;
    isInPath?: boolean;
    pathInstruction?: string;
    error?: string;
  } | null>(null);
  const [isInstallingCli, setIsInstallingCli] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [activeProfile, setActiveProfile] = useState<string | null>(propProfile ?? null);

  useEffect(() => {
    if (propProfile !== undefined) {
      setActiveProfile(propProfile);
      return;
    }
    if (!isOpen) return;

    let active = true;
    if (window.spawneaApi?.getActiveProfile) {
      window.spawneaApi.getActiveProfile()
        .then((p) => {
          if (active) setActiveProfile(p);
        })
        .catch(() => {});
    }

    return () => {
      active = false;
    };
  }, [isOpen, propProfile]);

  const catalogContext = useMemo(() => {
    const profileValue = activeProfile || undefined;
    if (!catalog) return profileValue ? { profile: profileValue } : undefined;
    const activeHosts = Object.entries(catalog.hosts ?? {}).filter(([, host]) => host.enabled !== false);
    const projects = activeHosts.flatMap(([hostId, host]) =>
      Object.values(host.projects ?? {})
        .filter((p) => p.enabled !== false)
        .map((p) => ({
          id: `${hostId}:${p.id}`,
          name: p.name,
          hostId,
          rootPath: p.path,
          baseBranch: p.base_branch,
        }))
    );
    const harnesses = activeHosts.flatMap(([hostId, host]) =>
      Object.values(host.harnesses ?? {})
        .filter((h) => h.enabled !== false)
        .map((h) => ({
          id: `${hostId}:${h.id}`,
          name: `${h.name} (${host.name})`,
          kind: h.id === 'shell' || h.command === 'bash' || h.command === 'sh' ? 'shell' : h.id,
          command: h.command,
        }))
    );
    const hosts = Object.values(catalog.hosts ?? {})
      .filter((h) => h.enabled !== false)
      .map((h) => ({
        id: h.id,
        name: h.name,
        enabled: h.enabled,
      }));
    return { profile: profileValue, projects, harnesses, hosts };
  }, [catalog, activeProfile]);

  const skillPromptText = useMemo(() => {
    return getAgentSkillPrompt(catalogContext);
  }, [catalogContext]);

  const modalRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const promptResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completionResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (promptResetTimer.current) clearTimeout(promptResetTimer.current);
    if (completionResetTimer.current) clearTimeout(completionResetTimer.current);
  }, []);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Focus the close button only once when the modal is opened
  useEffect(() => {
    if (!isOpen) return;

    const focusTimer = setTimeout(() => {
      closeButtonRef.current?.focus();
    }, 50);

    return () => clearTimeout(focusTimer);
  }, [isOpen]);

  // Handle Escape key without re-triggering focus resets on parent re-renders
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
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
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    let active = true;
    if (window.spawneaApi?.getCliPathStatus) {
      window.spawneaApi.getCliPathStatus()
        .then((res) => {
          if (active) setCliPathStatus(res);
        })
        .catch((err) => {
          if (active) setInstallError(err?.message || String(err));
        });
    }

    return () => {
      active = false;
    };
  }, [isOpen]);

  const completionSnippet = useMemo(() => {
    const profileExport = activeProfile ? `export SPAWNEA_PROFILE="${activeProfile}"\n` : '';
    return activeShellTab === 'zsh'
      ? `${profileExport}eval "$(spawnea completion zsh)"`
      : `${profileExport}eval "$(spawnea completion bash)"`;
  }, [activeShellTab, activeProfile]);

  if (!isOpen) return null;

  const handleCopyPrompt = async () => {
    try {
      if (window.spawneaApi?.writeClipboardText) {
        await window.spawneaApi.writeClipboardText(skillPromptText);
      } else {
        await navigator.clipboard.writeText(skillPromptText);
      }
      setCopyPromptStatus('copied');
      if (promptResetTimer.current) clearTimeout(promptResetTimer.current);
      promptResetTimer.current = setTimeout(() => setCopyPromptStatus('idle'), 2000);
    } catch {
      setCopyPromptStatus('failed');
      if (promptResetTimer.current) clearTimeout(promptResetTimer.current);
      promptResetTimer.current = setTimeout(() => setCopyPromptStatus('idle'), 2000);
    }
  };

  const handleCopyCompletion = async () => {
    try {
      if (window.spawneaApi?.writeClipboardText) {
        await window.spawneaApi.writeClipboardText(completionSnippet);
      } else {
        await navigator.clipboard.writeText(completionSnippet);
      }
      setCopyCompletionStatus('copied');
      if (completionResetTimer.current) clearTimeout(completionResetTimer.current);
      completionResetTimer.current = setTimeout(() => setCopyCompletionStatus('idle'), 2000);
    } catch {
      setCopyCompletionStatus('failed');
      if (completionResetTimer.current) clearTimeout(completionResetTimer.current);
      completionResetTimer.current = setTimeout(() => setCopyCompletionStatus('idle'), 2000);
    }
  };

  const handleInstallCli = async () => {
    if (!window.spawneaApi?.installCliInPath) return;
    setIsInstallingCli(true);
    setInstallError(null);
    try {
      const res = await window.spawneaApi.installCliInPath();
      setCliPathStatus(res);
    } catch (err: any) {
      setInstallError(err?.message || 'Failed to install CLI in user PATH');
    } finally {
      setIsInstallingCli(false);
    }
  };

  return (
    <div
      ref={modalRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="agent-setup-title"
      data-testid="agent-setup-modal"
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div
        style={{ maxHeight: `${90 / uiZoom}vh` }}
        className="bg-[#161b22] border border-[#30363d] rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150"
      >
        {/* Header */}
        <div className="h-16 px-6 border-b border-[#30363d] flex items-center justify-between bg-gradient-to-r from-[#12161c] via-[#161b22] to-[#1a202c] shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-purple-500/20 to-emerald-500/20 border border-purple-500/30 text-purple-300 flex items-center justify-center shadow-inner">
              <Sparkles className="w-5 h-5 text-purple-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase font-mono tracking-wider font-semibold text-purple-400">
                  Agent Integration & CLI Setup
                </span>
                {activeProfile && (
                  <span
                    data-testid="agent-setup-profile-badge"
                    className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30 font-semibold"
                  >
                    profile: {activeProfile}
                  </span>
                )}
              </div>
              <h3 id="agent-setup-title" className="font-bold text-base text-white tracking-tight">
                Configure Spawnea with your Agent
              </h3>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            data-testid="agent-setup-close-button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-[#21262d] transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto space-y-6">
          {installError && (
            <div className="whitespace-pre-line p-3 rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-300 text-xs flex gap-2.5 items-start">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{installError}</span>
            </div>
          )}

          {/* Hero Instructions Card */}
          <div className="rounded-xl border border-purple-500/20 bg-gradient-to-b from-purple-950/20 to-[#12161c] p-5 shadow-lg relative overflow-hidden">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-3">
              <div>
                <span className="text-[10px] font-mono uppercase font-bold tracking-wider text-purple-400">
                  Spawnea Orchestration Instructions
                </span>
                <h4 className="text-sm font-semibold text-white">
                  Copy and send this to your agent
                </h4>
                <p className="text-xs text-zinc-400 mt-1 max-w-xl">
                  Equips ChatGPT, Claude Code, Codex, Hermes, or AGY with Spawnea CLI commands, operating rules, and your live project catalog.
                </p>
              </div>
              <button
                type="button"
                data-testid="copy-prompt-instruction-button"
                onClick={handleCopyPrompt}
                className="flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold shadow-md hover:shadow-purple-500/25 transition-all shrink-0 cursor-pointer"
              >
                {copyPromptStatus === 'copied' ? (
                  <>
                    <Check className="w-4 h-4 text-emerald-300" />
                    <span>Copied!</span>
                  </>
                ) : copyPromptStatus === 'failed' ? (
                  <span>Copy failed. Try again.</span>
                ) : (
                  <>
                    <Copy className="w-4 h-4" />
                    <span>Copy Prompt</span>
                  </>
                )}
              </button>
            </div>

            <div className="relative mt-2">
              <pre className="max-h-48 overflow-y-auto p-3.5 rounded-lg border border-[#30363d] bg-[#0d1117] text-[11px] font-mono text-zinc-300 whitespace-pre-wrap select-all">
                {skillPromptText}
              </pre>
            </div>
          </div>

          {/* CLI in PATH & Shell Completion Row */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Install in PATH card */}
            <div className="rounded-xl border border-[#30363d] bg-[#12161c] p-4 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-emerald-400" />
                    <span className="text-xs font-semibold text-white">Spawnea CLI in PATH</span>
                  </div>
                  {cliPathStatus?.installed && cliPathStatus?.isValid ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-950 text-emerald-300 border border-emerald-800/60">
                      <CheckCircle2 className="w-3 h-3" />
                      Installed
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-zinc-800 text-zinc-400 border border-zinc-700">
                      Not in PATH
                    </span>
                  )}
                </div>
                <p className="text-xs text-zinc-400 leading-relaxed mb-3">
                  Symlinks the Spawnea CLI into <code className="text-emerald-300">~/.local/bin/spawnea</code> so you and your terminal agents can execute <code className="text-emerald-300">spawnea</code> from anywhere.
                </p>
                {cliPathStatus?.symlinkPath && (
                  <div className="text-[11px] font-mono text-zinc-500 mb-3 space-y-0.5 truncate" title={cliPathStatus.symlinkPath}>
                    <div>Link: {cliPathStatus.symlinkPath}</div>
                    {cliPathStatus.targetPath && (
                      <div className="text-zinc-600 truncate" title={cliPathStatus.targetPath}>
                        Target: {cliPathStatus.targetPath}
                      </div>
                    )}
                  </div>
                )}
                {cliPathStatus?.isInPath === false && (
                  <div
                    data-testid="cli-not-in-path-warning"
                    className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex flex-col gap-1 mb-3"
                  >
                    <div className="font-semibold flex items-center gap-1.5">
                      <span>Notice:</span> ~/.local/bin is not in your PATH
                    </div>
                    <div className="text-amber-200/90 font-mono text-[11px] bg-black/30 px-2 py-1 rounded">
                      export PATH="$HOME/.local/bin:$PATH"
                    </div>
                    {cliPathStatus?.pathInstruction && (
                      <div className="text-zinc-300 text-[11px]">
                        {cliPathStatus.pathInstruction}
                      </div>
                    )}
                    <div className="text-zinc-400 text-[11px]">
                      Add this to your <code className="text-zinc-300">~/.zshrc</code> or <code className="text-zinc-300">~/.bashrc</code> to use <code className="text-zinc-300">spawnea</code> from anywhere.
                    </div>
                  </div>
                )}
              </div>

              <button
                type="button"
                data-testid="install-cli-path-button"
                disabled={isInstallingCli || (cliPathStatus?.installed && cliPathStatus?.isValid)}
                onClick={handleInstallCli}
                className="flex items-center justify-center gap-2 w-full py-2 px-3 rounded-lg bg-[#21262d] hover:bg-[#30363d] text-zinc-200 hover:text-white text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isInstallingCli ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" />
                    <span>Installing…</span>
                  </>
                ) : cliPathStatus?.installed && cliPathStatus?.isValid ? (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Installed in ~/.local/bin/spawnea</span>
                  </>
                ) : (
                  <>
                    <Download className="w-3.5 h-3.5" />
                    <span>Install 'spawnea' to PATH</span>
                  </>
                )}
              </button>
            </div>

            {/* Shell Completion card */}
            <div className="rounded-xl border border-[#30363d] bg-[#12161c] p-4 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-cyan-400" />
                    <span className="text-xs font-semibold text-white">Shell Auto-Completion</span>
                  </div>
                  <div className="flex items-center bg-[#0d1117] p-0.5 rounded border border-[#30363d] text-[10px]">
                    <button
                      type="button"
                      data-testid="shell-tab-zsh"
                      onClick={() => setActiveShellTab('zsh')}
                      className={`px-2 py-0.5 rounded font-mono transition-colors ${
                        activeShellTab === 'zsh'
                          ? 'bg-[#21262d] text-cyan-300 font-bold'
                          : 'text-zinc-500 hover:text-zinc-300'
                      }`}
                    >
                      Zsh
                    </button>
                    <button
                      type="button"
                      data-testid="shell-tab-bash"
                      onClick={() => setActiveShellTab('bash')}
                      className={`px-2 py-0.5 rounded font-mono transition-colors ${
                        activeShellTab === 'bash'
                          ? 'bg-[#21262d] text-cyan-300 font-bold'
                          : 'text-zinc-500 hover:text-zinc-300'
                      }`}
                    >
                      Bash
                    </button>
                  </div>
                </div>
                <p className="text-xs text-zinc-400 leading-relaxed mb-3">
                  Enable tab autocompletion by adding this snippet to your shell profile (<code className="text-cyan-300">{activeShellTab === 'zsh' ? '~/.zshrc' : '~/.bashrc'}</code>).
                </p>
                <div
                  data-testid="shell-completion-snippet"
                  className="p-2.5 rounded-lg border border-[#30363d] bg-[#0d1117] font-mono text-[11px] text-zinc-300 mb-3 overflow-x-auto select-all"
                >
                  {completionSnippet}
                </div>
              </div>

              <button
                type="button"
                data-testid="copy-completion-command-button"
                onClick={handleCopyCompletion}
                className="flex items-center justify-center gap-2 w-full py-2 px-3 rounded-lg bg-[#21262d] hover:bg-[#30363d] text-zinc-200 hover:text-white text-xs font-medium transition-colors"
              >
                {copyCompletionStatus === 'copied' ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Copied {activeShellTab.toUpperCase()} Snippet!</span>
                  </>
                ) : copyCompletionStatus === 'failed' ? (
                  <span>Copy failed. Try again.</span>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copy {activeShellTab.toUpperCase()} completion snippet</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Real-time Environment Catalog Summary */}
          <div className="rounded-xl border border-[#30363d] bg-[#12161c] p-5">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-xs font-semibold text-white flex items-center gap-2">
                <Layers className="w-4 h-4 text-emerald-400" />
                <span>Real-Time Environment Catalog</span>
              </h4>
              {activeProfile && (
                <div className="text-[11px] font-mono text-zinc-400 flex items-center gap-1.5" data-testid="catalog-profile-indicator">
                  <span className="text-zinc-500">Profile:</span>
                  <code className="text-purple-300 bg-purple-950/40 border border-purple-800/40 px-1.5 py-0.5 rounded">
                    {activeProfile}
                  </code>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Projects */}
              <div className="rounded-lg border border-[#30363d] bg-[#0d1117] p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-300 mb-2">
                  <Folder className="w-3.5 h-3.5 text-amber-400" />
                  <span>Projects ({catalogContext?.projects?.length ?? 0})</span>
                </div>
                <div className="max-h-32 overflow-y-auto space-y-1 text-[11px]">
                  {(!catalogContext?.projects || catalogContext.projects.length === 0) ? (
                    <div className="text-zinc-500 italic">No configured projects</div>
                  ) : (
                    catalogContext.projects.map((p) => (
                      <div key={p.id} className="truncate text-zinc-400" title={`${p.id} (${p.rootPath})`}>
                        <code className="text-zinc-200">{p.id}</code>: {p.name || p.id}
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Harnesses */}
              <div className="rounded-lg border border-[#30363d] bg-[#0d1117] p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-300 mb-2">
                  <Terminal className="w-3.5 h-3.5 text-purple-400" />
                  <span>Harnesses ({catalogContext?.harnesses?.length ?? 0})</span>
                </div>
                <div className="max-h-32 overflow-y-auto space-y-1 text-[11px]">
                  {(!catalogContext?.harnesses || catalogContext.harnesses.length === 0) ? (
                    <div className="text-zinc-500 italic">No available harnesses</div>
                  ) : (
                    catalogContext.harnesses.map((h) => (
                      <div key={h.id} className="truncate text-zinc-400" title={`${h.id} (${h.command})`}>
                        <code className="text-zinc-200">{h.id}</code> ({h.kind})
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Hosts */}
              <div className="rounded-lg border border-[#30363d] bg-[#0d1117] p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-300 mb-2">
                  <ServerIcon className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Hosts ({catalogContext?.hosts?.length ?? 0})</span>
                </div>
                <div className="max-h-32 overflow-y-auto space-y-1 text-[11px]">
                  {(!catalogContext?.hosts || catalogContext.hosts.length === 0) ? (
                    <div className="text-zinc-500 italic">No configured hosts</div>
                  ) : (
                    catalogContext.hosts.map((h) => (
                      <div key={h.id} className="truncate text-zinc-400" title={`${h.id} (${h.name})`}>
                        <code className="text-zinc-200">{h.id}</code>: {h.name}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-[#30363d] flex justify-end items-center bg-[#12161c] shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-zinc-300 hover:text-white bg-[#21262d] hover:bg-[#30363d] rounded-xl transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
