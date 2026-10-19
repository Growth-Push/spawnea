import React from 'react';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './MarkdownPreview.css';

/** Read-only Markdown. Remote media and raw HTML never load in previews. */
export function MarkdownPreview({ content }: { content: string }): React.JSX.Element {
  return (
    <article className="markdown-preview" aria-label="Markdown document">
      <Markdown
        remarkPlugins={[remarkGfm]}
        // Destinations only reach inert text spans; preserve local/custom schemes.
        // Keep the library's default filtering for image sources and other URLs.
        urlTransform={(url, key) => key === 'href' ? url : defaultUrlTransform(url)}
        components={{
          // Keep destinations readable without navigating the Electron renderer.
          a: ({ children, href }) => <span className="markdown-link" title={href}>{children}{href && <span className="markdown-link-destination"> ({href})</span>}</span>,
          img: ({ alt }) => <span className="markdown-image">[Image: {alt || 'No description'}]</span>,
          table: ({ children }) => <div className="markdown-table-scroll"><table>{children}</table></div>,
        }}
      >
        {content}
      </Markdown>
    </article>
  );
}
