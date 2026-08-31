import React, { useState, useEffect } from 'react';
import type { Artifact, FileContentResult } from '@spawnea/domain';
import {
  FileText,
  FileCode2,
  Image as ImageIcon,
  FileQuestion,
  Copy,
  Check,
  X,
  Download,
  ExternalLink,
  Trash2,
  ZoomIn,
  ZoomOut,

  RotateCcw,
  Loader2,
  AlertTriangle,

} from 'lucide-react';

export interface ArtifactPreviewModalProps {
  artifact: Artifact | null;
  sessionId: string;
  onClose: () => void;
  onDelete?: (artifactId: string) => void;
}

export function ArtifactPreviewModal({
  artifact,
  sessionId,
  onClose,
  onDelete,
}: ArtifactPreviewModalProps): React.JSX.Element | null {
  const [contentResult, setContentResult] = useState<FileContentResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // View state
  const [activeTab, setActiveTab] = useState<'rendered' | 'raw'>('rendered');
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [copiedRemotePath, setCopiedRemotePath] = useState(false);
  const [copiedLocalPath, setCopiedLocalPath] = useState(false);
  const [copiedContent, setCopiedContent] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!artifact) {
      setContentResult(null);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);
    setZoomLevel(1);

    if (window.spawneaApi?.getArtifactContent) {
      window.spawneaApi
        .getArtifactContent(sessionId, artifact.id)
        .then((res) => {
          setContentResult(res);
        })
        .catch((err) => {
          setError(err.message || 'Failed to load artifact content');
        })
        .finally(() => {
          setIsLoading(false);
        });
    } else {
      // Fallback
      setIsLoading(false);
      setContentResult({
        path: artifact.remotePath,
        content: `// Sample preview for ${artifact.filename}`,
        isBinary: false,
        isTruncated: false,
        sizeBytes: artifact.sizeBytes,
        mimeType: artifact.mimeType,
      });
    }
  }, [artifact, sessionId]);

  if (!artifact) return null;

  const mime = artifact.mimeType || contentResult?.mimeType || 'application/octet-stream';
  const isImage = mime.startsWith('image/');
  const isPdf = mime === 'application/pdf';
  const isMarkdown = artifact.filename.endsWith('.md') || mime === 'text/markdown';
  const isJson = artifact.filename.endsWith('.json') || mime === 'application/json';

  const handleCopyRemotePath = () => {
    navigator.clipboard.writeText(artifact.remotePath);
    setCopiedRemotePath(true);
    setTimeout(() => setCopiedRemotePath(false), 2000);
  };

  const handleCopyLocalPath = () => {
    if (artifact.cachedLocalPath) {
      navigator.clipboard.writeText(artifact.cachedLocalPath);
      setCopiedLocalPath(true);
      setTimeout(() => setCopiedLocalPath(false), 2000);
    }
  };

  const handleCopyContent = () => {
    if (contentResult?.content && !contentResult.isBinary) {
      navigator.clipboard.writeText(contentResult.content);
      setCopiedContent(true);
      setTimeout(() => setCopiedContent(false), 2000);
    }
  };

  const handleSaveAs = async () => {
    if (!window.spawneaApi?.saveArtifactAs) return;
    setIsSaving(true);
    try {
      await window.spawneaApi.saveArtifactAs(sessionId, artifact.id);
    } catch {
      // ignore
    } finally {
      setIsSaving(false);
    }
  };

  const handleOpenInOs = async () => {
    if (window.spawneaApi?.openArtifactInOs) {
      await window.spawneaApi.openArtifactInOs(sessionId, artifact.id);
    }
  };

  // Escape key handler
  useEffect(() => {
    if (!artifact) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [artifact, onClose]);

  const handleDelete = () => {
    if (confirm(`Delete artifact "${artifact.filename}"?`)) {
      if (onDelete) {
        onDelete(artifact.id);
      }
      onClose();
    }
  };

  return (
    <div
      data-testid="artifact-preview-modal"
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 sm:p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="w-full max-w-5xl h-[85vh] flex flex-col rounded-xl border border-[#30363d] bg-[#0d1117] shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Modal Header */}
        <div className="px-5 py-3 bg-[#161b22] border-b border-[#30363d] flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            {isImage ? (
              <ImageIcon className="w-5 h-5 text-purple-400 shrink-0" />
            ) : isPdf ? (
              <FileText className="w-5 h-5 text-rose-400 shrink-0" />
            ) : isMarkdown ? (
              <FileText className="w-5 h-5 text-blue-400 shrink-0" />
            ) : (
              <FileCode2 className="w-5 h-5 text-emerald-400 shrink-0" />
            )}

            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="font-mono text-sm font-semibold text-white truncate" title={artifact.filename}>
                  {artifact.filename}
                </h3>
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                    artifact.direction === 'input'
                      ? 'bg-blue-950 text-blue-300 border border-blue-800/60'
                      : 'bg-emerald-950 text-emerald-300 border border-emerald-800/60'
                  }`}
                >
                  {artifact.direction}
                </span>
              </div>
              <p className="text-[11px] text-zinc-400 font-mono truncate" title={artifact.remotePath}>
                {artifact.remotePath} • {formatBytes(artifact.sizeBytes)}
              </p>
            </div>
          </div>

          {/* Action Toolbar */}
          <div className="flex items-center gap-1.5 shrink-0">
            {isMarkdown && !contentResult?.isBinary && (
              <div className="flex items-center bg-[#0d1117] rounded p-0.5 border border-[#30363d] mr-2">
                <button
                  type="button"
                  onClick={() => setActiveTab('rendered')}
                  className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${
                    activeTab === 'rendered' ? 'bg-[#21262d] text-emerald-400' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Rendered
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('raw')}
                  className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${
                    activeTab === 'raw' ? 'bg-[#21262d] text-emerald-400' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Raw Code
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={handleCopyRemotePath}
              data-testid="copy-remote-path-button"
              title="Copy remote path"
              className="flex items-center gap-1 px-2.5 py-1 bg-[#21262d] hover:bg-[#30363d] text-zinc-300 rounded text-xs transition-colors cursor-pointer"
            >
              {copiedRemotePath ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedRemotePath ? 'Copied' : 'Remote Path'}</span>
            </button>

            {artifact.cachedLocalPath && (
              <button
                type="button"
                onClick={handleCopyLocalPath}
                data-testid="copy-local-path-button"
                title="Copy local cached path"
                className="flex items-center gap-1 px-2.5 py-1 bg-[#21262d] hover:bg-[#30363d] text-zinc-300 rounded text-xs transition-colors cursor-pointer"
              >
                {copiedLocalPath ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedLocalPath ? 'Copied' : 'Local Path'}</span>
              </button>
            )}

            {!contentResult?.isBinary && (
              <button
                type="button"
                onClick={handleCopyContent}
                data-testid="copy-artifact-content-button"
                title="Copy text content"
                className="flex items-center gap-1 px-2.5 py-1 bg-[#21262d] hover:bg-[#30363d] text-zinc-300 rounded text-xs transition-colors cursor-pointer"
              >
                {copiedContent ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedContent ? 'Copied' : 'Copy'}</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleSaveAs}
              disabled={isSaving}
              data-testid="save-artifact-button"
              title="Save file as..."
              className="flex items-center gap-1 px-2.5 py-1 bg-[#21262d] hover:bg-[#30363d] text-zinc-300 rounded text-xs transition-colors cursor-pointer disabled:opacity-50"
            >
              {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              <span>Save As...</span>
            </button>

            <button
              type="button"
              onClick={handleOpenInOs}
              data-testid="open-in-os-button"
              title="Open file with OS default app"
              className="flex items-center gap-1 px-2.5 py-1 bg-[#21262d] hover:bg-[#30363d] text-zinc-300 rounded text-xs transition-colors cursor-pointer"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>Open in OS</span>
            </button>

            {onDelete && (
              <button
                type="button"
                onClick={handleDelete}
                data-testid="delete-artifact-button"
                title="Delete artifact"
                className="p-1.5 bg-[#21262d] hover:bg-rose-950/60 text-zinc-400 hover:text-rose-400 rounded transition-colors cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              data-testid="close-artifact-modal-button"
              title="Close modal"
              className="p-1.5 hover:bg-[#21262d] text-zinc-400 hover:text-white rounded transition-colors cursor-pointer ml-1"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Modal Main Content */}
        <div className="flex-1 overflow-auto bg-[#0d1117] flex flex-col relative select-text">
          {isLoading ? (
            <div className="flex-1 flex flex-col items-center justify-center p-12 text-zinc-400 gap-2">
              <Loader2 className="w-6 h-6 animate-spin text-emerald-400" />
              <span className="text-xs">Loading artifact contents...</span>
            </div>
          ) : error ? (
            <div className="flex-1 flex flex-col items-center justify-center p-12 text-rose-400">
              <AlertTriangle className="w-10 h-10 mb-2 opacity-80" />
              <p className="font-semibold text-sm">Failed to load preview</p>
              <p className="text-zinc-500 mt-1 text-xs max-w-sm text-center">{error}</p>
            </div>
          ) : isImage && contentResult?.content ? (
            <div className="flex-1 flex flex-col bg-[#090d13] overflow-hidden">
              {/* Zoom Controls */}
              <div className="h-9 px-4 bg-[#12161c] border-b border-[#21262d] flex items-center justify-between text-xs text-zinc-400 shrink-0 select-none">
                <div className="flex items-center gap-2">
                  <span>Zoom: {Math.round(zoomLevel * 100)}%</span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setZoomLevel((z) => Math.max(0.25, z - 0.25))}
                    title="Zoom Out"
                    className="p-1 hover:bg-[#21262d] text-zinc-300 rounded"
                  >
                    <ZoomOut className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setZoomLevel(1)}
                    title="Reset to 100%"
                    className="p-1 hover:bg-[#21262d] text-zinc-300 rounded"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setZoomLevel((z) => Math.min(3, z + 0.25))}
                    title="Zoom In"
                    className="p-1 hover:bg-[#21262d] text-zinc-300 rounded"
                  >
                    <ZoomIn className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Image Canvas */}
              <div className="flex-1 flex items-center justify-center p-6 overflow-auto">
                <img
                  src={contentResult.content}
                  alt={artifact.filename}
                  style={{ transform: `scale(${zoomLevel})`, transformOrigin: 'center center' }}
                  className="max-w-full max-h-full object-contain rounded shadow-2xl transition-transform duration-100 select-none"
                />
              </div>
            </div>
          ) : isPdf && contentResult?.content ? (
            <div className="flex-1 flex flex-col h-full bg-[#12161c]">
              <iframe
                src={contentResult.content}
                title={artifact.filename}
                className="w-full h-full border-0"
              />
            </div>
          ) : isMarkdown && activeTab === 'rendered' && contentResult?.content ? (
            <div className="p-8 max-w-4xl mx-auto text-zinc-200 text-sm leading-relaxed font-sans space-y-4">
              {renderMarkdown(contentResult.content)}
            </div>
          ) : isJson && contentResult?.content ? (
            <div className="p-4 font-mono text-xs text-zinc-200 overflow-auto">
              <pre className="p-4 bg-[#12161c] border border-[#21262d] rounded-lg overflow-x-auto text-emerald-300">
                {formatJsonString(contentResult.content)}
              </pre>
            </div>
          ) : contentResult?.content && !contentResult.isBinary ? (
            <div className="font-mono text-xs py-3 text-zinc-200 overflow-auto">
              <table className="w-full border-collapse">
                <tbody>
                  {contentResult.content.split('\n').map((line, idx) => (
                    <tr key={idx} className="hover:bg-[#161b22]/70">
                      <td className="w-14 py-0.5 px-3 text-right select-none text-[11px] text-zinc-600 border-r border-[#21262d]/40">
                        {idx + 1}
                      </td>
                      <td className="py-0.5 px-3 whitespace-pre font-mono leading-relaxed select-text">
                        {line || ' '}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-12 text-zinc-400">
              <FileQuestion className="w-12 h-12 text-zinc-600 mb-3" />
              <p className="text-zinc-200 font-medium">Binary data file</p>
              <p className="text-xs text-zinc-500 mt-1 max-w-sm text-center">
                This file cannot be previewed inline as text. Click "Save As..." or "Open in OS" to view.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function renderMarkdown(md: string): React.JSX.Element[] {
  const lines = md.split('\n');
  const elements: React.JSX.Element[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('# ')) {
      elements.push(
        <h1 key={i} className="text-xl font-bold text-white pb-2 border-b border-[#30363d] mt-4 mb-2">
          {line.replace('# ', '')}
        </h1>
      );
    } else if (line.startsWith('## ')) {
      elements.push(
        <h2 key={i} className="text-lg font-semibold text-white pb-1 border-b border-[#30363d]/60 mt-3 mb-2">
          {line.replace('## ', '')}
        </h2>
      );
    } else if (line.startsWith('### ')) {
      elements.push(
        <h3 key={i} className="text-sm font-semibold text-emerald-400 mt-2 mb-1">
          {line.replace('### ', '')}
        </h3>
      );
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      elements.push(
        <li key={i} className="list-disc list-inside text-zinc-300 text-xs ml-2">
          {line.substring(2)}
        </li>
      );
    } else if (line.startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      elements.push(
        <pre
          key={i}
          className="p-3 bg-[#161b22] border border-[#30363d] rounded text-xs font-mono text-emerald-300 overflow-x-auto my-2"
        >
          {codeLines.join('\n')}
        </pre>
      );
    } else if (line.trim().length > 0) {
      elements.push(
        <p key={i} className="text-xs text-zinc-300 leading-relaxed">
          {line}
        </p>
      );
    }
  }

  return elements;
}

function formatJsonString(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
