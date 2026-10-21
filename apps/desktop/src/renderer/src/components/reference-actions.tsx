import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArtifactPreviewModal } from './ArtifactPreviewModal';

export type Reference = { kind: 'url' | 'file'; text: string; start: number };
export type ReferenceContext = { workspacePath: string; homePath: string; persistedWorkspacePath?: string };

/** Pure lexical recognition, not artifact detection or a filesystem probe. */
export function findReferences(text: string, selected = false): Reference[] {
  const result: Reference[] = [];
  const pattern = /https?:\/\/[^\s<>"'`]+|"[^"\r\n]+"|'[^'\r\n]+'|(?:~\/|\.{0,2}\/)?[^\s<>"'`|()[\]{}]+/g;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const quoted = /^['"]/.test(raw);
    const value = quoted ? raw.slice(1, -1) : raw.replace(/[),.;!?]+$/, '');
    const kind = /^https?:\/\//.test(value) ? 'url' : 'file';
    if (kind === 'file' && (!/^(?:~\/|\/|\.\.?\/)/.test(value) && !/^[\w@+.-][\w@+./ -]*\.[a-zA-Z0-9]{1,12}$/.test(value))) continue;
    if (kind === 'file' && /[\s]/.test(value) && !quoted) continue;
    result.push({ kind, text: value, start: match.index! });
  }
  if (selected) {
    const value = text.trim().replace(/^(["'])(.*)\1$/, '$2');
    const multipleTargets = result.filter((item) => item.kind === 'url' || /\.[a-zA-Z0-9]{1,12}$/.test(item.text)).length > 1;
    if (!multipleTargets && !/[\r\n]/.test(value) && !/^https?:/.test(value) && /\s/.test(value) && /^(?:~\/|\/|\.\.?\/)|\.[a-zA-Z0-9]{1,12}$/.test(value) && !/["'<>|]/.test(value)) {
      return [{ kind: 'file', text: value, start: text.indexOf(text.trim()) }];
    }
  }
  return result;
}

export function isWorkspaceHtml(reference: string, context: ReferenceContext | null): boolean {
  if (!context || !/\.html?$/i.test(reference)) return false;
  const path = reference.startsWith('~/') ? `${context.homePath}/${reference.slice(2)}` : reference.startsWith('/') ? reference : `${context.workspacePath}/${reference}`;
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return `/${parts.join('/')}`.startsWith(`${context.workspacePath.replace(/\/+$/, '')}/`);
}

export function resolveArtifactReference(reference: string, context: ReferenceContext | null): string {
  if (!context?.persistedWorkspacePath) return reference;
  const persistedRoot = context.persistedWorkspacePath.replace(/\/+$/, '');
  if (reference !== persistedRoot && !reference.startsWith(`${persistedRoot}/`)) return reference;
  const suffix = reference.slice(persistedRoot.length).replace(/^\/+/, '');
  return suffix ? `${context.workspacePath.replace(/\/+$/, '')}/${suffix}` : context.workspacePath;
}

export function useReferenceContext(sessionId: string): ReferenceContext | null {
  const [state, setState] = useState<{ sessionId: string; value: ReferenceContext | null } | null>(null);
  useEffect(() => {
    let current = true;
    void window.spawneaApi?.getLocalReferenceContext?.(sessionId).then((value) => {
      if (current) setState({ sessionId, value });
    }).catch(() => { if (current) setState({ sessionId, value: null }); });
    return () => { current = false; };
  }, [sessionId]);
  return state?.sessionId === sessionId ? state.value : null;
}

export function ReferenceActions({ reference, context, sessionId, onPreview, onClose, onError }: {
  reference: Reference | null;
  context: ReferenceContext | null;
  sessionId: string;
  onPreview: (path: string) => void;
  onClose: () => void;
  onError: (message: string) => void;
}): React.JSX.Element | null {
  if (!reference || (reference.kind === 'file' && !context)) return null;
  const path = reference.text;
  const copy = (text: string) => window.spawneaApi.writeClipboardText(text);
  const actions: Array<[string, () => void | Promise<unknown>]> = reference.kind === 'url' ? [
    ['Copy URL', () => copy(path)],
    ['Open in Default Browser', () => window.spawneaApi.openExternalUrl(path)],
  ] : [
    ['Copy Full Path', async () => copy((await window.spawneaApi.getLocalReferencePaths(sessionId, path)).fullPath)],
    ['Copy Relative Path', async () => copy((await window.spawneaApi.getLocalReferencePaths(sessionId, path)).relativePath)],
    ['Open in Artifact Preview', () => onPreview(path)],
    ['Open with Default App', () => window.spawneaApi.openLocalReference(sessionId, path, false)],
    ...(isWorkspaceHtml(path, context) ? [['Open with Default Browser', () => window.spawneaApi.openLocalReference(sessionId, path, true)] as [string, () => Promise<void>]] : []),
  ];
  return <>{actions.map(([label, action]) => <button key={label} type="button" role="menuitem" className="w-full px-3 py-1.5 text-left hover:bg-emerald-600 cursor-pointer" onClick={() => {
    onClose();
    void Promise.resolve().then(action).catch((error) => onError(error instanceof Error ? error.message : 'Reference action failed'));
  }}>{label}</button>)}<div className="my-1 border-t border-[#30363d]" /></>;
}

export function ReferencePreview({ path, sessionId, onClose }: { path: string; sessionId: string; onClose: () => void }): React.JSX.Element {
  const filename = path.split('/').pop() || path;
  const artifact = React.useMemo(() => ({ id: `reference:${path}`, sessionId, filename, remotePath: path, direction: 'output' as const, mimeType: '', sizeBytes: 0, createdAt: new Date(0) }), [filename, path, sessionId]);
  return createPortal(<ArtifactPreviewModal artifact={artifact} referencePath={path} sessionId={sessionId} onClose={onClose} />, document.body);
}
