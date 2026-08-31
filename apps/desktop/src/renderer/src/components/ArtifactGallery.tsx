import React, { useState, useMemo, useRef, useCallback } from 'react';
import type { Artifact, ArtifactDirection } from '@spawnea/domain';
import { ArtifactPreviewModal } from './ArtifactPreviewModal';
import { ArtifactContextMenu } from './ArtifactContextMenu';
import {
  FileCode2,
  FileText,
  Image as ImageIcon,
  FileQuestion,
  Search,
  Upload,
  Clipboard,
  Download,
  ExternalLink,
  Trash2,
  Copy,
  Check,
  Eye,
  EyeOff,
  Ban,
  Filter,
  ArrowUpDown,
  LayoutGrid,
  List,
  Sparkles,
  Plus,
  Loader2,
} from 'lucide-react';

export interface ArtifactGalleryProps {
  sessionId: string;
  artifacts: Artifact[];
  isLoading?: boolean;
  onRefresh?: () => void;
  onUploadFile?: (file: File) => Promise<void>;
  onPasteImage?: () => Promise<void>;
  onDeleteArtifact?: (artifactId: string) => Promise<void>;
}

type FilterDirection = 'all' | 'input' | 'output';
type SortField = 'date_desc' | 'date_asc' | 'size_desc' | 'name_asc';

export function ArtifactGallery({
  sessionId,
  artifacts,
  isLoading = false,
  onRefresh,
  onUploadFile,
  onPasteImage,
  onDeleteArtifact,
}: ArtifactGalleryProps): React.JSX.Element {
  const [filterDir, setFilterDir] = useState<FilterDirection>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<SortField>('date_desc');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Hidden Artifacts & Context Menu State
  const [hiddenArtifactIds, setHiddenArtifactIds] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(`spawnea:hiddenArtifacts:${sessionId}`);
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });
  const [showHidden, setShowHidden] = useState<boolean>(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    artifact: Artifact;
  } | null>(null);

  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<NodeJS.Timeout | null>(null);

  const showToast = useCallback((msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMessage(msg);
    toastTimerRef.current = setTimeout(() => {
      setToastMessage(null);
    }, 3000);
  }, []);

  const toggleHide = (artId: string) => {
    setHiddenArtifactIds((prev) => {
      const next = new Set(prev);
      if (next.has(artId)) {
        next.delete(artId);
        showToast('Artifact unhidden');
      } else {
        next.add(artId);
        showToast('Artifact hidden from gallery');
      }
      try {
        localStorage.setItem(`spawnea:hiddenArtifacts:${sessionId}`, JSON.stringify(Array.from(next)));
      } catch {
        // Ignore localStorage error
      }
      return next;
    });
  };

  const handleBlacklist = async (pattern: string) => {
    if (window.spawneaApi?.addArtifactToBlacklist) {
      try {
        await window.spawneaApi.addArtifactToBlacklist(pattern);
        showToast(`Blacklisted '${pattern}'. Removed matching artifacts.`);
        onRefresh?.();
      } catch (err: any) {
        showToast(`Failed to blacklist: ${err?.message || 'Error'}`);
      }
    }
  };

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Counts
  const inputCount = useMemo(() => artifacts.filter((a) => a.direction === 'input').length, [artifacts]);
  const outputCount = useMemo(() => artifacts.filter((a) => a.direction === 'output').length, [artifacts]);
  const hiddenCount = useMemo(() => artifacts.filter((a) => hiddenArtifactIds.has(a.id)).length, [artifacts, hiddenArtifactIds]);

  // Filter and sort
  const filteredArtifacts = useMemo(() => {
    return artifacts
      .filter((art) => {
        const isHidden = hiddenArtifactIds.has(art.id);
        if (!showHidden && isHidden) return false;
        if (filterDir !== 'all' && art.direction !== filterDir) return false;
        if (searchQuery.trim().length > 0) {
          const q = searchQuery.toLowerCase();
          return (
            art.filename.toLowerCase().includes(q) ||
            art.remotePath.toLowerCase().includes(q) ||
            art.mimeType.toLowerCase().includes(q)
          );
        }
        return true;
      })
      .sort((a, b) => {
        if (sortField === 'date_desc') return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        if (sortField === 'date_asc') return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        if (sortField === 'size_desc') return b.sizeBytes - a.sizeBytes;
        if (sortField === 'name_asc') return a.filename.localeCompare(b.filename);
        return 0;
      });
  }, [artifacts, filterDir, searchQuery, sortField, showHidden, hiddenArtifactIds]);

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setIsUploading(true);
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (onUploadFile) {
          await onUploadFile(f);
        } else if (window.spawneaApi?.uploadArtifactData) {
          const buf = new Uint8Array(await f.arrayBuffer());
          await window.spawneaApi.uploadArtifactData(
            sessionId,
            buf,
            f.name,
            f.type || 'application/octet-stream',
            'input'
          );
        }
      }
      onRefresh?.();
    } catch (err) {
      console.error('Failed to upload file in ArtifactGallery:', err);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleCopyPath = (e: React.MouseEvent, art: Artifact) => {
    e.stopPropagation();
    navigator.clipboard.writeText(art.remotePath);
    setCopiedId(art.id);
    showToast('Copied remote path');
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleSaveAs = async (e: React.MouseEvent, art: Artifact) => {
    e.stopPropagation();
    if (window.spawneaApi?.saveArtifactAs) {
      await window.spawneaApi.saveArtifactAs(sessionId, art.id);
    }
  };

  const handleOpenInOs = async (e: React.MouseEvent, art: Artifact) => {
    e.stopPropagation();
    if (window.spawneaApi?.openArtifactInOs) {
      await window.spawneaApi.openArtifactInOs(sessionId, art.id);
      showToast('Opened in default app');
    }
  };

  const handleDelete = async (e: React.MouseEvent, art: Artifact) => {
    e.stopPropagation();
    if (confirm(`Delete artifact "${art.filename}"?`)) {
      if (onDeleteArtifact) {
        await onDeleteArtifact(art.id);
      } else if (window.spawneaApi?.deleteArtifact) {
        await window.spawneaApi.deleteArtifact(sessionId, art.id);
        onRefresh?.();
      }
      showToast(`Deleted ${art.filename}`);
    }
  };

  const handleCardContextMenu = (e: React.MouseEvent, art: Artifact) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      artifact: art,
    });
  };

  const getFileIcon = (mime: string, filename: string) => {
    if (mime.startsWith('image/')) return <ImageIcon className="w-5 h-5 text-purple-400 shrink-0" />;
    if (mime === 'application/pdf' || filename.endsWith('.pdf')) return <FileText className="w-5 h-5 text-rose-400 shrink-0" />;
    if (filename.endsWith('.md') || mime === 'text/markdown') return <FileText className="w-5 h-5 text-blue-400 shrink-0" />;
    if (filename.endsWith('.json') || mime === 'application/json') return <FileCode2 className="w-5 h-5 text-amber-400 shrink-0" />;
    return <FileCode2 className="w-5 h-5 text-emerald-400 shrink-0" />;
  };

  return (
    <div
      data-testid="artifact-gallery-panel"
      className="h-full flex flex-col rounded-lg border border-[#30363d] bg-[#161b22] overflow-hidden"
    >
      {/* Hidden file input */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileInputChange}
        multiple
        className="hidden"
      />

      {/* Top Toolbar */}
      <div className="px-4 py-3 border-b border-[#30363d] bg-[#12161c] flex flex-wrap items-center justify-between gap-3 shrink-0">
        {/* Filter Chips */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            data-testid="filter-artifacts-all"
            onClick={() => setFilterDir('all')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              filterDir === 'all'
                ? 'bg-[#21262d] text-emerald-400 border border-[#30363d]'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-[#161b22]'
            }`}
          >
            All ({artifacts.length})
          </button>
          <button
            type="button"
            data-testid="filter-artifacts-input"
            onClick={() => setFilterDir('input')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              filterDir === 'input'
                ? 'bg-blue-950 text-blue-300 border border-blue-800/60'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-[#161b22]'
            }`}
          >
            Inputs ({inputCount})
          </button>
          <button
            type="button"
            data-testid="filter-artifacts-output"
            onClick={() => setFilterDir('output')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              filterDir === 'output'
                ? 'bg-emerald-950 text-emerald-300 border border-emerald-800/60'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-[#161b22]'
            }`}
          >
            Outputs ({outputCount})
          </button>

          {hiddenCount > 0 && (
            <button
              type="button"
              data-testid="filter-artifacts-hidden"
              onClick={() => setShowHidden(!showHidden)}
              className={`flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md border transition-colors cursor-pointer ml-2 ${
                showHidden
                  ? 'bg-amber-950/70 text-amber-300 border-amber-600/50'
                  : 'bg-[#161b22] text-zinc-400 border-[#30363d] hover:text-zinc-200'
              }`}
            >
              {showHidden ? <Eye className="w-3 h-3 text-amber-400" /> : <EyeOff className="w-3 h-3 text-amber-400" />}
              <span>{showHidden ? `Showing (${hiddenCount}) Hidden` : `Hidden (${hiddenCount})`}</span>
            </button>
          )}
        </div>

        {/* Right Actions: Search, Sort, View Toggle, Upload */}
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search artifacts..."
              data-testid="search-artifacts-input"
              className="pl-8 pr-3 py-1 text-xs bg-[#0d1117] border border-[#30363d] rounded-md text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-emerald-500 w-44"
            />
          </div>

          <select
            value={sortField}
            onChange={(e) => setSortField(e.target.value as SortField)}
            data-testid="sort-artifacts-select"
            className="px-2 py-1 text-xs bg-[#0d1117] border border-[#30363d] rounded-md text-zinc-300 focus:outline-none focus:border-emerald-500 cursor-pointer"
          >
            <option value="date_desc">Newest First</option>
            <option value="date_asc">Oldest First</option>
            <option value="size_desc">Size (Large to Small)</option>
            <option value="name_asc">Name (A-Z)</option>
          </select>

          <div className="flex items-center bg-[#0d1117] border border-[#30363d] rounded p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              className={`p-1 rounded transition-colors ${viewMode === 'grid' ? 'bg-[#21262d] text-emerald-400' : 'text-zinc-400 hover:text-zinc-200'}`}
              title="Grid View"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={`p-1 rounded transition-colors ${viewMode === 'list' ? 'bg-[#21262d] text-emerald-400' : 'text-zinc-400 hover:text-zinc-200'}`}
              title="List View"
            >
              <List className="w-3.5 h-3.5" />
            </button>
          </div>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            data-testid="upload-artifact-button"
            className="flex items-center gap-1.5 px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-xs font-medium transition-colors cursor-pointer disabled:opacity-50 shadow-sm"
          >
            {isUploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            <span>Upload File</span>
          </button>
        </div>
      </div>

      {/* Main Gallery Area */}
      <div className="flex-1 p-4 overflow-y-auto">
        {isLoading ? (
          <div className="h-full flex items-center justify-center p-12 text-zinc-500 text-xs">
            <Loader2 className="w-6 h-6 animate-spin text-emerald-400 mb-2" />
            <span>Loading artifacts...</span>
          </div>
        ) : filteredArtifacts.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center p-12 text-center text-zinc-500">
            <FileCode2 className="w-12 h-12 text-zinc-600 mb-3" />
            <h4 className="text-sm font-semibold text-zinc-300">
              {artifacts.length === 0 ? 'No Session Artifacts Yet' : 'No Matching Artifacts'}
            </h4>
            <p className="text-xs text-zinc-500 mt-1 max-w-sm">
              {artifacts.length === 0
                ? 'Pasting images from clipboard or dropping files into this session will upload them directly into .spawnea/artifacts/ for the LLM.'
                : 'Try clearing your search query or filter chips.'}
            </p>
            {artifacts.length === 0 && (
              <div className="flex items-center gap-3 mt-4">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-[#21262d] hover:bg-[#30363d] text-zinc-200 rounded text-xs font-medium transition-colors cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Choose File to Upload</span>
                </button>
              </div>
            )}
          </div>
        ) : viewMode === 'grid' ? (
          /* Grid View */
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3.5">
            {filteredArtifacts.map((art) => {
              const isHidden = hiddenArtifactIds.has(art.id);
              return (
                <div
                  key={art.id}
                  data-testid={`artifact-card-${art.id}`}
                  onClick={() => setSelectedArtifact(art)}
                  onContextMenu={(e) => handleCardContextMenu(e, art)}
                  className={`p-3.5 bg-[#12161c] border rounded-xl flex flex-col justify-between gap-3 text-xs transition-all cursor-pointer group shadow-sm hover:shadow-md ${
                    isHidden
                      ? 'border-amber-900/40 opacity-50 hover:opacity-90 hover:border-amber-500/60'
                      : 'border-[#30363d] hover:border-emerald-500/60'
                  }`}
                >
                  <div>
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="p-2 bg-[#161b22] border border-[#30363d] rounded-lg">
                        {getFileIcon(art.mimeType, art.filename)}
                      </div>
                      <div className="flex items-center gap-1">
                        {isHidden && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-amber-950 text-amber-300 border border-amber-800/60">
                            Hidden
                          </span>
                        )}
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                            art.direction === 'input'
                              ? 'bg-blue-950 text-blue-300 border border-blue-800/60'
                              : 'bg-emerald-950 text-emerald-300 border border-emerald-800/60'
                          }`}
                        >
                          {art.direction}
                        </span>
                      </div>
                    </div>

                    <p className="font-medium text-zinc-100 truncate text-xs group-hover:text-emerald-300 transition-colors" title={art.filename}>
                      {art.filename}
                    </p>
                    <p className="text-[10px] text-zinc-500 font-mono mt-0.5 truncate" title={art.remotePath}>
                      {formatBytes(art.sizeBytes)} • {new Date(art.createdAt).toLocaleDateString()}
                    </p>
                  </div>

                  {/* Card Quick Actions */}
                  <div className="flex items-center justify-between pt-2 border-t border-[#21262d] text-zinc-400">
                    <span className="text-[10px] text-zinc-500 font-mono truncate max-w-[90px]">
                      {art.mimeType.split('/').pop()}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleHide(art.id);
                        }}
                        title={isHidden ? 'Unhide artifact' : 'Hide artifact'}
                        className="p-1 hover:bg-[#21262d] text-zinc-400 hover:text-amber-400 rounded transition-colors cursor-pointer"
                      >
                        {isHidden ? <Eye className="w-3 h-3 text-amber-400" /> : <EyeOff className="w-3 h-3" />}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => handleCopyPath(e, art)}
                        title="Copy remote path"
                        className="p-1 hover:bg-[#21262d] text-zinc-400 hover:text-zinc-200 rounded transition-colors cursor-pointer"
                      >
                        {copiedId === art.id ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => handleSaveAs(e, art)}
                        title="Save As..."
                        className="p-1 hover:bg-[#21262d] text-zinc-400 hover:text-zinc-200 rounded transition-colors cursor-pointer"
                      >
                        <Download className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => handleDelete(e, art)}
                        title="Delete artifact"
                        className="p-1 hover:bg-rose-950 text-zinc-500 hover:text-rose-400 rounded transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          /* List View */
          <div className="flex flex-col gap-1.5">
            {filteredArtifacts.map((art) => {
              const isHidden = hiddenArtifactIds.has(art.id);
              return (
                <div
                  key={art.id}
                  data-testid={`artifact-row-${art.id}`}
                  onClick={() => setSelectedArtifact(art)}
                  onContextMenu={(e) => handleCardContextMenu(e, art)}
                  className={`px-3.5 py-2.5 bg-[#12161c] border rounded-lg flex items-center justify-between gap-3 text-xs transition-all cursor-pointer group ${
                    isHidden
                      ? 'border-amber-900/40 opacity-50 hover:opacity-90 hover:border-amber-500/60'
                      : 'border-[#30363d] hover:border-emerald-500/60'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {getFileIcon(art.mimeType, art.filename)}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-zinc-100 truncate group-hover:text-emerald-300 transition-colors">
                          {art.filename}
                        </p>
                        {isHidden && (
                          <span className="px-1.5 py-0.2 rounded text-[9px] font-bold uppercase tracking-wider bg-amber-950 text-amber-300 border border-amber-800/60">
                            Hidden
                          </span>
                        )}
                        <span
                          className={`px-1.5 py-0.2 rounded text-[9px] font-bold uppercase tracking-wider ${
                            art.direction === 'input'
                              ? 'bg-blue-950 text-blue-300 border border-blue-800/60'
                              : 'bg-emerald-950 text-emerald-300 border border-emerald-800/60'
                          }`}
                        >
                          {art.direction}
                        </span>
                      </div>
                      <p className="text-[10px] text-zinc-500 font-mono truncate" title={art.remotePath}>
                        {art.remotePath}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 text-zinc-400 shrink-0">
                    <span className="text-[11px] font-mono text-zinc-400">{formatBytes(art.sizeBytes)}</span>
                    <span className="text-[11px] text-zinc-500">{new Date(art.createdAt).toLocaleTimeString()}</span>

                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleHide(art.id);
                        }}
                        title={isHidden ? 'Unhide artifact' : 'Hide artifact'}
                        className="p-1 hover:bg-[#21262d] text-zinc-400 hover:text-amber-400 rounded transition-colors cursor-pointer"
                      >
                        {isHidden ? <Eye className="w-3 h-3 text-amber-400" /> : <EyeOff className="w-3 h-3" />}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => handleCopyPath(e, art)}
                        title="Copy remote path"
                        className="p-1 hover:bg-[#21262d] text-zinc-400 hover:text-zinc-200 rounded transition-colors cursor-pointer"
                      >
                        {copiedId === art.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => handleSaveAs(e, art)}
                        title="Save As..."
                        className="p-1 hover:bg-[#21262d] text-zinc-400 hover:text-zinc-200 rounded transition-colors cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => handleOpenInOs(e, art)}
                        title="Open in OS"
                        className="p-1 hover:bg-[#21262d] text-zinc-400 hover:text-zinc-200 rounded transition-colors cursor-pointer"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => handleDelete(e, art)}
                        title="Delete artifact"
                        className="p-1 hover:bg-rose-950 text-zinc-500 hover:text-rose-400 rounded transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Floating Artifact Context Menu */}
      {contextMenu && (
        <ArtifactContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          artifact={contextMenu.artifact}
          isHidden={hiddenArtifactIds.has(contextMenu.artifact.id)}
          onToggleHide={() => toggleHide(contextMenu.artifact.id)}
          onAddToBlacklistExact={() => handleBlacklist(contextMenu.artifact.filename)}
          onAddToBlacklistWildcard={
            contextMenu.artifact.filename.includes('.')
              ? () => handleBlacklist(`*.${contextMenu.artifact.filename.split('.').pop()}`)
              : undefined
          }
          onCopyPath={() => {
            navigator.clipboard.writeText(contextMenu.artifact.remotePath);
            showToast('Copied remote path');
          }}
          onOpenInOs={() => {
            if (window.spawneaApi?.openArtifactInOs) {
              window.spawneaApi.openArtifactInOs(sessionId, contextMenu.artifact.id);
              showToast('Opened in default app');
            }
          }}
          onSaveAs={() => {
            if (window.spawneaApi?.saveArtifactAs) {
              window.spawneaApi.saveArtifactAs(sessionId, contextMenu.artifact.id);
            }
          }}
          onDelete={() => {
            handleDelete({ stopPropagation: () => {} } as any, contextMenu.artifact);
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Floating Toast Notification */}
      {toastMessage && (
        <div
          data-testid="artifact-gallery-toast"
          className="fixed bottom-5 right-5 z-50 bg-[#161b22]/95 border border-emerald-500/40 text-emerald-300 px-3.5 py-2 rounded-lg shadow-2xl text-xs flex items-center gap-2 backdrop-blur-md animate-in fade-in slide-in-from-bottom-2 duration-150 pointer-events-none font-sans"
        >
          <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Artifact Preview Modal */}
      {selectedArtifact && (
        <ArtifactPreviewModal
          artifact={selectedArtifact}
          sessionId={sessionId}
          onClose={() => setSelectedArtifact(null)}
          onDelete={async (id) => {
            if (onDeleteArtifact) {
              await onDeleteArtifact(id);
            } else if (window.spawneaApi?.deleteArtifact) {
              await window.spawneaApi.deleteArtifact(sessionId, id);
              onRefresh?.();
            }
          }}
        />
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
