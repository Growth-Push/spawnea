import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Artifact, FileContentResult } from '@spawnea/domain';
import { FilePreview } from './FilePreview';
import { ArtifactPreviewModal } from './ArtifactPreviewModal';
import { MarkdownPreview } from './MarkdownPreview';

const content = `# Reading guide

A **clear paragraph** with *emphasis* and \`inline code\`.
This continues the same paragraph.

## Checklist

1. First item
   - Nested item
2. Second item

- [x] Reviewed
- [ ] Pending

> A useful quotation.

| Feature | Status |
| --- | --- |
| Preview | Ready |

~~~ts
const value = '<safe>';
~~~

[Reference](https://example.com/guide)
`;
const file: FileContentResult = {
  path: '/repo/guide.md', content, mimeType: 'text/markdown',
  sizeBytes: content.length, isBinary: false, isTruncated: false,
};
const artifact: Artifact = {
  id: 'document', sessionId: 'session', direction: 'output',
  remotePath: file.path, filename: 'guide.md', mimeType: 'text/markdown',
  sizeBytes: file.sizeBytes, createdAt: new Date(),
};

afterEach(cleanup);

describe('Markdown reading in document previews', () => {
  for (const surface of ['workspace', 'artifact'] as const) {
    it(`preserves structure and raw access in the ${surface} preview`, async () => {
      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
      if (surface === 'workspace') {
        render(<FilePreview file={file} isLoading={false} onClose={vi.fn()} />);
      } else {
        Object.assign(window, { spawneaApi: { getArtifactContent: vi.fn().mockResolvedValue(file) } });
        render(<ArtifactPreviewModal artifact={artifact} sessionId="session" onClose={vi.fn()} />);
      }
      const document = await screen.findByRole('article', { name: 'Markdown document' });
      const view = within(document);
      expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Reading guide');
      expect(view.getByText('clear paragraph').tagName).toBe('STRONG');
      expect(view.getByText('emphasis').tagName).toBe('EM');
      expect(document.querySelector('ol > li > ul > li')?.textContent).toBe('Nested item');
      expect(view.getByRole('table')).toBeDefined();
      expect(view.getAllByRole('checkbox').map((box) => (box as HTMLInputElement).disabled)).toEqual([true, true]);
      expect(document.querySelector('pre code')?.textContent).toContain("const value = '<safe>';");
      expect(view.getByText('Reference')).toBeDefined();
      expect(document.querySelector('a')).toBeNull();
      fireEvent.click(screen.getByTestId(surface === 'workspace' ? 'copy-file-content-button' : 'copy-artifact-content-button'));
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(content);
      fireEvent.click(screen.getByRole('button', { name: surface === 'workspace' ? 'Raw' : 'Raw Code' }));
      expect(screen.queryByRole('article')).toBeNull();
      expect(screen.getByText('# Reading guide')).toBeDefined();
    });
  }

  it('never creates active HTML, remote media, or navigable unsafe links', () => {
    const { container } = render(<MarkdownPreview content={'<script>alert(1)</script>\n\n<iframe src="https://example.com"></iframe>\n\n![Tracking](https://example.com/pixel.png)\n\n[Unsafe](javascript:alert%281%29)\n\n[File](file:///private/document.md)\n\n[Remote](ssh://example.com/repo/guide.md)\n\n[Vault](obsidian://open?vault=example)'} />);
    expect(container.querySelector('script, iframe, img, a, object, embed')).toBeNull();
    expect(screen.getByText('[Image: Tracking]')).toBeDefined();
    expect(screen.getByText('Unsafe')).toBeDefined();
    for (const destination of [
      'javascript:alert%281%29',
      'file:///private/document.md',
      'ssh://example.com/repo/guide.md',
      'obsidian://open?vault=example',
    ]) {
      expect(screen.getByTitle(destination).tagName).toBe('SPAN');
      expect(screen.getByText(`(${destination})`)).toBeDefined();
    }
  });

  it('keeps unavailable-file errors visible', async () => {
    Object.assign(window, { spawneaApi: { getArtifactContent: vi.fn().mockRejectedValue(new Error('Document unavailable')) } });
    render(<ArtifactPreviewModal artifact={artifact} sessionId="session" onClose={vi.fn()} />);
    expect(await screen.findByText('Document unavailable')).toBeDefined();
    expect(screen.queryByRole('article')).toBeNull();
  });
});
