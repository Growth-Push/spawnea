import React, { useState, useEffect, useCallback, useMemo } from 'react';
import type { FileEntry, FileContentResult } from '@spawnea/domain';
import { FilePreview } from './FilePreview';
import {
  Folder,

  File,
  FileCode2,
  FileText,
  Image as ImageIcon,
  Settings,
  Search,
  RefreshCw,
  ChevronRight,
  ArrowUp,
  ArrowDown,
  CornerLeftUp,
  FolderTree,
  AlertCircle,
} from 'lucide-react';

export interface FileBrowserProps {
  sessionId: string;
  worktreePath: string;
}

type SortField = 'name' | 'size' | 'modified';
type SortDirection = 'asc' | 'desc';

export function FileBrowser({
  sessionId,
  worktreePath,
}: FileBrowserProps): React.JSX.Element {
  const [currentSubPath, setCurrentSubPath] = useState<string>('');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Search & Filter
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  // Preview state
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);
  const [previewContent, setPreviewContent] = useState<FileContentResult | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Fetch directory files
  const fetchDirectory = useCallback(
    async (subPath: string) => {
      setIsLoading(true);
      setError(null);

      try {
        if (window.spawneaApi) {
          const result = await window.spawneaApi.listFiles(sessionId, subPath);
          setFiles(result);
        } else {
          // Fallback mock files for testing
          setFiles([
            { name: 'apps', path: `${worktreePath}/apps`, isDirectory: true, isFile: false, size: 4096, modifiedAt: new Date() },
            { name: 'packages', path: `${worktreePath}/packages`, isDirectory: true, isFile: false, size: 4096, modifiedAt: new Date() },
            { name: 'docs', path: `${worktreePath}/docs`, isDirectory: true, isFile: false, size: 4096, modifiedAt: new Date() },
            { name: 'package.json', path: `${worktreePath}/package.json`, isDirectory: false, isFile: true, size: 1024, modifiedAt: new Date() },
            { name: 'README.md', path: `${worktreePath}/README.md`, isDirectory: false, isFile: true, size: 2048, modifiedAt: new Date() },
          ]);
        }
      } catch (err: any) {
        setError(err.message || 'Failed to list directory');
        setFiles([]);
      } finally {
        setIsLoading(false);
      }
    },
    [sessionId, worktreePath]
  );

  // Re-fetch when sessionId or subPath changes
  useEffect(() => {
    fetchDirectory(currentSubPath);
  }, [sessionId, currentSubPath, fetchDirectory]);

  // Fetch file preview
  const handleSelectFile = async (file: FileEntry) => {
    setSelectedFile(file);
    setIsLoadingPreview(true);
    setPreviewError(null);

    const relativePath = file.path.startsWith(worktreePath)
      ? file.path.slice(worktreePath.length).replace(/^\/+/, '')
      : file.name;

    try {
      if (window.spawneaApi) {
        const result = await window.spawneaApi.readFile(sessionId, relativePath);
        setPreviewContent(result);
      } else {
        // Fallback preview
        setPreviewContent({
          path: file.path,
          content: `// Sample preview of ${file.name}\nexport function sample() {\n  return true;\n}\n`,
          isBinary: false,
          isTruncated: false,
          sizeBytes: file.size,
          mimeType: 'text/typescript',
        });
      }
    } catch (err: any) {
      setPreviewError(err.message || 'Failed to load preview');
      setPreviewContent(null);
    } finally {
      setIsLoadingPreview(false);
    }
  };

  const handleNavigateFolder = (folderName: string) => {
    const nextSub = currentSubPath ? `${currentSubPath}/${folderName}` : folderName;
    setCurrentSubPath(nextSub);
    setSearchQuery('');
  };

  const handleNavigateUp = () => {
    if (!currentSubPath) return;
    const parts = currentSubPath.split('/');
    parts.pop();
    setCurrentSubPath(parts.join('/'));
  };

  const handleBreadcrumbClick = (index: number) => {
    if (index === -1) {
      setCurrentSubPath('');
      return;
    }
    const parts = currentSubPath.split('/');
    const nextSub = parts.slice(0, index + 1).join('/');
    setCurrentSubPath(nextSub);
  };

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  // Filtered & Sorted file list
  const displayFiles = useMemo(() => {
    let result = files;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((f) => f.name.toLowerCase().includes(q));
    }

    return [...result].sort((a, b) => {
      // Keep directories first
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;

      let comparison = 0;
      if (sortField === 'name') {
        comparison = a.name.localeCompare(b.name);
      } else if (sortField === 'size') {
        comparison = a.size - b.size;
      } else if (sortField === 'modified') {
        comparison = new Date(a.modifiedAt).getTime() - new Date(b.modifiedAt).getTime();
      }

      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [files, searchQuery, sortField, sortDirection]);

  const breadcrumbs = currentSubPath ? currentSubPath.split('/') : [];

  return (
    <div
      data-testid="file-browser"
      className="h-full flex flex-col rounded-lg border border-[#30363d] bg-[#161b22] overflow-hidden"
    >
      {/* Navigation & Toolbar Header */}
      <div className="px-4 py-2.5 border-b border-[#30363d] bg-[#12161c] flex items-center justify-between gap-3 shrink-0">
        {/* Breadcrumb Navigation */}
        <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-x-auto text-xs">
          <button
            type="button"
            onClick={() => handleBreadcrumbClick(-1)}
            className={`flex items-center gap-1 font-mono text-[11px] px-1.5 py-0.5 rounded transition-colors cursor-pointer ${
              breadcrumbs.length === 0
                ? 'text-emerald-400 font-semibold bg-[#21262d]'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-[#21262d]'
            }`}
            title={worktreePath}
          >
            <FolderTree className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{worktreePath.split('/').pop() || 'root'}</span>
          </button>

          {breadcrumbs.map((segment, idx) => (
            <React.Fragment key={idx}>
              <ChevronRight className="w-3 h-3 text-zinc-600 shrink-0" />
              <button
                type="button"
                onClick={() => handleBreadcrumbClick(idx)}
                className={`font-mono text-[11px] px-1.5 py-0.5 rounded transition-colors cursor-pointer truncate ${
                  idx === breadcrumbs.length - 1
                    ? 'text-emerald-400 font-semibold bg-[#21262d]'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-[#21262d]'
                }`}
              >
                {segment}
              </button>
            </React.Fragment>
          ))}
        </div>

        {/* Search & Actions */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter files..."
              data-testid="file-search-input"
              className="pl-8 pr-2.5 py-1 text-xs bg-[#0d1117] border border-[#30363d] rounded-md text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-emerald-500 w-36 sm:w-48 transition-colors"
            />
          </div>

          {currentSubPath && (
            <button
              type="button"
              onClick={handleNavigateUp}
              data-testid="navigate-up-button"
              title="Go to parent directory"
              className="p-1.5 rounded bg-[#21262d] hover:bg-[#30363d] text-zinc-300 transition-colors cursor-pointer"
            >
              <CornerLeftUp className="w-3.5 h-3.5" />
            </button>
          )}

          <button
            type="button"
            onClick={() => fetchDirectory(currentSubPath)}
            disabled={isLoading}
            data-testid="refresh-files-button"
            title="Refresh directory"
            className="p-1.5 rounded bg-[#21262d] hover:bg-[#30363d] text-zinc-300 transition-colors cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-emerald-400' : ''}`} />
          </button>
        </div>
      </div>

      {/* Main Content Area: Split View when preview active */}
      <div className="flex-1 flex overflow-hidden">
        {/* File Table List */}
        <div className={`flex-1 flex flex-col overflow-hidden ${selectedFile ? 'border-r border-[#30363d] max-w-sm lg:max-w-md hidden md:flex' : ''}`}>
          {error ? (
            <div className="p-8 flex flex-col items-center justify-center text-rose-400 text-xs text-center">
              <AlertCircle className="w-8 h-8 mb-2 opacity-80" />
              <p className="font-semibold">Unable to load directory</p>
              <p className="text-zinc-500 mt-1 text-[11px]">{error}</p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-[#12161c] z-10 select-none shadow-sm">
                  <tr className="text-zinc-500 border-b border-[#21262d] font-mono text-[11px]">
                    <th
                      onClick={() => toggleSort('name')}
                      className="py-2 px-3 cursor-pointer hover:text-zinc-300 transition-colors"
                    >
                      <div className="flex items-center gap-1">
                        <span>Name</span>
                        {sortField === 'name' && (
                          sortDirection === 'asc' ? <ArrowUp className="w-3 h-3 text-emerald-400" /> : <ArrowDown className="w-3 h-3 text-emerald-400" />
                        )}
                      </div>
                    </th>
                    <th
                      onClick={() => toggleSort('size')}
                      className="py-2 px-3 cursor-pointer hover:text-zinc-300 transition-colors w-24"
                    >
                      <div className="flex items-center gap-1">
                        <span>Size</span>
                        {sortField === 'size' && (
                          sortDirection === 'asc' ? <ArrowUp className="w-3 h-3 text-emerald-400" /> : <ArrowDown className="w-3 h-3 text-emerald-400" />
                        )}
                      </div>
                    </th>
                    <th
                      onClick={() => toggleSort('modified')}
                      className="py-2 px-3 cursor-pointer hover:text-zinc-300 transition-colors w-28"
                    >
                      <div className="flex items-center gap-1">
                        <span>Modified</span>
                        {sortField === 'modified' && (
                          sortDirection === 'asc' ? <ArrowUp className="w-3 h-3 text-emerald-400" /> : <ArrowDown className="w-3 h-3 text-emerald-400" />
                        )}
                      </div>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#21262d]/60 font-mono">
                  {displayFiles.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="py-8 text-center text-zinc-500 text-xs">
                        {searchQuery ? `No files match "${searchQuery}"` : 'Directory is empty'}
                      </td>
                    </tr>
                  ) : (
                    displayFiles.map((file) => {
                      const isSelected = selectedFile?.path === file.path;
                      return (
                        <tr
                          key={file.path}
                          data-testid={`file-item-${file.name}`}
                          onClick={() => {
                            if (file.isDirectory) {
                              handleNavigateFolder(file.name);
                            } else {
                              handleSelectFile(file);
                            }
                          }}
                          className={`cursor-pointer transition-colors ${
                            isSelected
                              ? 'bg-[#21262d] text-emerald-300 font-semibold'
                              : 'hover:bg-[#1f242c] text-zinc-300'
                          }`}
                        >
                          <td className="py-2 px-3 flex items-center gap-2">
                            {getFileIcon(file)}
                            <span className="truncate">{file.name}</span>
                          </td>
                          <td className="py-2 px-3 text-zinc-500 text-[11px] whitespace-nowrap">
                            {file.isDirectory ? '-' : formatBytes(file.size)}
                          </td>
                          <td className="py-2 px-3 text-zinc-500 text-[11px] whitespace-nowrap">
                            {new Date(file.modifiedAt).toLocaleTimeString()}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* File Preview Column / View */}
        {selectedFile && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <FilePreview
              file={previewContent}
              sessionId={sessionId}
              isLoading={isLoadingPreview}
              error={previewError}
              onClose={() => {
                setSelectedFile(null);
                setPreviewContent(null);
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function getFileIcon(file: FileEntry): React.JSX.Element {
  if (file.isDirectory) {
    return <Folder className="w-3.5 h-3.5 text-blue-400 shrink-0" />;
  }

  const ext = file.name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'py':
    case 'go':
    case 'rs':
    case 'c':
    case 'cpp':
    case 'java':
      return <FileCode2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
    case 'md':
    case 'txt':
    case 'doc':
      return <FileText className="w-3.5 h-3.5 text-blue-400 shrink-0" />;
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':
      return <ImageIcon className="w-3.5 h-3.5 text-purple-400 shrink-0" />;
    case 'json':
    case 'yaml':
    case 'yml':
    case 'toml':
    case 'env':
      return <Settings className="w-3.5 h-3.5 text-amber-400 shrink-0" />;
    default:
      return <File className="w-3.5 h-3.5 text-zinc-400 shrink-0" />;
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
