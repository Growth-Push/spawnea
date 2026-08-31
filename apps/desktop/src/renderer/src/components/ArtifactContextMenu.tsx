import React, { useEffect, useRef } from 'react';
import type { Artifact } from '@spawnea/domain';
import {
  Eye,
  EyeOff,
  Ban,
  Copy,
  ExternalLink,
  Download,
  Trash2,
  FileCode2,
} from 'lucide-react';

export interface ArtifactContextMenuProps {
  x: number;
  y: number;
  artifact: Artifact;
  isHidden: boolean;
  onToggleHide: () => void;
  onAddToBlacklistExact: () => void;
  onAddToBlacklistWildcard?: () => void;
  onCopyPath: () => void;
  onOpenInOs: () => void;
  onSaveAs: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function ArtifactContextMenu({
  x,
  y,
  artifact,
  isHidden,
  onToggleHide,
  onAddToBlacklistExact,
  onAddToBlacklistWildcard,
  onCopyPath,
  onOpenInOs,
  onSaveAs,
  onDelete,
  onClose,
}: ArtifactContextMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('mousedown', handleClickOutside, true);
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('mousedown', handleClickOutside, true);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [onClose]);

  // Adjust positioning to avoid overflowing viewport
  const menuWidth = 260;
  const menuHeight = 270;
  const screenW = window.innerWidth;
  const screenH = window.innerHeight;

  const posX = x + menuWidth > screenW ? Math.max(10, screenW - menuWidth - 10) : x;
  const posY = y + menuHeight > screenH ? Math.max(10, screenH - menuHeight - 10) : y;

  const ext = artifact.filename.includes('.') ? `*.${artifact.filename.split('.').pop()}` : null;

  return (
    <div
      ref={menuRef}
      role="menu"
      data-testid="artifact-context-menu"
      style={{ left: `${posX}px`, top: `${posY}px` }}
      className="fixed z-50 w-64 bg-[#161b22]/95 backdrop-blur-md border border-[#30363d] rounded-lg shadow-2xl py-1 text-xs text-zinc-200 animate-in fade-in zoom-in-95 duration-100 select-none font-sans"
    >
      <div className="px-3 py-1.5 border-b border-[#30363d] text-[11px] font-mono text-zinc-400 truncate">
        {artifact.filename}
      </div>

      {/* 1. Toggle Hide */}
      <button
        type="button"
        role="menuitem"
        data-testid="artifact-context-hide"
        onClick={() => {
          onToggleHide();
          onClose();
        }}
        className="w-full px-3 py-1.5 flex items-center justify-between hover:bg-emerald-600 hover:text-white transition-colors text-left cursor-pointer"
      >
        <div className="flex items-center gap-2">
          {isHidden ? <Eye className="w-3.5 h-3.5 text-blue-400" /> : <EyeOff className="w-3.5 h-3.5 text-amber-400" />}
          <span>{isHidden ? 'Unhide Artifact' : 'Hide from Gallery'}</span>
        </div>
      </button>

      {/* 2. Blacklist exact file */}
      <button
        type="button"
        role="menuitem"
        data-testid="artifact-context-blacklist-exact"
        onClick={() => {
          onAddToBlacklistExact();
          onClose();
        }}
        className="w-full px-3 py-1.5 flex items-center justify-between hover:bg-rose-900/80 hover:text-rose-200 transition-colors text-left cursor-pointer text-rose-300"
      >
        <div className="flex items-center gap-2 min-w-0">
          <Ban className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">Blacklist `{artifact.filename}`</span>
        </div>
      </button>

      {/* 3. Blacklist wildcard extension (if available) */}
      {ext && onAddToBlacklistWildcard && (
        <button
          type="button"
          role="menuitem"
          data-testid="artifact-context-blacklist-wildcard"
          onClick={() => {
            onAddToBlacklistWildcard();
            onClose();
          }}
          className="w-full px-3 py-1.5 flex items-center justify-between hover:bg-rose-900/80 hover:text-rose-200 transition-colors text-left cursor-pointer text-rose-300"
        >
          <div className="flex items-center gap-2 min-w-0">
            <Ban className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">Never show `{ext}` files</span>
          </div>
        </button>
      )}

      <div className="my-1 border-t border-[#30363d]" />

      {/* 4. Copy Remote Path */}
      <button
        type="button"
        role="menuitem"
        data-testid="artifact-context-copy-path"
        onClick={() => {
          onCopyPath();
          onClose();
        }}
        className="w-full px-3 py-1.5 flex items-center justify-between hover:bg-[#21262d] transition-colors text-left cursor-pointer"
      >
        <div className="flex items-center gap-2">
          <Copy className="w-3.5 h-3.5 text-zinc-400" />
          <span>Copy Remote Path</span>
        </div>
      </button>

      {/* 5. Open in Default OS / Editor */}
      <button
        type="button"
        role="menuitem"
        data-testid="artifact-context-open-os"
        onClick={() => {
          onOpenInOs();
          onClose();
        }}
        className="w-full px-3 py-1.5 flex items-center justify-between hover:bg-[#21262d] transition-colors text-left cursor-pointer"
      >
        <div className="flex items-center gap-2">
          <ExternalLink className="w-3.5 h-3.5 text-zinc-400" />
          <span>Open in OS Default</span>
        </div>
      </button>

      {/* 6. Save / Export As */}
      <button
        type="button"
        role="menuitem"
        data-testid="artifact-context-save-as"
        onClick={() => {
          onSaveAs();
          onClose();
        }}
        className="w-full px-3 py-1.5 flex items-center justify-between hover:bg-[#21262d] transition-colors text-left cursor-pointer"
      >
        <div className="flex items-center gap-2">
          <Download className="w-3.5 h-3.5 text-zinc-400" />
          <span>Save / Download As...</span>
        </div>
      </button>

      <div className="my-1 border-t border-[#30363d]" />

      {/* 7. Delete */}
      <button
        type="button"
        role="menuitem"
        data-testid="artifact-context-delete"
        onClick={() => {
          onDelete();
          onClose();
        }}
        className="w-full px-3 py-1.5 flex items-center justify-between hover:bg-rose-950/60 hover:text-rose-300 text-zinc-400 transition-colors text-left cursor-pointer"
      >
        <div className="flex items-center gap-2">
          <Trash2 className="w-3.5 h-3.5" />
          <span>Delete Artifact Record</span>
        </div>
      </button>
    </div>
  );
}
