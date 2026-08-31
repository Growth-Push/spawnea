import React, { useEffect, useRef } from 'react';
import {
  Copy,
  ClipboardPaste,
  FileCode2,
  FilePlus,
  Trash2,
  CheckSquare,
} from 'lucide-react';

export interface TerminalContextMenuProps {
  x: number;
  y: number;
  hasSelection: boolean;
  onCopy: () => void;
  onPaste: () => void;
  onOpenInEditor: () => void;
  onTransformToArtifact: () => void;
  onSelectAll: () => void;
  onClearBuffer: () => void;
  onClose: () => void;
}

export function TerminalContextMenu({
  x,
  y,
  hasSelection,
  onCopy,
  onPaste,
  onOpenInEditor,
  onTransformToArtifact,
  onSelectAll,
  onClearBuffer,
  onClose,
}: TerminalContextMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close when clicking outside or pressing Escape
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
  const menuWidth = 240;
  const menuHeight = 220;
  const screenW = window.innerWidth;
  const screenH = window.innerHeight;

  const posX = x + menuWidth > screenW ? Math.max(10, screenW - menuWidth - 10) : x;
  const posY = y + menuHeight > screenH ? Math.max(10, screenH - menuHeight - 10) : y;

  return (
    <div
      ref={menuRef}
      role="menu"
      data-testid="terminal-context-menu"
      style={{ left: `${posX}px`, top: `${posY}px` }}
      className="fixed z-50 w-60 bg-[#161b22]/95 backdrop-blur-md border border-[#30363d] rounded-lg shadow-2xl py-1 text-xs text-zinc-200 animate-in fade-in zoom-in-95 duration-100 select-none font-sans"
    >
      {/* 1. Copy Selection */}
      <button
        type="button"
        role="menuitem"
        data-testid="context-menu-copy"
        disabled={!hasSelection}
        onClick={() => {
          onCopy();
          onClose();
        }}
        className="w-full px-3 py-1.5 flex items-center justify-between hover:bg-emerald-600 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-400 transition-colors text-left cursor-pointer disabled:cursor-not-allowed"
      >
        <div className="flex items-center gap-2">
          <Copy className="w-3.5 h-3.5" />
          <span>Copy Selection</span>
        </div>
        <span className="text-[10px] font-mono opacity-60">Ctrl+Shift+C</span>
      </button>

      {/* 2. Paste */}
      <button
        type="button"
        role="menuitem"
        data-testid="context-menu-paste"
        onClick={() => {
          onPaste();
          onClose();
        }}
        className="w-full px-3 py-1.5 flex items-center justify-between hover:bg-emerald-600 hover:text-white transition-colors text-left cursor-pointer"
      >
        <div className="flex items-center gap-2">
          <ClipboardPaste className="w-3.5 h-3.5" />
          <span>Paste</span>
        </div>
        <span className="text-[10px] font-mono opacity-60">Ctrl+Shift+V</span>
      </button>

      <div className="my-1 border-t border-[#30363d]" />

      {/* 3. Open in Default Editor */}
      <button
        type="button"
        role="menuitem"
        data-testid="context-menu-open-editor"
        disabled={!hasSelection}
        onClick={() => {
          onOpenInEditor();
          onClose();
        }}
        className="w-full px-3 py-1.5 flex items-center justify-between hover:bg-emerald-600 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-400 transition-colors text-left cursor-pointer disabled:cursor-not-allowed"
      >
        <div className="flex items-center gap-2">
          <FileCode2 className="w-3.5 h-3.5 text-blue-400" />
          <span>Open in Default Editor</span>
        </div>
      </button>

      {/* 4. Transform to Artifact */}
      <button
        type="button"
        role="menuitem"
        data-testid="context-menu-transform-artifact"
        disabled={!hasSelection}
        onClick={() => {
          onTransformToArtifact();
          onClose();
        }}
        className="w-full px-3 py-1.5 flex items-center justify-between hover:bg-emerald-600 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-400 transition-colors text-left cursor-pointer disabled:cursor-not-allowed"
      >
        <div className="flex items-center gap-2">
          <FilePlus className="w-3.5 h-3.5 text-amber-400" />
          <span>Transform to Artifact</span>
        </div>
      </button>

      <div className="my-1 border-t border-[#30363d]" />

      {/* 5. Select All */}
      <button
        type="button"
        role="menuitem"
        data-testid="context-menu-select-all"
        onClick={() => {
          onSelectAll();
          onClose();
        }}
        className="w-full px-3 py-1.5 flex items-center justify-between hover:bg-[#21262d] transition-colors text-left cursor-pointer"
      >
        <div className="flex items-center gap-2">
          <CheckSquare className="w-3.5 h-3.5 text-zinc-400" />
          <span>Select All</span>
        </div>
      </button>

      {/* 6. Clear Screen Buffer */}
      <button
        type="button"
        role="menuitem"
        data-testid="context-menu-clear"
        onClick={() => {
          onClearBuffer();
          onClose();
        }}
        className="w-full px-3 py-1.5 flex items-center justify-between hover:bg-[#21262d] text-zinc-400 hover:text-rose-400 transition-colors text-left cursor-pointer"
      >
        <div className="flex items-center gap-2">
          <Trash2 className="w-3.5 h-3.5" />
          <span>Clear Terminal Buffer</span>
        </div>
      </button>
    </div>
  );
}
