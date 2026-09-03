import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import {
  Sidebar,
  DENSE_SESSION_THRESHOLD,
  formatSessionPath,
  HostHealthDot,
  SESSION_PATH_MAX_LENGTH,
  STORAGE_KEY_SESSION_LAYOUT,
} from './Sidebar';
import type { Session, Server, Project, Agent, HostHealthResult } from '@spawnea/domain';

const mockServers: Server[] = [
  {
    id: 'srv-local',
    name: 'Local Workstation',
    host: 'localhost',
    sshPort: 22,
    enabled: true,
    createdAt: new Date(),
  },
  {
    id: 'srv-remote',
    name: 'GPU Cloud Cluster',
    host: 'gpu.example.test',
    sshPort: 22,
    enabled: true,
    createdAt: new Date(),
  },
];

const mockProjects: Project[] = [
  {
    id: 'proj-1',
    serverId: 'srv-local',
    name: 'Spawnea',
    rootPath: '/workspace/spawnea',
    createdAt: new Date(),
  },
];

const mockAgents: Agent[] = [
  {
    id: 'agent-1',
    name: 'Claude Code',
    harness: 'claude',
    command: 'claude',
    createdAt: new Date(),
  },
];

const mockSessions: Session[] = [
  {
    id: 'sess-1',
    name: 'Fix parallel health checking',
    serverId: 'srv-local',
    projectId: 'proj-1',
    agentId: 'agent-1',
    task: 'Fix parallel health checking',
    worktreePath: '/workspace/spawnea',
    branch: 'main',
    managedWorktree: true,
    tmuxSessionName: 'spawnea-sess-1',
    status: 'working',
    createdAt: new Date(),
    lastActivityAt: new Date(),
  },
];

const makeSessions = (count: number): Session[] => Array.from({ length: count }, (_, index) => ({
  ...mockSessions[0],
  id: `sess-${String(index + 1).padStart(2, '0')}`,
  name: `Session ${String(index + 1).padStart(2, '0')}`,
  task: `Task ${index + 1}`,
  branch: `spawnea/task-${index + 1}`,
  tmuxSessionName: `spawnea-session-${index + 1}`,
  status: index === 1 ? 'needs_input' : index === 2 ? 'idle' : 'working',
  managedWorktree: index % 2 === 0,
}));

const renderSidebar = (
  sessions: Session[],
  options: {
    onSelectSession?: (id: string) => void;
    activeSessionId?: string | null;
    gitDirtyBySessionId?: Record<string, boolean>;
    gitChangeCountBySessionId?: Record<string, number>;
    isCollapsed?: boolean;
  } = {}
) => render(
  <Sidebar
    sessions={sessions}
    servers={mockServers}
    projects={mockProjects}
    agents={mockAgents}
    gitDirtyBySessionId={options.gitDirtyBySessionId}
    gitChangeCountBySessionId={options.gitChangeCountBySessionId}
    activeSessionId={options.activeSessionId ?? sessions[0]?.id ?? null}
    onSelectSession={options.onSelectSession ?? vi.fn()}
    onOpenCreateModal={vi.fn()}
    onRefresh={vi.fn()}
    isCollapsed={options.isCollapsed}
  />
);

beforeEach(() => {
  localStorage.clear();
});

describe('formatSessionPath', () => {
  it('leaves paths at or below the visible limit unchanged', () => {
    expect(formatSessionPath('/workspace/code')).toBe('/workspace/code');
  });

  it('abbreviates parent folders while preserving the final folder', () => {
    expect(formatSessionPath(
      '/workspace/spawnea-worktrees/fixovertext-mtcm12u3-vq4l'
    )).toBe('/w/s/fixovertext-mtcm12u3-vq4l');
  });

  it('adds a trailing ellipsis when the abbreviated path is still too long', () => {
    const formatted = formatSessionPath(
      '/workspace/spawnea-worktrees/a-very-long-worktree-folder-name-that-still-does-not-fit'
    );

    expect(formatted).toHaveLength(SESSION_PATH_MAX_LENGTH);
    expect(formatted).toBe('/w/s/a-very-long-worktree-folder-name...');
  });
});

describe('HostHealthDot', () => {
  it('renders healthy status with latency', () => {
    const health: HostHealthResult = {
      hostId: 'srv-local',
      target: 'localhost',
      status: 'healthy',
      latencyMs: 15,
      lastCheckedAt: new Date().toISOString(),
    };

    render(<HostHealthDot health={health} showLatency={true} />);
    const dot = screen.getByTestId('host-health-dot-srv-local');
    expect(dot).toBeDefined();
    expect(dot.getAttribute('data-status')).toBe('healthy');
    expect(screen.getByText('15ms')).toBeDefined();
  });

  it('renders degraded status', () => {
    const health: HostHealthResult = {
      hostId: 'srv-remote',
      target: 'gpu.example.test',
      status: 'degraded',
      latencyMs: 380,
      lastCheckedAt: new Date().toISOString(),
    };

    render(<HostHealthDot health={health} showLatency={true} />);
    const dot = screen.getByTestId('host-health-dot-srv-remote');
    expect(dot).toBeDefined();
    expect(dot.getAttribute('data-status')).toBe('degraded');
    expect(screen.getByText('380ms')).toBeDefined();
  });

  it('renders unreachable status without latency text', () => {
    const health: HostHealthResult = {
      hostId: 'srv-offline',
      target: 'offline.example.test',
      status: 'unreachable',
      error: 'Connection timed out',
      lastCheckedAt: new Date().toISOString(),
    };

    render(<HostHealthDot health={health} showLatency={true} />);
    const dot = screen.getByTestId('host-health-dot-srv-offline');
    expect(dot).toBeDefined();
    expect(dot.getAttribute('data-status')).toBe('unreachable');
    expect(screen.queryByText(/ms/)).toBeNull();
  });
});

describe('Sidebar session title overflow', () => {
  const longTitle = 'Add an uncommitted-changes icon to the Spawnea worktree tab without covering any controls';

  it('contains and truncates a comfortable title while preserving status, shortcut, and tooltip', () => {
    const session = { ...mockSessions[0], name: longTitle };
    renderSidebar([session]);

    const title = screen.getByTestId('session-title-sess-1');
    expect(title.textContent).toBe(longTitle);
    expect(title.getAttribute('title')).toBe(longTitle);
    expect(title.className).toContain('min-w-0');
    expect(title.className).toContain('max-w-full');
    expect(title.className).toContain('truncate');
    expect(title.parentElement?.className).toContain('overflow-hidden');
    expect(screen.getByTestId('session-item-sess-1').querySelector('[data-testid="status-badge-working"]')).not.toBeNull();
    expect(screen.getByTestId('session-shortcut-badge-sess-1').textContent).toBe('Ctrl-1');
    expect(session.name).toBe(longTitle);
  });

  it('truncates a dense title to one line inside its column while preserving status and shortcut', () => {
    localStorage.setItem(STORAGE_KEY_SESSION_LAYOUT, 'dense');
    renderSidebar([{ ...mockSessions[0], name: longTitle }]);

    const title = screen.getByTestId('session-dense-title-sess-1');
    expect(title.textContent).toBe(longTitle);
    expect(title.getAttribute('title')).toBe(longTitle);
    expect(title.className).toContain('truncate');
    expect(title.className).toContain('block');
    expect(title.className).toContain('max-w-full');
    expect(title.parentElement?.className).toContain('overflow-hidden');
    expect(screen.getByTestId('session-item-sess-1').querySelector('[data-testid="status-badge-working"]')).not.toBeNull();
    expect(screen.getByTestId('session-dense-shortcut-sess-1').textContent).toBe('1');
    expect(screen.getByTestId('session-dense-shortcut-sess-1').getAttribute('title')).toBe('Keyboard shortcut: Ctrl-1');
  });

  it('contains the compact hover-card title and keeps icon status and shortcut available', () => {
    renderSidebar([{ ...mockSessions[0], name: longTitle }], { isCollapsed: true });

    const title = screen.getByTestId('session-compact-title-sess-1');
    const button = screen.getByTestId('session-item-sess-1');
    expect(title.textContent).toBe(longTitle);
    expect(title.getAttribute('title')).toBe(longTitle);
    expect(title.className).toContain('min-w-0');
    expect(title.className).toContain('max-w-full');
    expect(title.className).toContain('truncate');
    expect(title.parentElement?.className).toContain('overflow-hidden');
    expect(button.getAttribute('title')).toContain(longTitle);
    expect(button.getAttribute('title')).toContain('Ctrl-1');
    expect(screen.getByTestId('session-compact-status-sess-1')).toBeDefined();
    expect(screen.getByTestId('session-compact-shortcut-sess-1').textContent).toBe('1');
  });
});

describe('Sidebar with Parallel Host Health Indicators', () => {
  it('exposes local discovery as an explicit menu item', () => {
    const onOpenLocalDiscovery = vi.fn();
    render(
      <Sidebar
        sessions={mockSessions}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
        activeSessionId="sess-1"
        onSelectSession={vi.fn()}
        onOpenCreateModal={vi.fn()}
        onRefresh={vi.fn()}
        onOpenLocalDiscovery={onOpenLocalDiscovery}
      />
    );
    fireEvent.click(screen.getByTestId('sidebar-actions-menu-button'));
    expect(screen.queryByText(/Report state detection issue/i)).toBeNull();
    fireEvent.click(screen.getByTestId('sidebar-local-discovery-button'));
    expect(onOpenLocalDiscovery).toHaveBeenCalledTimes(1);
  });

  it('labels managed worktree sessions', () => {
    render(
      <Sidebar
        sessions={mockSessions}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
        activeSessionId="sess-1"
        onSelectSession={vi.fn()}
        onOpenCreateModal={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.getByTestId('session-worktree-badge-sess-1')).toBeDefined();
  });

  it('shows the dirty indicator for non-managed sessions and not for clean managed sessions', () => {
    const cleanManagedSession = {
      ...mockSessions[0],
      id: 'sess-managed-clean',
      name: 'Clean managed worktree',
      tmuxSessionName: 'spawnea-managed-clean',
      managedWorktree: true,
    };
    const dirtyNonManagedSession = {
      ...mockSessions[0],
      id: 'sess-non-managed-dirty',
      name: 'Dirty project root',
      tmuxSessionName: 'spawnea-non-managed-dirty',
      managedWorktree: false,
    };

    renderSidebar([mockSessions[0], cleanManagedSession, dirtyNonManagedSession], {
      gitDirtyBySessionId: {
        'sess-1': true,
        'sess-managed-clean': false,
        'sess-non-managed-dirty': true,
      },
    });

    expect(screen.getByTestId('session-worktree-dirty-indicator-sess-1')).toBeDefined();
    expect(screen.getByTestId('session-git-dirty-indicator-sess-non-managed-dirty')).toBeDefined();
    expect(screen.queryByTestId('session-worktree-dirty-indicator-sess-managed-clean')).toBeNull();
    expect(screen.getByTestId('session-worktree-badge-sess-1').getAttribute('title'))
      .toContain('Uncommitted Git changes');
  });

  it('shows an abbreviated long path while retaining the full path as its title', () => {
    const longPath = '/workspace/spawnea-worktrees/fixovertext-mtcm12u3-vq4l';
    renderSidebar([{ ...mockSessions[0], worktreePath: longPath }]);

    const path = screen.getByTestId('session-path-sess-1');
    expect(path.textContent).toBe('/w/s/fixovertext-mtcm12u3-vq4l');
    expect(path.getAttribute('title')).toBe(longPath);
  });

  it('shows the Git change count in the collapsed session popup', () => {
    renderSidebar(mockSessions, {
      isCollapsed: true,
      gitDirtyBySessionId: { 'sess-1': true },
      gitChangeCountBySessionId: { 'sess-1': 4 },
    });

    expect(screen.getByTestId('session-compact-worktree-change-count-sess-1').textContent).toBe('4');
  });

  it('renders host health dots in server inventory popup', () => {
    const hostHealthMap: Record<string, HostHealthResult> = {
      'srv-local': {
        hostId: 'srv-local',
        target: 'localhost',
        status: 'healthy',
        latencyMs: 12,
        lastCheckedAt: new Date().toISOString(),
      },
      'srv-remote': {
        hostId: 'srv-remote',
        target: 'gpu.example.test',
        status: 'unreachable',
        error: 'SSH connection timeout',
        lastCheckedAt: new Date().toISOString(),
      },
    };

    render(
      <Sidebar
        sessions={mockSessions}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
        hostHealthMap={hostHealthMap}
        activeSessionId="sess-1"
        onSelectSession={vi.fn()}
        onOpenCreateModal={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    const localDot = screen.getByTestId('host-health-dot-srv-local');
    expect(localDot).toBeDefined();
    expect(localDot.getAttribute('data-status')).toBe('healthy');

    const remoteDot = screen.getByTestId('host-health-dot-srv-remote');
    expect(remoteDot).toBeDefined();
    expect(remoteDot.getAttribute('data-status')).toBe('unreachable');
  });

  it('triggers onCheckHostHealth when connectivity refresh button is clicked', () => {
    const onCheckHostHealth = vi.fn();

    render(
      <Sidebar
        sessions={mockSessions}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
        activeSessionId="sess-1"
        onSelectSession={vi.fn()}
        onOpenCreateModal={vi.fn()}
        onRefresh={vi.fn()}
        onCheckHostHealth={onCheckHostHealth}
      />
    );

    const refreshButton = screen.getByTitle('Check host connectivity now');
    expect(refreshButton).toBeDefined();
    fireEvent.click(refreshButton);

    expect(onCheckHostHealth).toHaveBeenCalledTimes(1);
  });
});

describe('Sidebar dense session layout', () => {
  it('uses the documented auto threshold for predictable layout changes', () => {
    const { rerender } = renderSidebar(makeSessions(DENSE_SESSION_THRESHOLD - 1));
    expect(screen.getByTestId('session-list').getAttribute('data-layout')).toBe('comfortable');
    expect(screen.getByTestId('session-flat-layout').className).not.toContain('grid-cols-3');

    const largeSessions = makeSessions(DENSE_SESSION_THRESHOLD);
    rerender(
      <Sidebar
        sessions={largeSessions}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
        activeSessionId={largeSessions[0].id}
        onSelectSession={vi.fn()}
        onOpenCreateModal={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.getByTestId('session-list').getAttribute('data-layout')).toBe('dense');
    expect(screen.getByTestId('session-flat-layout').className).toContain('grid-cols-3');
    expect(screen.getByTestId('session-list').className).toContain('overflow-x-hidden');
  });

  it('persists explicit comfortable and dense preferences', () => {
    renderSidebar(makeSessions(DENSE_SESSION_THRESHOLD + 2));
    fireEvent.click(screen.getByTestId('session-layout-comfortable'));

    expect(screen.getByTestId('session-list').getAttribute('data-layout')).toBe('comfortable');
    expect(localStorage.getItem(STORAGE_KEY_SESSION_LAYOUT)).toBe('comfortable');

    fireEvent.click(screen.getByTestId('session-layout-dense'));
    expect(screen.getByTestId('session-list').getAttribute('data-layout')).toBe('dense');
    expect(localStorage.getItem(STORAGE_KEY_SESSION_LAYOUT)).toBe('dense');
  });

  it('honors a saved dense preference for a small session count', () => {
    localStorage.setItem(STORAGE_KEY_SESSION_LAYOUT, 'dense');
    renderSidebar(makeSessions(2));

    expect(screen.getByTestId('sidebar').getAttribute('data-session-layout-preference')).toBe('dense');
    expect(screen.getByTestId('session-list').getAttribute('data-layout')).toBe('dense');
    expect(screen.getByTestId('session-layout-dense').getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps status and worktree identity visible on dense cards', () => {
    renderSidebar(makeSessions(DENSE_SESSION_THRESHOLD), {
      gitDirtyBySessionId: { 'sess-01': true, 'sess-02': true, 'sess-03': false },
    });

    expect(screen.getByTestId('session-dense-worktree-badge-sess-01')).toBeDefined();
    expect(screen.getByTestId('session-dense-worktree-dirty-indicator-sess-01')).toBeDefined();
    expect(screen.getByTestId('session-dense-git-dirty-indicator-sess-02')).toBeDefined();
    expect(screen.queryByTestId('session-dense-worktree-dirty-indicator-sess-03')).toBeNull();
    expect(screen.getByTestId('session-item-sess-02').textContent).toContain('Session 02');
    expect(screen.getByTestId('session-item-sess-02').querySelector('[data-testid="status-badge-needs_input"]')).not.toBeNull();
  });

  it('shows secondary metadata on mouse hover and keyboard focus', () => {
    renderSidebar(makeSessions(DENSE_SESSION_THRESHOLD));
    const card = screen.getByTestId('session-item-sess-01');

    fireEvent.mouseEnter(screen.getByTestId('session-dense-item-sess-01'));
    expect(screen.getByTestId('session-dense-details-sess-01').textContent).toContain('Branch: spawnea/task-1');
    fireEvent.mouseLeave(screen.getByTestId('session-dense-item-sess-01'));
    expect(screen.queryByTestId('session-dense-details-sess-01')).toBeNull();

    act(() => card.focus());
    expect(document.activeElement).toBe(card);
    expect(card.tagName).toBe('BUTTON');
    expect(screen.getByTestId('session-dense-details-sess-01').textContent).toContain('tmux: spawnea-session-1');

    const secondCardWrapper = screen.getByTestId('session-dense-item-sess-02');
    fireEvent.mouseEnter(secondCardWrapper);
    expect(screen.getByTestId('session-dense-details-sess-02')).toBeDefined();
    fireEvent.mouseLeave(secondCardWrapper);
    expect(screen.getByTestId('session-dense-details-sess-01')).toBeDefined();
  });

  it('keeps filtering, sorting, and direct activation intact in explicit dense mode', () => {
    const onSelectSession = vi.fn();
    const sessions = makeSessions(10).reverse();
    renderSidebar(sessions, { onSelectSession });
    fireEvent.click(screen.getByTestId('session-layout-dense'));

    const layout = screen.getByTestId('session-flat-layout');
    expect(layout.firstElementChild?.getAttribute('data-testid')).toBe('session-dense-item-sess-01');

    fireEvent.change(screen.getByPlaceholderText('Filter sessions...'), {
      target: { value: 'Session 10' },
    });
    expect(screen.getByTestId('session-list').getAttribute('data-layout')).toBe('dense');
    expect(screen.queryByTestId('session-item-sess-01')).toBeNull();

    fireEvent.click(screen.getByTestId('session-item-sess-10'));
    expect(onSelectSession).toHaveBeenCalledWith('sess-10');
  });
});

describe('Sidebar MCP source badge', () => {
  it('shows the source badge for MCP-created sessions and not UI-created sessions', () => {
    const mcpSession = {
      ...mockSessions[0],
      id: 'sess-mcp',
      name: 'MCP session',
      creationSource: 'mcp' as const,
    };
    const uiSession = {
      ...mockSessions[0],
      id: 'sess-ui',
      name: 'UI session',
      creationSource: 'ui' as const,
    };

    renderSidebar([mcpSession, uiSession]);

    expect(
      screen.getByTestId('session-item-sess-mcp').querySelector('[data-testid="mcp-session-badge"]')
    ).not.toBeNull();
    expect(
      screen.getByTestId('session-item-sess-ui').querySelector('[data-testid="mcp-session-badge"]')
    ).toBeNull();
  });
});
