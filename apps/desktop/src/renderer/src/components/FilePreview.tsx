import React, { useState } from 'react';
import type { FileContentResult } from '@spawnea/domain';
import {
  FileText,
  FileCode2,
  Image as ImageIcon,
  Copy,
  Check,
  X,
  AlertTriangle,
  FileQuestion,
  Download,
  Star,
  Loader2,
} from 'lucide-react';

export interface FilePreviewProps {
  file: FileContentResult | null;
  sessionId?: string;
  isLoading: boolean;
  error?: string | null;
  onClose: () => void;
  onPromote?: (filePath: string) => void;
}

export function FilePreview({
  file,
  sessionId,
  isLoading,
  error,
  onClose,
  onPromote,
}: FilePreviewProps): React.JSX.Element | null {
  const [copiedContent, setCopiedContent] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [promoted, setPromoted] = useState(false);
  const [isPromoting, setIsPromoting] = useState(false);
  const [activeView, setActiveView] = useState<'preview' | 'raw'>('preview');


  if (!file && !isLoading && !error) {
    return null;
  }

  const handleCopyContent = () => {
    if (!file?.content || file.isBinary) return;
    navigator.clipboard.writeText(file.content);
    setCopiedContent(true);
    setTimeout(() => setCopiedContent(false), 2000);
  };

  const handleCopyPath = () => {
    if (!file?.path) return;
    navigator.clipboard.writeText(file.path);
    setCopiedPath(true);
    setTimeout(() => setCopiedPath(false), 2000);
  };

  const handlePromote = async () => {
    if (!file?.path) return;
    setIsPromoting(true);
    try {
      if (onPromote) {
        onPromote(file.path);
      } else if (sessionId && window.spawneaApi?.promoteToArtifact) {
        await window.spawneaApi.promoteToArtifact(sessionId, file.path);
      }
      setPromoted(true);
      setTimeout(() => setPromoted(false), 2500);
    } catch {
      // ignore
    } finally {
      setIsPromoting(false);
    }
  };

  const filename = file?.path.split('/').pop() || 'File Preview';
  const isImage = file?.mimeType?.startsWith('image/') || false;
  const isMarkdown = filename.endsWith('.md') || file?.mimeType === 'text/markdown';

  return (
    <div
      data-testid="file-preview-panel"
      className="h-full flex flex-col rounded-lg border border-[#30363d] bg-[#0d1117] overflow-hidden shadow-2xl"
    >
      {/* Header Bar */}
      <div className="px-4 py-2.5 bg-[#161b22] border-b border-[#30363d] flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {isImage ? (
            <ImageIcon className="w-4 h-4 text-purple-400 shrink-0" />
          ) : isMarkdown ? (
            <FileText className="w-4 h-4 text-blue-400 shrink-0" />
          ) : (
            <FileCode2 className="w-4 h-4 text-emerald-400 shrink-0" />
          )}
          <span className="font-mono text-xs font-semibold text-zinc-200 truncate" title={file?.path}>
            {filename}
          </span>
          {file?.mimeType && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-[#21262d] text-zinc-400 border border-[#30363d]">
              {file.mimeType.split('/').pop()?.toUpperCase()}
            </span>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-1.5 shrink-0">
          {isMarkdown && !file?.isBinary && (
            <div className="flex items-center bg-[#0d1117] rounded p-0.5 border border-[#30363d] mr-2">
              <button
                type="button"
                onClick={() => setActiveView('preview')}
                className={`px-2 py-0.5 text-[11px] font-medium rounded transition-colors cursor-pointer ${
                  activeView === 'preview' ? 'bg-[#21262d] text-emerald-400' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Rendered
              </button>
              <button
                type="button"
                onClick={() => setActiveView('raw')}
                className={`px-2 py-0.5 text-[11px] font-medium rounded transition-colors cursor-pointer ${
                  activeView === 'raw' ? 'bg-[#21262d] text-emerald-400' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Raw
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={handlePromote}
            disabled={isPromoting}
            data-testid="promote-to-artifact-button"
            title="Promote this file to Session Artifacts"
            className="flex items-center gap-1 px-2 py-1 bg-[#21262d] hover:bg-[#30363d] text-amber-300 hover:text-amber-200 rounded text-[11px] transition-colors cursor-pointer disabled:opacity-50"
          >
            {isPromoting ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : promoted ? (
              <Check className="w-3 h-3 text-emerald-400" />
            ) : (
              <Star className="w-3 h-3 text-amber-400 fill-amber-400/20" />
            )}
            <span>{promoted ? 'Promoted!' : 'Promote'}</span>
          </button>

          <button
            type="button"
            onClick={handleCopyPath}
            data-testid="copy-file-path-button"
            title="Copy file path"
            className="flex items-center gap-1 px-2 py-1 bg-[#21262d] hover:bg-[#30363d] text-zinc-300 rounded text-[11px] transition-colors cursor-pointer"
          >
            {copiedPath ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            <span>{copiedPath ? 'Copied Path' : 'Path'}</span>
          </button>

          {!file?.isBinary && (
            <button
              type="button"
              onClick={handleCopyContent}
              data-testid="copy-file-content-button"
              title="Copy file content"
              className="flex items-center gap-1 px-2 py-1 bg-[#21262d] hover:bg-[#30363d] text-zinc-300 rounded text-[11px] transition-colors cursor-pointer"
            >
              {copiedContent ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              <span>{copiedContent ? 'Copied' : 'Copy'}</span>
            </button>
          )}


          <button
            type="button"
            onClick={onClose}
            data-testid="close-preview-button"
            title="Close preview"
            className="p-1 hover:bg-[#21262d] text-zinc-400 hover:text-white rounded transition-colors cursor-pointer ml-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Warning Banners */}
      {file?.isTruncated && (
        <div className="px-4 py-1.5 bg-amber-950/40 border-b border-amber-800/40 text-amber-300 text-xs flex items-center gap-2 shrink-0">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <span>File is large ({formatBytes(file.sizeBytes)}) and was truncated for preview performance.</span>
        </div>
      )}

      {/* Main Preview Area */}
      <div className="flex-1 overflow-auto bg-[#0d1117] select-text">
        {isLoading ? (
          <div className="h-full flex items-center justify-center p-8 text-zinc-500 text-xs">
            <span className="animate-pulse">Loading file contents...</span>
          </div>
        ) : error ? (
          <div className="h-full flex flex-col items-center justify-center p-8 text-rose-400 text-xs">
            <AlertTriangle className="w-8 h-8 mb-2 opacity-80" />
            <p className="font-semibold">Failed to load preview</p>
            <p className="text-zinc-500 mt-1 text-[11px] max-w-sm text-center">{error}</p>
          </div>
        ) : isImage && file ? (
          <div className="h-full flex flex-col items-center justify-center p-6 bg-[#090d13]">
            <div className="p-2 bg-[#161b22] border border-[#30363d] rounded-lg shadow-lg max-w-full max-h-full flex items-center justify-center overflow-auto">
              <img
                src={file.content}
                alt={filename}
                className="max-w-full max-h-[60vh] object-contain rounded select-none"
              />
            </div>
            <p className="mt-3 text-[11px] text-zinc-500 font-mono">
              {filename} • {formatBytes(file.sizeBytes)}
            </p>
          </div>
        ) : file?.isBinary ? (
          <div className="h-full flex flex-col items-center justify-center p-8 text-zinc-500 text-xs">
            <FileQuestion className="w-10 h-10 text-zinc-600 mb-2" />
            <p className="text-zinc-300 font-medium">Binary file detected</p>
            <p className="text-[11px] text-zinc-500 mt-1">
              {filename} ({formatBytes(file.sizeBytes)}) cannot be displayed as plain text.
            </p>
          </div>
        ) : isMarkdown && activeView === 'preview' && file ? (
          <div className="p-6 max-w-4xl mx-auto text-zinc-200 text-sm leading-relaxed font-sans space-y-4">
            {renderSimpleMarkdown(file.content)}
          </div>
        ) : file ? (
          <CodeViewer filePath={file.path} content={file.content} />
        ) : null}
      </div>
    </div>
  );
}

function CodeViewer({
  filePath,
  content,
}: {
  filePath: string;
  content: string;
}): React.JSX.Element {
  const [copiedLine, setCopiedLine] = useState<number | null>(null);
  const lines = content.split('\n');

  const handleCopyLine = (lineNum: number) => {
    const ref = `${filePath}:${lineNum}`;
    navigator.clipboard.writeText(ref);
    setCopiedLine(lineNum);
    setTimeout(() => setCopiedLine(null), 2000);
  };

  return (
    <div className="font-mono text-xs py-2 text-zinc-200">
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, idx) => {
            const lineNum = idx + 1;
            const isCopied = copiedLine === lineNum;

            return (
              <tr key={idx} className="hover:bg-[#161b22]/70 group">
                <td
                  data-testid={`code-line-num-${lineNum}`}
                  onClick={() => handleCopyLine(lineNum)}
                  title={`Click to copy "${filePath}:${lineNum}"`}
                  className={`w-14 py-0.5 px-3 text-right select-none text-[11px] cursor-pointer transition-colors border-r border-[#21262d]/40 ${
                    isCopied
                      ? 'text-emerald-400 font-bold bg-emerald-950/40'
                      : 'text-zinc-600 group-hover:text-emerald-400 group-hover:bg-[#21262d]/50'
                  }`}
                >
                  {isCopied ? '✓' : lineNum}
                </td>
                <td className="py-0.5 px-3 whitespace-pre font-mono leading-relaxed select-text">
                  {line || ' '}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function renderSimpleMarkdown(md: string): React.JSX.Element[] {
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

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
