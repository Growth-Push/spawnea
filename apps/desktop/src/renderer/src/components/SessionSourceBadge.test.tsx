import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionSourceBadge } from './SessionSourceBadge';

describe('SessionSourceBadge', () => {
  it('renders an accessible MCP badge only for explicitly MCP-created sessions', () => {
    render(<SessionSourceBadge session={{ creationSource: 'mcp' }} />);

    expect(screen.getByTestId('mcp-session-badge').textContent).toBe('MCP');
    expect(screen.getByRole('img', { name: 'Created through Spawnea MCP' })).toBeDefined();
  });

  it('does not infer MCP origin from a title or task', () => {
    render(<SessionSourceBadge session={{ creationSource: 'ui' }} />);

    expect(screen.queryByTestId('mcp-session-badge')).toBeNull();
  });
});
