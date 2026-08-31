import React from 'react';
import type { GitStatusResult, GitFileStatus } from '@spawnea/domain';
import {
  GitBranch,
  ArrowUp,
  ArrowDown,
  CheckCircle2,
  FileCode2,
  AlertCircle,
  RefreshCw,
  FolderMinus,
} from 'lucide-react';

export interface GitStatusViewProps {
  status: GitStatusResult | null;
  selectedFilePath: string | null;
  onSelectFile: (filePath: string | null) => void;
  onRefresh: () => void;
  isLoading?: boolean;
  error?: string | null;
}

export function GitStatusView({
  status,
  selectedFilePath,
  onSelectFile,
  onRefresh,
  isLoading,
  error,
}: GitStatusViewProps): React.JSX.Element {
  if (isLoading && !status) {
    return (
      <div className="p-4 text-center text-zinc-500 text-xs flex items-center justify-center gap-2">
        <RefreshCw className="w-3.5 h-3.5 animate-spin text-emerald-400" />
        <span>Inspecting Git status...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-rose-950/20 border border-rose-800/40 rounded-lg text-xs text-rose-300 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
          <span>{error}</span>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="px-2 py-1 bg-[#21262d] hover:bg-[#30363d] text-zinc-200 rounded text-[11px] transition-colors cursor-pointer"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!status?.isGitRepo) {
    return (
      <div className="p-4 bg-[#161b22] border border-[#30363d] rounded-lg text-xs text-zinc-400 flex items-center gap-3">
        <FolderMinus className="w-5 h-5 text-zinc-500 shrink-0" />
        <div>
          <p className="font-semibold text-zinc-200">Not a Git repository</p>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            This project folder does not contain a .git directory. File browsing is still fully functional.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="git-status-view" className="flex flex-col gap-3">
      {/* Branch & Tracking Banner */}
      <div className="p-3 bg-[#161b22] border border-[#30363d] rounded-lg flex items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-[#21262d] text-emerald-400 font-mono font-semibold border border-[#30363d] shrink-0">
            <GitBranch className="w-3.5 h-3.5" />
            <span className="truncate">{status.branch}</span>
          </div>

          {status.trackingBranch && (
            <div className="flex items-center gap-1 text-[11px] text-zinc-400 font-mono truncate">
              <span className="text-zinc-500">tracks</span>
              <span className="truncate">{status.trackingBranch}</span>
              {(status.ahead > 0 || status.behind > 0) && (
                <div className="flex items-center gap-1 ml-1">
                  {status.ahead > 0 && (
                    <span className="text-emerald-400 font-semibold flex items-center">
                      <ArrowUp className="w-3 h-3" />
                      {status.ahead}
                    </span>
                  )}
                  {status.behind > 0 && (
                    <span className="text-rose-400 font-semibold flex items-center">
                      <ArrowDown className="w-3 h-3" />
                      {status.behind}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {status.isClean ? (
            <div className="flex items-center gap-1 text-[11px] text-emerald-400 bg-emerald-950/50 px-2 py-0.5 rounded border border-emerald-800/40">
              <CheckCircle2 className="w-3 h-3" />
              <span>Clean</span>
            </div>
          ) : (
            <div className="flex items-center gap-1 text-[11px] text-amber-300 bg-amber-950/50 px-2 py-0.5 rounded border border-amber-800/40 font-mono font-semibold">
              <span>{status.totalChanges} changes</span>
            </div>
          )}

          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            data-testid="refresh-git-status-button"
            title="Refresh Git status"
            className="p-1 rounded bg-[#21262d] hover:bg-[#30363d] text-zinc-300 transition-colors cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin text-emerald-400' : ''}`} />
          </button>
        </div>
      </div>

      {/* Changed Files Sections */}
      {!status.isClean && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* Staged Changes */}
          {status.staged.length > 0 && (
            <div className="p-3 bg-[#12161c] border border-[#30363d] rounded-lg flex flex-col gap-2">
              <div className="flex items-center justify-between text-xs text-zinc-400 border-b border-[#21262d] pb-1.5 font-semibold">
                <span className="text-emerald-400">Staged Changes</span>
                <span className="font-mono text-[11px] bg-[#21262d] px-1.5 py-0.2 rounded text-zinc-300">
                  {status.staged.length}
                </span>
              </div>
              <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
                {status.staged.map((f) => (
                  <FileStatusRow
                    key={`staged-${f.path}`}
                    file={f}
                    isSelected={selectedFilePath === f.path}
                    onClick={() => onSelectFile(selectedFilePath === f.path ? null : f.path)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Unstaged Changes */}
          {status.unstaged.length > 0 && (
            <div className="p-3 bg-[#12161c] border border-[#30363d] rounded-lg flex flex-col gap-2">
              <div className="flex items-center justify-between text-xs text-zinc-400 border-b border-[#21262d] pb-1.5 font-semibold">
                <span className="text-amber-400">Unstaged Changes</span>
                <span className="font-mono text-[11px] bg-[#21262d] px-1.5 py-0.2 rounded text-zinc-300">
                  {status.unstaged.length}
                </span>
              </div>
              <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
                {status.unstaged.map((f) => (
                  <FileStatusRow
                    key={`unstaged-${f.path}`}
                    file={f}
                    isSelected={selectedFilePath === f.path}
                    onClick={() => onSelectFile(selectedFilePath === f.path ? null : f.path)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Untracked Files */}
          {status.untracked.length > 0 && (
            <div className="p-3 bg-[#12161c] border border-[#30363d] rounded-lg flex flex-col gap-2">
              <div className="flex items-center justify-between text-xs text-zinc-400 border-b border-[#21262d] pb-1.5 font-semibold">
                <span className="text-zinc-400">Untracked Files</span>
                <span className="font-mono text-[11px] bg-[#21262d] px-1.5 py-0.2 rounded text-zinc-300">
                  {status.untracked.length}
                </span>
              </div>
              <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
                {status.untracked.map((f) => (
                  <FileStatusRow
                    key={`untracked-${f.path}`}
                    file={f}
                    isSelected={selectedFilePath === f.path}
                    onClick={() => onSelectFile(selectedFilePath === f.path ? null : f.path)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FileStatusRow({
  file,
  isSelected,
  onClick,
}: {
  file: GitFileStatus;
  isSelected: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center justify-between gap-2 px-2 py-1 rounded text-left text-xs font-mono transition-colors cursor-pointer ${
        isSelected ? 'bg-[#21262d] text-emerald-300 font-semibold' : 'hover:bg-[#1c2128] text-zinc-300'
      }`}
    >
      <div className="flex items-center gap-1.5 truncate">
        <FileCode2 className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
        <span className="truncate">{file.path}</span>
      </div>
      <span
        className={`px-1 py-0.2 rounded text-[10px] font-bold shrink-0 ${
          file.status === 'added'
            ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/40'
            : file.status === 'deleted'
            ? 'bg-rose-950 text-rose-400 border border-rose-800/40'
            : file.status === 'modified'
            ? 'bg-amber-950 text-amber-400 border border-amber-800/40'
            : file.status === 'renamed'
            ? 'bg-purple-950 text-purple-400 border border-purple-800/40'
            : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
        }`}
      >
        {file.statusCode}
      </span>
    </button>
  );
}
