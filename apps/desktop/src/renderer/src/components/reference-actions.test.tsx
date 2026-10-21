import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { findReferences, isWorkspaceHtml, ReferenceActions, ReferencePreview, resolveArtifactReference } from './reference-actions';

const context = { workspacePath: '/workspace', homePath: '/fictional-host-home' };

describe('reference actions', () => {
  it('resolves persisted artifact locators only at the Artifacts surface with a segment boundary', () => {
    const artifactContext = { workspacePath: '/runtime/worktree', homePath: '/fictional-host-home', persistedWorkspacePath: 'catalog-project://host/project' };
    expect(resolveArtifactReference('catalog-project://host/project/docs/a.md', artifactContext)).toBe('/runtime/worktree/docs/a.md');
    expect(resolveArtifactReference('catalog-project://host/project-other/a.md', artifactContext)).toBe('catalog-project://host/project-other/a.md');
    expect(resolveArtifactReference('/outside/file.png', artifactContext)).toBe('/outside/file.png');
    expect(resolveArtifactReference('catalog-project://host/project/docs/a.md', context)).toBe('catalog-project://host/project/docs/a.md');
  });

  it('passes the translated artifact path to local reference actions', async () => {
    const artifactContext = { workspacePath: '/runtime/worktree', homePath: '/fictional-host-home', persistedWorkspacePath: 'catalog-project://host/project' };
    const reference = resolveArtifactReference('catalog-project://host/project/docs/a.md', artifactContext);
    const api = { getLocalReferencePaths: vi.fn().mockResolvedValue({ fullPath: reference, relativePath: 'docs/a.md' }), writeClipboardText: vi.fn().mockResolvedValue(undefined) };
    window.spawneaApi = api as any;
    render(<ReferenceActions reference={{ kind: 'file', text: reference, start: 0 }} context={artifactContext} sessionId="s" onPreview={vi.fn()} onClose={vi.fn()} onError={vi.fn()} />);
    fireEvent.click(screen.getByText('Copy Full Path'));
    await waitFor(() => expect(api.getLocalReferencePaths).toHaveBeenCalledWith('s', '/runtime/worktree/docs/a.md'));
    expect(api.writeClipboardText).toHaveBeenCalledWith('/runtime/worktree/docs/a.md');
  });
  it('recognizes URLs, quoted paths, and complete selected paths without probing files', () => {
    expect(findReferences('Visit https://example.com/a, "notes with spaces.md" ~/report.txt')).toEqual([
      { kind: 'url', text: 'https://example.com/a', start: 6 },
      { kind: 'file', text: 'notes with spaces.md', start: 29 },
      { kind: 'file', text: '~/report.txt', start: 52 },
    ]);
    expect(findReferences('/workspace/notes with spaces.md', true)).toEqual([{ kind: 'file', text: '/workspace/notes with spaces.md', start: 0 }]);
    expect(findReferences('ordinary words')).toEqual([]);
  });

  it('offers only URL actions remotely and does nothing on menu display', async () => {
    const openExternalUrl = vi.fn().mockResolvedValue(true);
    const writeClipboardText = vi.fn().mockResolvedValue(undefined);
    window.spawneaApi = { openExternalUrl, writeClipboardText } as any;
    render(<ReferenceActions reference={{ kind: 'url', text: 'https://example.com', start: 0 }} context={null} sessionId="s" onPreview={vi.fn()} onClose={vi.fn()} onError={vi.fn()} />);
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(writeClipboardText).not.toHaveBeenCalled();
    expect(screen.queryByText('Copy Full Path')).toBeNull();
    fireEvent.click(screen.getByText('Copy URL'));
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith('https://example.com'));
  });

  it('copies resolved paths, previews without registration, and explicitly opens the original', async () => {
    const api = { getLocalReferencePaths: vi.fn().mockResolvedValue({ fullPath: '/workspace/a.md', relativePath: 'a.md' }), writeClipboardText: vi.fn().mockResolvedValue(undefined), openLocalReference: vi.fn().mockResolvedValue(undefined) };
    window.spawneaApi = api as any;
    const onPreview = vi.fn();
    render(<ReferenceActions reference={{ kind: 'file', text: 'a.md', start: 0 }} context={context} sessionId="s" onPreview={onPreview} onClose={vi.fn()} onError={vi.fn()} />);
    expect(api.getLocalReferencePaths).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Copy Relative Path'));
    await waitFor(() => expect(api.writeClipboardText).toHaveBeenCalledWith('a.md'));
    fireEvent.click(screen.getByText('Copy Full Path'));
    await waitFor(() => expect(api.writeClipboardText).toHaveBeenCalledWith('/workspace/a.md'));
    fireEvent.click(screen.getByText('Open in Artifact Preview'));
    await waitFor(() => expect(onPreview).toHaveBeenCalledWith('a.md'));
    fireEvent.click(screen.getByText('Open with Default App'));
    await waitFor(() => expect(api.openLocalReference).toHaveBeenCalledWith('s', 'a.md', false));
    expect(screen.queryByText('Open with Default Browser')).toBeNull();
  });

  it('keeps HTML external to the workspace out of the browser menu', () => {
    expect(isWorkspaceHtml('a.html', context)).toBe(true);
    expect(isWorkspaceHtml('/workspace/sub/../a.htm', context)).toBe(true);
    expect(isWorkspaceHtml('../a.html', context)).toBe(false);
    expect(isWorkspaceHtml('~/a.html', context)).toBe(false);
    expect(isWorkspaceHtml('/workspace-other/a.html', context)).toBe(false);
  });

  it('loads the real reference through the existing inert preview, not an artifact ID', async () => {
    const getLocalReferenceContent = vi.fn().mockResolvedValue({ path: '/workspace/a.html', content: '<script>window.bad=true</script>', isBinary: false, isTruncated: false, sizeBytes: 32, mimeType: 'text/html' });
    const getArtifactContent = vi.fn();
    window.spawneaApi = { getLocalReferenceContent, getArtifactContent } as any;
    render(<ReferencePreview path="a.html" sessionId="s" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('<script>window.bad=true</script>')).toBeTruthy());
    expect(getLocalReferenceContent).toHaveBeenCalledWith('s', 'a.html');
    expect(getArtifactContent).not.toHaveBeenCalled();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('Local reference')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reference Path' }).title).toBe('Copy local reference path');
    expect(screen.queryByText('Remote Path')).toBeNull();
    expect(screen.queryByText('output')).toBeNull();
  });

  it('does not reload or reset zoom when its parent rerenders', async () => {
    const getLocalReferenceContent = vi.fn().mockResolvedValue({ path: '/workspace/a.png', content: 'data:image/png;base64,iVBORw0KGgo=', isBinary: true, isTruncated: false, sizeBytes: 12, mimeType: 'image/png' });
    window.spawneaApi = { getArtifactContent: vi.fn(), getLocalReferenceContent } as any;
    const { rerender } = render(<ReferencePreview path="a.md" sessionId="s" onClose={vi.fn()} />);
    await screen.findByRole('img');
    fireEvent.click(screen.getByTitle('Zoom In'));
    rerender(<ReferencePreview path="a.md" sessionId="s" onClose={vi.fn()} />);
    expect(getLocalReferenceContent).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Zoom: 125%')).toBeTruthy();
  });
});
