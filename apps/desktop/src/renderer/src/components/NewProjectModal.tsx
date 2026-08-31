import React, { useEffect, useMemo, useState } from 'react';
import type { AddProjectToCatalogInput, GitBranchDiscoveryResult, Server } from '@spawnea/domain';
import { AlertCircle, CheckCircle2, FolderOpen, FolderPlus, GitBranch, Loader2, Settings, X } from 'lucide-react';

interface NewProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (input: AddProjectToCatalogInput) => Promise<{ success: boolean; error?: string }>;
  servers: Server[];
  onOpenSettings: () => Promise<{ success: boolean; error?: string }>;
}

export function NewProjectModal({
  isOpen,
  onClose,
  onSubmit,
  servers,
  onOpenSettings,
}: NewProjectModalProps): React.JSX.Element | null {
  const [serverId, setServerId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [discovery, setDiscovery] = useState<GitBranchDiscoveryResult | null>(null);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isChoosingPath, setIsChoosingPath] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isOpeningSettings, setIsOpeningSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedServer = useMemo(() => servers.find((server) => server.id === serverId), [servers, serverId]);

  useEffect(() => {
    if (!isOpen) return;
    setServerId((current) => current || servers[0]?.id || '');
  }, [isOpen, servers]);

  useEffect(() => {
    setDiscovery(null);
  }, [serverId, path]);

  if (!isOpen) return null;

  const handleDiscoverBranches = async () => {
    if (!serverId || !path.trim()) {
      setError('Select a host and enter a project path before discovering branches.');
      return;
    }
    if (!window.spawneaApi?.discoverProjectBranches) {
      setError('Branch discovery is unavailable in this app runtime.');
      return;
    }

    setIsDiscovering(true);
    setError(null);
    try {
      const result = await window.spawneaApi.discoverProjectBranches(serverId, path.trim(), baseBranch.trim() || undefined);
      setDiscovery(result);
      if (result.currentBranch && !baseBranch.trim()) setBaseBranch(result.currentBranch);
      if (result.error && !result.isGitRepo) setError(result.error);
    } catch (err: any) {
      setError(err?.message || 'Could not discover Git branches.');
    } finally {
      setIsDiscovering(false);
    }
  };

  const handleChoosePath = async () => {
    if (!serverId || !selectedServer) {
      setError('Select a host before choosing a project folder.');
      return;
    }
    if (!window.spawneaApi?.chooseProjectPath) {
      setError('Folder selection is unavailable in this app runtime.');
      return;
    }

    setIsChoosingPath(true);
    setError(null);
    try {
      const result = await window.spawneaApi.chooseProjectPath(serverId, path.trim() || undefined);
      if (result.path) setPath(result.path);
      if (result.error) setError(result.error);
    } catch (err: any) {
      setError(err?.message || 'Could not choose a project folder.');
    } finally {
      setIsChoosingPath(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isSubmitting) return;

    const normalizedId = projectId.trim().toLowerCase();
    if (!serverId || !selectedServer) return setError('Select a host.');
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(normalizedId)) {
      return setError('Project ID must start with a lowercase letter or digit and use only lowercase letters, digits, hyphens, or underscores.');
    }
    if (!name.trim()) return setError('Enter a project name.');
    if (!path.trim()) return setError('Enter a project path.');

    setIsSubmitting(true);
    setError(null);
    try {
      const result = await onSubmit({
        serverId,
        projectId: normalizedId,
        name: name.trim(),
        path: path.trim(),
        gitUrl: gitUrl.trim() || undefined,
        baseBranch: baseBranch.trim() || undefined,
      });
      if (!result.success) {
        setError(result.error || 'Could not add project to the catalog.');
        return;
      }
      setProjectId('');
      setName('');
      setPath('');
      setGitUrl('');
      setBaseBranch('');
      setDiscovery(null);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Could not add project to the catalog.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenSettings = async () => {
    setIsOpeningSettings(true);
    setError(null);
    try {
      const result = await onOpenSettings();
      if (!result.success) setError(result.error || 'Could not open the configuration file.');
    } catch (err: any) {
      setError(err?.message || 'Could not open the configuration file.');
    } finally {
      setIsOpeningSettings(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="new-project-title" className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-[#161b22] border border-[#30363d] rounded-xl shadow-2xl w-full max-w-lg overflow-hidden">
        <div className="h-14 px-5 border-b border-[#30363d] flex items-center justify-between bg-[#12161c]">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md bg-emerald-500/20 text-emerald-400 flex items-center justify-center"><FolderPlus className="w-4 h-4" /></div>
            <div><h3 id="new-project-title" className="font-semibold text-sm text-white">Add Project</h3><p className="text-[10px] text-zinc-500">Adds a project to the YAML catalog</p></div>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded text-zinc-400 hover:text-white hover:bg-[#21262d]" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {error && <div data-testid="new-project-error" className="p-3 rounded-lg border border-rose-500/30 bg-rose-500/10 text-rose-300 text-xs flex gap-2"><AlertCircle className="w-4 h-4 shrink-0" /><span>{error}</span></div>}

          <label className="block text-xs font-semibold text-zinc-300">Host<select data-testid="new-project-server" value={serverId} onChange={(event) => setServerId(event.target.value)} disabled={isSubmitting} className="mt-1.5 w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs text-zinc-200"><option value="">Select a host</option>{servers.map((server) => <option key={server.id} value={server.id}>{server.name} ({server.host})</option>)}</select></label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs font-semibold text-zinc-300">Project ID<input data-testid="new-project-id" value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="my-project" disabled={isSubmitting} className="mt-1.5 w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs text-zinc-200" /></label>
            <label className="block text-xs font-semibold text-zinc-300">Display name<input data-testid="new-project-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="My Project" disabled={isSubmitting} className="mt-1.5 w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs text-zinc-200" /></label>
          </div>

          <div>
            <label className="block text-xs font-semibold text-zinc-300">Project path</label>
            <div className="mt-1.5 flex gap-2">
              <input data-testid="new-project-path" value={path} onChange={(event) => setPath(event.target.value)} placeholder="~/code/my-project" disabled={isSubmitting} className="min-w-0 flex-1 px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs text-zinc-200" />
              <button
                type="button"
                data-testid="new-project-choose-path"
                onClick={handleChoosePath}
                disabled={isSubmitting || isChoosingPath || !selectedServer || (selectedServer.host !== 'localhost' && selectedServer.host !== '127.0.0.1')}
                title={selectedServer && selectedServer.host !== 'localhost' && selectedServer.host !== '127.0.0.1' ? 'Enter remote paths manually' : 'Choose a local folder'}
                className="shrink-0 flex items-center gap-1.5 px-2.5 py-2 text-[11px] text-zinc-300 border border-[#30363d] rounded-lg hover:bg-[#21262d] disabled:opacity-50"
              >
                {isChoosingPath ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderOpen className="w-3.5 h-3.5" />}
                Choose
              </button>
            </div>
            {selectedServer && selectedServer.host !== 'localhost' && selectedServer.host !== '127.0.0.1' && (
              <p className="mt-1 text-[10px] text-zinc-500">Remote paths must be entered manually.</p>
            )}
          </div>
          <label className="block text-xs font-semibold text-zinc-300">Git URL <span className="font-normal text-zinc-500">(optional)</span><input data-testid="new-project-git-url" value={gitUrl} onChange={(event) => setGitUrl(event.target.value)} placeholder="git@github.com:org/repo.git" disabled={isSubmitting} className="mt-1.5 w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs text-zinc-200" /></label>

          <div>
            <label className="block text-xs font-semibold text-zinc-300">Base branch <span className="font-normal text-zinc-500">(optional)</span></label>
            <div className="mt-1.5 flex gap-2"><input data-testid="new-project-base-branch" value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} placeholder="main" disabled={isSubmitting} className="min-w-0 flex-1 px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs text-zinc-200" /><button type="button" data-testid="new-project-discover-branches" onClick={handleDiscoverBranches} disabled={isDiscovering || isSubmitting} className="px-2.5 py-2 text-[11px] text-emerald-300 border border-emerald-500/30 rounded-lg hover:bg-emerald-500/10 disabled:opacity-50">{isDiscovering ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitBranch className="w-3.5 h-3.5" />} Discover</button></div>
            {discovery?.isGitRepo && <div className="mt-2 flex flex-wrap gap-1.5">{discovery.suggestedBranches.map((branch) => <button key={branch} type="button" data-testid={`new-project-branch-${branch}`} onClick={() => setBaseBranch(branch)} className={`px-2 py-1 rounded border text-[10px] font-mono ${baseBranch === branch ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300' : 'border-[#30363d] text-zinc-400 hover:text-zinc-200'}`}>{branch}{branch === discovery.currentBranch ? ' · current' : ''}</button>)}</div>}
          </div>

          <div className="pt-2 border-t border-[#30363d] flex items-center justify-between"><button type="button" data-testid="new-project-settings-button" onClick={handleOpenSettings} disabled={isOpeningSettings} className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200">{isOpeningSettings ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Settings className="w-3.5 h-3.5" />} Open config</button><div className="flex items-center gap-2"><button type="button" onClick={onClose} className="px-3 py-2 text-xs text-zinc-400 hover:text-white">Cancel</button><button type="submit" data-testid="new-project-submit" disabled={isSubmitting} className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold disabled:opacity-50">{isSubmitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}<CheckCircle2 className="w-3.5 h-3.5" /> Add Project</button></div></div>
        </form>
      </div>
    </div>
  );
}
