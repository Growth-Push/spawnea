import React from 'react';
import type { Artifact } from '@spawnea/domain';
import { Sparkles, Eye, FolderOpen, X, FileCode2 } from 'lucide-react';

export interface DetectedOutputBannerProps {
  artifact: Artifact;
  onPreview: (artifact: Artifact) => void;
  onViewInArtifacts: () => void;
  onDismiss: () => void;
}

export function DetectedOutputBanner({
  artifact,
  onPreview,
  onViewInArtifacts,
  onDismiss,
}: DetectedOutputBannerProps): React.JSX.Element {
  return (
    <div
      data-testid="detected-output-banner"
      className="px-4 py-2.5 bg-gradient-to-r from-emerald-950/60 to-cyan-950/50 border border-emerald-500/30 rounded-lg flex items-center justify-between gap-3 text-xs shrink-0 animate-in slide-in-from-top-2 duration-150 select-none shadow-sm"
    >
      <div className="flex items-center gap-2 min-w-0">
        <Sparkles className="w-4 h-4 text-emerald-400 shrink-0 animate-pulse" />
        <span className="font-semibold text-emerald-300">LLM generated output:</span>
        <span className="font-mono text-zinc-100 font-medium truncate max-w-sm" title={artifact.remotePath}>
          {artifact.filename}
        </span>
        <span className="text-[10px] text-zinc-400 font-mono hidden sm:inline">
          ({formatBytes(artifact.sizeBytes)})
        </span>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={() => onPreview(artifact)}
          data-testid="preview-detected-artifact-button"
          className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-[11px] transition-colors cursor-pointer shadow-sm"
        >
          <Eye className="w-3.5 h-3.5" />
          <span>Preview</span>
        </button>

        <button
          type="button"
          onClick={onViewInArtifacts}
          data-testid="view-in-artifacts-button"
          className="flex items-center gap-1.5 px-2 py-1 rounded bg-[#21262d] hover:bg-[#30363d] text-zinc-200 text-[11px] transition-colors cursor-pointer"
        >
          <FolderOpen className="w-3.5 h-3.5 text-zinc-400" />
          <span className="hidden sm:inline">Artifacts Tab</span>
        </button>

        <button
          type="button"
          onClick={onDismiss}
          data-testid="dismiss-detected-banner-button"
          className="p-1 hover:bg-[#21262d] text-zinc-400 hover:text-zinc-200 rounded transition-colors cursor-pointer ml-1"
          title="Dismiss banner"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
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
