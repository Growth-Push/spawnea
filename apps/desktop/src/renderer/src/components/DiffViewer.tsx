import React, { useState } from 'react';
import type { GitDiffResult, GitDiffFile } from '@spawnea/domain';
import {
  FileCode2,
  Copy,
  Check,
  Plus,
  Minus,
  FileQuestion,
  ChevronDown,
  ChevronRight,
  GitBranch,
} from 'lucide-react';

export interface DiffViewerProps {
  diffResult: GitDiffResult | null;
  worktreePath?: string;
  selectedFilePath?: string | null;
  onSelectFile?: (filePath: string | null) => void;
  isLoading?: boolean;
  error?: string | null;
}

export function DiffViewer({
  diffResult,
  worktreePath,
  selectedFilePath,
  onSelectFile,
  isLoading,
  error,
}: DiffViewerProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const [copiedRef, setCopiedRef] = useState<string | null>(null);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());

  const handleCopyDiff = () => {
    if (!diffResult?.rawDiff) return;
    navigator.clipboard.writeText(diffResult.rawDiff);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyLineRef = (filePath: string, lineNum?: number) => {
    if (!lineNum) return;
    const targetPath = worktreePath
      ? filePath.startsWith('/')
        ? filePath
        : `${worktreePath.replace(/\/+$/, '')}/${filePath}`
      : filePath;
    const ref = `${targetPath}:${lineNum}`;
    navigator.clipboard.writeText(ref);
    setCopiedRef(ref);
    setTimeout(() => setCopiedRef(null), 2000);
  };

  const toggleCollapse = (path: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center p-8 text-zinc-500 text-xs">
        <span className="animate-pulse">Loading Git diff...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-rose-400 text-xs">
        <p className="font-semibold">Unable to load Git diff</p>
        <p className="text-zinc-500 mt-1 text-[11px]">{error}</p>
      </div>
    );
  }

  if (!diffResult || diffResult.files.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-center text-zinc-500">
        <GitBranch className="w-10 h-10 text-zinc-600 mb-2" />
        <p className="text-zinc-300 font-medium text-xs">No Git changes detected</p>
        <p className="text-[11px] text-zinc-500 mt-1">Working tree is clean.</p>
      </div>
    );
  }

  // Filter files if a single file is selected
  const filesToDisplay = selectedFilePath
    ? diffResult.files.filter((f) => f.path === selectedFilePath)
    : diffResult.files;

  return (
    <div
      data-testid="diff-viewer"
      className="h-full flex flex-col rounded-lg border border-[#30363d] bg-[#090d13] font-mono text-xs overflow-hidden"
    >
      {/* Diff Header Bar */}
      <div className="px-4 py-2 bg-[#12161c] border-b border-[#21262d] flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2 text-xs text-zinc-300">
          <span className="font-semibold">
            {selectedFilePath ? selectedFilePath : `All Changes (${diffResult.files.length} files)`}
          </span>
          <div className="flex items-center gap-1.5 text-[11px] ml-2">
            <span className="text-emerald-400 font-semibold flex items-center">
              <Plus className="w-3 h-3 inline" />
              {diffResult.totalAdditions}
            </span>
            <span className="text-rose-400 font-semibold flex items-center">
              <Minus className="w-3 h-3 inline" />
              {diffResult.totalDeletions}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {selectedFilePath && onSelectFile && (
            <button
              type="button"
              onClick={() => onSelectFile(null)}
              className="px-2 py-1 bg-[#21262d] hover:bg-[#30363d] text-zinc-300 rounded text-[11px] transition-colors cursor-pointer"
            >
              Show All Files
            </button>
          )}

          <button
            type="button"
            onClick={handleCopyDiff}
            data-testid="copy-diff-button"
            className="flex items-center gap-1 px-2.5 py-1 bg-[#21262d] hover:bg-[#30363d] text-zinc-300 rounded text-[11px] transition-colors cursor-pointer"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            <span>{copied ? 'Copied' : 'Copy Diff'}</span>
          </button>
        </div>
      </div>

      {/* Diff Files List */}
      <div className="flex-1 overflow-y-auto divide-y divide-[#21262d]">
        {filesToDisplay.map((file) => {
          const isCollapsed = collapsedFiles.has(file.path);
          return (
            <div key={file.path} className="flex flex-col bg-[#090d13]">
              {/* File Accordion Header */}
              <div
                onClick={() => toggleCollapse(file.path)}
                className="px-4 py-2 bg-[#161b22] hover:bg-[#1c2128] border-b border-[#21262d] flex items-center justify-between cursor-pointer select-none transition-colors"
              >
                <div className="flex items-center gap-2 truncate">
                  {isCollapsed ? (
                    <ChevronRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                  )}
                  <FileCode2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span className="font-semibold text-zinc-200 truncate">{file.path}</span>
                  {file.oldPath && (
                    <span className="text-zinc-500 text-[10px] truncate">(renamed from {file.oldPath})</span>
                  )}
                  {file.isNew && (
                    <span className="px-1.5 py-0.2 rounded text-[10px] bg-emerald-950 text-emerald-400 border border-emerald-800/60">
                      NEW
                    </span>
                  )}
                  {file.isDeleted && (
                    <span className="px-1.5 py-0.2 rounded text-[10px] bg-rose-950 text-rose-400 border border-rose-800/60">
                      DELETED
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 text-[11px] shrink-0 font-mono">
                  <span className="text-emerald-400 font-semibold">+{file.additions}</span>
                  <span className="text-rose-400 font-semibold">-{file.deletions}</span>
                </div>
              </div>

              {/* File Hunks / Diff Content */}
              {!isCollapsed && (
                <div className="overflow-x-auto">
                  {file.isBinary ? (
                    <div className="p-4 text-center text-zinc-500 text-xs flex items-center justify-center gap-2">
                      <FileQuestion className="w-4 h-4" />
                      <span>Binary file changed.</span>
                    </div>
                  ) : (
                    file.hunks.map((hunk, hIdx) => (
                      <div key={hIdx} className="border-b border-[#21262d]/50 last:border-b-0">
                        {/* Hunk Header */}
                        <div className="px-4 py-1 bg-[#12161c] text-cyan-400/90 text-[11px] font-mono border-b border-[#21262d]/40 select-none">
                          {hunk.header}
                        </div>

                        {/* Hunk Lines */}
                        <table className="w-full border-collapse font-mono text-xs">
                          <tbody>
                            {hunk.lines.map((line, lIdx) => {
                              const isAdd = line.type === 'add';
                              const isDel = line.type === 'delete';
                              const activeLineNum = line.newLineNumber || line.oldLineNumber;
                              const targetPath = worktreePath
                                ? file.path.startsWith('/')
                                  ? file.path
                                  : `${worktreePath.replace(/\/+$/, '')}/${file.path}`
                                : file.path;
                              const refString = activeLineNum ? `${targetPath}:${activeLineNum}` : '';
                              const isCopied = Boolean(refString && copiedRef === refString);

                              return (
                                <tr
                                  key={lIdx}
                                  className={`group ${
                                    isAdd
                                      ? 'bg-emerald-950/30 text-emerald-300'
                                      : isDel
                                      ? 'bg-rose-950/30 text-rose-300'
                                      : 'text-zinc-300 hover:bg-[#161b22]/50'
                                  }`}
                                >
                                  {/* Old Line Number */}
                                  <td
                                    onClick={() => handleCopyLineRef(file.path, line.oldLineNumber)}
                                    title={line.oldLineNumber ? `Click to copy "${targetPath}:${line.oldLineNumber}"` : undefined}
                                    className={`w-10 py-0.5 px-2 text-right select-none text-[11px] border-r border-[#21262d]/40 ${
                                      line.oldLineNumber ? 'cursor-pointer hover:text-emerald-400 hover:bg-[#21262d]/60' : ''
                                    } ${
                                      isCopied && activeLineNum === line.oldLineNumber
                                        ? 'text-emerald-400 font-bold bg-emerald-950/50'
                                        : 'text-zinc-600'
                                    }`}
                                  >
                                    {isCopied && activeLineNum === line.oldLineNumber ? '✓' : (line.oldLineNumber || '')}
                                  </td>
                                  {/* New Line Number */}
                                  <td
                                    onClick={() => handleCopyLineRef(file.path, line.newLineNumber)}
                                    title={line.newLineNumber ? `Click to copy "${targetPath}:${line.newLineNumber}"` : undefined}
                                    className={`w-10 py-0.5 px-2 text-right select-none text-[11px] border-r border-[#21262d]/40 ${
                                      line.newLineNumber ? 'cursor-pointer hover:text-emerald-400 hover:bg-[#21262d]/60' : ''
                                    } ${
                                      isCopied && activeLineNum === line.newLineNumber
                                        ? 'text-emerald-400 font-bold bg-emerald-950/50'
                                        : 'text-zinc-600'
                                    }`}
                                  >
                                    {isCopied && activeLineNum === line.newLineNumber ? '✓' : (line.newLineNumber || '')}
                                  </td>
                                  {/* Line Marker (+ / -) */}
                                  <td className="w-4 py-0.5 px-1.5 text-center select-none font-bold text-[11px]">
                                    {isAdd ? '+' : isDel ? '-' : ' '}
                                  </td>
                                  {/* Line Content */}
                                  <td className="py-0.5 px-2 whitespace-pre leading-relaxed select-text">
                                    {line.content || ' '}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
