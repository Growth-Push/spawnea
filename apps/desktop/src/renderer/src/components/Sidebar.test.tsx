import React from 'react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import {
  Sidebar,
  summarizeChildStatuses,
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
    onOpenCreateChildModal?: (parentSessionId?: string) => void;
    onOpenAgentSetup?: () => void;
    refreshingSessionIds?: ReadonlySet<string>;
    wrapper?: React.JSXElementConstructor<{ children: React.ReactNode }>;
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
    onOpenCreateChildModal={options.onOpenCreateChildModal}
    onOpenAgentSetup={options.onOpenAgentSetup}
    onRefresh={vi.fn()}
    isCollapsed={options.isCollapsed}
    refreshingSessionIds={options.refreshingSessionIds}
  />,
  { wrapper: options.wrapper }
);

beforeEach(() => {
  localStorage.clear();
});

describe('compact popup interaction', () => {
  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 100, top: 100, bottom: 400, left: 0, right: 64,
      width: 64, height: 300, toJSON: () => ({}),
    });
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('portals outside the scrolling list and retains hover across the popup boundary', () => {
    renderSidebar(mockSessions, { isCollapsed: true });
    const card = screen.getByTestId('session-compact-item-sess-1');
    const popup = screen.getByTestId('session-popup-sess-1');
    expect(popup.parentElement).toBe(document.body);
    expect(screen.getByTestId('session-list').contains(popup)).toBe(false);
    fireEvent.mouseEnter(card);
    expect(popup.style.display).toBe('flex');
    fireEvent.mouseLeave(card, { relatedTarget: popup });
    expect(popup.style.display).toBe('flex');
    fireEvent.mouseLeave(popup, { relatedTarget: document.body });
    expect(popup.style.display).toBe('none');
  });

  it('opens on focus and lets Tab and Shift+Tab cross the portal boundary', () => {
    renderSidebar([...mockSessions, {
      ...mockSessions[0], id: 'child-focus', parentSessionId: 'sess-1', childAlias: 'child-1',
    }], { isCollapsed: true });
    const trigger = screen.getByTestId('session-item-sess-1');
    const popup = screen.getByTestId('session-popup-sess-1');
    act(() => trigger.focus());
    expect(popup.style.display).toBe('flex');
    fireEvent.keyDown(trigger, { key: 'Tab' });
    expect(popup.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(trigger);
    act(() => trigger.blur());
    expect(popup.style.display).toBe('none');
  });

  it('reanchors on scroll and resize and hides when its session leaves the list', () => {
    renderSidebar(mockSessions, { isCollapsed: true });
    const card = screen.getByTestId('session-compact-item-sess-1');
    const popup = screen.getByTestId('session-popup-sess-1');
    const rect = { x: 0, y: 150, top: 150, bottom: 190, left: 0, right: 64,
      width: 64, height: 40, toJSON: () => ({}) };
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return this === card ? rect : { ...rect, top: 100, bottom: 400 };
    });
    fireEvent.mouseEnter(card);
    expect(popup.style.top).toBe('150px');
    rect.top = 120;
    rect.bottom = 160;
    fireEvent.scroll(screen.getByTestId('session-list'));
    expect(popup.style.top).toBe('120px');
    rect.right = 60;
    fireEvent.resize(window);
    expect(popup.style.left).toBe('60px');
    rect.top = -50;
    rect.bottom = -10;
    fireEvent.scroll(screen.getByTestId('session-list'));
    expect(popup.style.display).toBe('none');
  });

  it('portals into the zoomed UI root and positions in its unzoomed coordinates', () => {
    renderSidebar(mockSessions, {
      isCollapsed: true,
      wrapper: ({ children }) => <div data-testid="zoom-root" data-ui-zoom="1.5">{children}</div>,
    });
    const card = screen.getByTestId('session-compact-item-sess-1');
    const popup = screen.getByTestId('session-popup-sess-1');
    const rect = { x: 0, y: 150, top: 150, bottom: 190, left: 0, right: 60,
      width: 60, height: 40, toJSON: () => ({}) };
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return this === card ? rect : { ...rect, top: 100, bottom: 400 };
    });
    expect(popup.parentElement).toBe(screen.getByTestId('zoom-root'));
    expect(screen.getByTestId('session-list').contains(popup)).toBe(false);
    fireEvent.mouseEnter(card);
    expect(popup.style.display).toBe('flex');
    expect(popup.style.left).toBe('40px');
    expect(popup.style.top).toBe('100px');
    expect(popup.style.maxWidth).toBe(`${100 / 1.5}vw`);
  });
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

describe('Sidebar session hierarchy', () => {
  const rootParentSession: Session = {
    id: 'parent-root',
    name: 'Parent Root Session',
    serverId: 'srv-local',
    projectId: 'proj-1',
    agentId: 'agent-1',
    task: 'Main root feature task',
    branch: 'main',
    worktreePath: '/workspace/spawnea',
    tmuxSessionName: 'spawnea-root',
    status: 'working',
    createdAt: new Date(),
    lastActivityAt: new Date(),
  };

  const childSessionOne: Session = {
    id: 'child-1',
    parentSessionId: 'parent-root',
    childAlias: 'child-1',
    name: 'Child Subtask One',
    serverId: 'srv-local',
    projectId: 'proj-1',
    agentId: 'agent-1',
    task: 'Child subtask one',
    branch: 'main',
    worktreePath: '/workspace/spawnea',
    tmuxSessionName: 'spawnea-child-1',
    status: 'working',
    createdAt: new Date(),
    lastActivityAt: new Date(),
  };

  const standaloneRootSession: Session = {
    id: 'standalone-root',
    name: 'Standalone Root Session',
    serverId: 'srv-local',
    projectId: 'proj-1',
    agentId: 'agent-1',
    task: 'Solo task',
    branch: 'feat/solo',
    worktreePath: '/workspace/spawnea',
    tmuxSessionName: 'spawnea-solo',
    status: 'idle',
    createdAt: new Date(),
    lastActivityAt: new Date(),
  };

  it('renders child session under parent in Card view with toggle', () => {
    const onSelectSession = vi.fn();
    renderSidebar([rootParentSession, childSessionOne, standaloneRootSession], { onSelectSession });

    // Standalone root has no toggle button
    expect(screen.queryByTestId('session-toggle-children-standalone-root')).toBeNull();

    // Parent root has toggle button
    const toggleBtn = screen.getByTestId('session-toggle-children-parent-root');
    expect(toggleBtn).toBeDefined();
    expect(toggleBtn.textContent).toContain('1');

    // Child list is not visible until expanded
    expect(screen.queryByTestId('session-child-list-parent-root')).toBeNull();

    // Click toggle to expand
    fireEvent.click(toggleBtn);
    expect(screen.getByTestId('session-child-list-parent-root')).toBeDefined();
    expect(screen.getByTestId('session-child-alias-child-1').textContent).toBe('child-1');
    expect(screen.getByTestId('session-title-child-1').textContent).toBe('Child Subtask One');

    // Selecting child calls onSelectSession
    fireEvent.click(screen.getByTestId('session-item-child-1'));
    expect(onSelectSession).toHaveBeenCalledWith('child-1');
  });

  it('renders child count badge and popup list in Collapsed view', () => {
    const onSelectSession = vi.fn();
    renderSidebar([rootParentSession, childSessionOne], { isCollapsed: true, onSelectSession });

    // Parent compact card shows child count badge
    const badge = screen.getByTestId('session-compact-child-count-parent-root');
    expect(badge).toBeDefined();
    expect(badge.textContent).toBe('1');

    // Hover popup lists child session item
    const popupChild = screen.getByTestId('session-compact-child-item-child-1');
    expect(popupChild).toBeDefined();

    // Clicking child item in popup selects it
    fireEvent.click(popupChild);
    expect(onSelectSession).toHaveBeenCalledWith('child-1');
  });

  it('indicates active child selection on parent compact card when collapsed', () => {
    renderSidebar([rootParentSession, childSessionOne], {
      isCollapsed: true,
      activeSessionId: 'child-1',
    });

    const parentButton = screen.getByTestId('session-item-parent-root');
    expect(parentButton.className).toContain('border-purple-500');

    const badge = screen.getByTestId('session-compact-child-count-parent-root');
    expect(badge.className).toContain('ring-purple-400/40');
  });

  it('renders dense subgrid in Grid/Dense view', () => {
    const onSelectSession = vi.fn();
    // 12 sessions triggers dense threshold
    const manySessions = makeSessions(11);
    const parentWithChild: Session = {
      ...rootParentSession,
      id: 'sess-parent-dense',
      name: 'Session Dense Parent',
    };
    const childInDense: Session = {
      ...childSessionOne,
      id: 'sess-child-dense',
      parentSessionId: 'sess-parent-dense',
      childAlias: 'child-1',
      name: 'Subtask In Dense',
    };

    renderSidebar([...manySessions, parentWithChild, childInDense], { onSelectSession });

    // Grid layout renders dense subgrid under parent
    expect(screen.getByTestId('session-dense-subgrid-sess-parent-dense')).toBeDefined();
    const childDenseItem = screen.getByTestId('session-item-sess-child-dense');
    expect(childDenseItem).toBeDefined();

    fireEvent.click(childDenseItem);
    expect(onSelectSession).toHaveBeenCalledWith('sess-child-dense');
  });

  it('keeps parent visible when search matches child alias or title', () => {
    renderSidebar([rootParentSession, childSessionOne, standaloneRootSession]);

    const searchInput = screen.getByTestId('session-search-input');

    // Search by child title
    fireEvent.change(searchInput, { target: { value: 'Subtask One' } });
    expect(screen.getByTestId('session-item-parent-root')).toBeDefined();
    expect(screen.queryByTestId('session-item-standalone-root')).toBeNull();

    // Search by child alias
    fireEvent.change(searchInput, { target: { value: 'child-1' } });
    expect(screen.getByTestId('session-item-parent-root')).toBeDefined();
    expect(screen.queryByTestId('session-item-standalone-root')).toBeNull();
  });

  it('does not render a child toggle when the status filter hides all children', () => {
    const parent = { ...rootParentSession, status: 'working' as const };
    const idleChild = {
      ...childSessionOne,
      parentSessionId: parent.id,
      status: 'idle' as const,
    };

    renderSidebar([parent, idleChild]);
    fireEvent.click(screen.getByTestId('status-filter-working'));

    expect(screen.getByTestId('session-item-parent-root')).toBeDefined();
    expect(screen.queryByTestId('session-toggle-children-parent-root')).toBeNull();
  });

  it('renders [+ New] and [+ Child] in header and triggers child creation for active parent', () => {
    const onOpenCreateChildModal = vi.fn();
    renderSidebar([rootParentSession, childSessionOne], {
      activeSessionId: 'parent-root',
      onOpenCreateChildModal,
    });

    const newBtn = screen.getByTestId('sidebar-new-session-button');
    const childBtn = screen.getByTestId('sidebar-new-child-session-button');
    expect(newBtn).toBeDefined();
    expect(childBtn).toBeDefined();
    expect(childBtn.textContent).toContain('Child');

    fireEvent.click(childBtn);
    expect(onOpenCreateChildModal).toHaveBeenCalledWith('parent-root');
  });

  it('renders child expand/collapse toggle below the name without covering shortcut badge', () => {
    renderSidebar([rootParentSession, childSessionOne]);

    const shortcutBadge = screen.getByTestId('session-shortcut-badge-parent-root');
    expect(shortcutBadge.textContent).toBe('Ctrl-1');

    const toggleBtn = screen.getByTestId('session-toggle-children-parent-root');
    expect(toggleBtn).toBeDefined();
    expect(toggleBtn.textContent).toContain('1 child');

    const card = screen.getByTestId('session-item-parent-root');
    const titleEl = screen.getByTestId('session-title-parent-root');
    const group = screen.getByTestId('session-parent-group-parent-root');

    // Toggle button is a sibling of card button (not nested inside button) following the title in layout
    expect(group.contains(card)).toBe(true);
    expect(group.contains(toggleBtn)).toBe(true);
    expect(card.contains(toggleBtn)).toBe(false);
    expect(titleEl.compareDocumentPosition(toggleBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('triggers onOpenAgentSetup from sidebar actions menu', () => {
    const onOpenAgentSetup = vi.fn();
    renderSidebar([rootParentSession], { onOpenAgentSetup });

    const menuTrigger = screen.getByTestId('sidebar-actions-menu-button');
    fireEvent.click(menuTrigger);

    const configureBtn = screen.getByTestId('sidebar-agent-setup-button');
    expect(configureBtn).toBeDefined();
    expect(configureBtn.textContent).toContain('Configure Spawnea with your agent');

    fireEvent.click(configureBtn);
    expect(onOpenAgentSetup).toHaveBeenCalled();
  });

  it('suppresses status badge for pure shell sessions in sidebar unless error or disconnected', () => {
    const shellAgent: Agent = {
      id: 'agent-shell',
      name: 'Bash',
      command: 'bash',
      harness: 'shell',
      createdAt: new Date(),
    };

    const shellSession: Session = {
      ...mockSessions[0],
      id: 'sess-shell',
      agentId: 'agent-shell',
      status: 'idle',
    };

    const { rerender } = render(
      <Sidebar
        sessions={[shellSession]}
        servers={mockServers}
        projects={mockProjects}
        agents={[shellAgent]}
        activeSessionId="sess-shell"
        onSelectSession={vi.fn()}
        onOpenCreateModal={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.queryByTestId('status-badge-idle')).toBeNull();

    rerender(
      <Sidebar
        sessions={[{ ...shellSession, status: 'working' }]}
        servers={mockServers}
        projects={mockProjects}
        agents={[shellAgent]}
        activeSessionId="sess-shell"
        onSelectSession={vi.fn()}
        onOpenCreateModal={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.getByTestId('status-badge-working')).toBeDefined();

    rerender(
      <Sidebar
        sessions={[{ ...shellSession, status: 'error' }]}
        servers={mockServers}
        projects={mockProjects}
        agents={[shellAgent]}
        activeSessionId="sess-shell"
        onSelectSession={vi.fn()}
        onOpenCreateModal={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.getByTestId('status-badge-error')).toBeDefined();

    rerender(
      <Sidebar
        sessions={[{ ...shellSession, status: 'disconnected' }]}
        servers={mockServers}
        projects={mockProjects}
        agents={[shellAgent]}
        activeSessionId="sess-shell"
        onSelectSession={vi.fn()}
        onOpenCreateModal={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.getByTestId('status-badge-disconnected')).toBeDefined();
  });

  it('recognizes catalog shell sessions with ID local:shell and command zsh', () => {
    const catalogShellAgent: Agent = {
      id: 'local:shell',
      name: 'Interactive Shell (Local Machine)',
      command: 'zsh',
      harness: 'zsh',
      createdAt: new Date(),
    };

    const session: Session = {
      ...mockSessions[0],
      id: 'sess-catalog-shell',
      agentId: 'local:shell',
      status: 'idle',
    };

    const { rerender } = render(
      <Sidebar
        sessions={[session]}
        servers={mockServers}
        projects={mockProjects}
        agents={[catalogShellAgent]}
        activeSessionId="sess-catalog-shell"
        onSelectSession={vi.fn()}
        onOpenCreateModal={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    // Idle badge suppressed for catalog shell
    expect(screen.queryByTestId('status-badge-idle')).toBeNull();

    rerender(
      <Sidebar
        sessions={[{ ...session, status: 'working' }]}
        servers={mockServers}
        projects={mockProjects}
        agents={[catalogShellAgent]}
        activeSessionId="sess-catalog-shell"
        onSelectSession={vi.fn()}
        onOpenCreateModal={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    // Working badge visible for catalog shell
    expect(screen.getByTestId('status-badge-working')).toBeDefined();
  });

  it('renders child session harness icon next to child alias badge in child list and subgrid', () => {
    const antigravityAgent: Agent = {
      id: 'agent-agy',
      name: 'Antigravity',
      command: 'agy',
      harness: 'antigravity',
      createdAt: new Date(),
    };

    const parent: Session = {
      ...mockSessions[0],
      id: 'sess-parent-harness-icon',
      name: 'Parent Session',
    };

    const child: Session = {
      ...mockSessions[0],
      id: 'sess-child-harness-icon',
      parentSessionId: 'sess-parent-harness-icon',
      childAlias: 'child-1',
      name: 'Antigravity Child Session',
      agentId: 'agent-agy',
    };

    render(
      <Sidebar
        sessions={[parent, child]}
        servers={mockServers}
        projects={mockProjects}
        agents={[mockAgents[0], antigravityAgent]}
        activeSessionId="sess-parent-harness-icon"
        onSelectSession={vi.fn()}
        onOpenCreateModal={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    // Expand children
    const toggleBtn = screen.getByTestId('session-toggle-children-sess-parent-harness-icon');
    fireEvent.click(toggleBtn);

    const childItem = screen.getByTestId('session-item-sess-child-harness-icon');
    expect(childItem).toBeDefined();

    // The child item should have the Antigravity provider icon rendered
    const childAlias = screen.getByTestId('session-child-alias-sess-child-harness-icon');
    const agyIcon = childItem.querySelector('[data-testid="provider-icon-antigravity"]');
    expect(agyIcon).toBeDefined();
    expect(agyIcon).not.toBeNull();
    expect(childItem.contains(childAlias)).toBe(true);
    expect(childItem.contains(agyIcon!)).toBe(true);
  });
});

describe('Sidebar child summary, refresh border and Needs Input emphasis', () => {
  const parent: Session = {
    ...mockSessions[0],
    id: 'p',
    name: 'Coordinator',
    status: 'idle',
  };
  const child = (id: string, status: Session['status']): Session => ({
    ...mockSessions[0],
    id,
    parentSessionId: 'p',
    childAlias: id,
    name: `Child ${id}`,
    status,
  });

  it('summarizes only working (incl. starting) and needs-input direct children', () => {
    expect(
      summarizeChildStatuses([
        child('a', 'working'),
        child('b', 'starting'),
        child('c', 'needs_input'),
        child('d', 'error'),
        child('e', 'idle'),
        child('f', 'disconnected'),
      ])
    ).toEqual({ working: 2, needsInput: 1 });
  });

  it('shows the mixed summary under the parent badge with the list collapsed and expanded', () => {
    renderSidebar([parent, child('a', 'working'), child('b', 'needs_input'), child('c', 'needs_input'), child('d', 'error')], {
      activeSessionId: 'p',
    });
    expect(screen.getByTestId('session-children-working-p').textContent).toContain('1');
    expect(screen.getByTestId('session-children-needs-input-p').textContent).toContain('2');
    expect(screen.queryByTestId('session-child-list-p')).toBeNull();
    // The parent keeps its own status.
    expect(screen.getByTestId('status-badge-idle')).toBeDefined();

    fireEvent.click(screen.getByTestId('session-toggle-children-p'));
    expect(screen.getByTestId('session-child-list-p')).toBeDefined();
    expect(screen.getByTestId('session-children-working-p')).toBeDefined();
    expect(screen.getByTestId('session-children-needs-input-p')).toBeDefined();
  });

  it('hides zero counts and the whole summary when no child works or waits', () => {
    renderSidebar([parent, child('a', 'working'), child('b', 'error')], { activeSessionId: 'p' });
    expect(screen.getByTestId('session-children-working-p')).toBeDefined();
    expect(screen.queryByTestId('session-children-needs-input-p')).toBeNull();
  });

  it('omits the summary when children are only idle or errored', () => {
    renderSidebar([parent, child('a', 'idle'), child('b', 'error')], { activeSessionId: 'p' });
    expect(screen.queryByTestId('session-children-summary-p')).toBeNull();
  });

  it('draws a refresh border while keeping the status icon', () => {
    renderSidebar([{ ...parent, status: 'working' }], {
      activeSessionId: 'p',
      refreshingSessionIds: new Set(['p']),
    });
    expect(screen.getByTestId('status-refresh-working')).toBeDefined();
    expect(screen.getByTestId('status-badge-working')).toBeDefined();
  });

  it('draws no refresh border when the session is not refreshing', () => {
    renderSidebar([{ ...parent, status: 'working' }], { activeSessionId: 'p' });
    expect(screen.queryByTestId('status-refresh-working')).toBeNull();
  });

  it('marks Needs Input cards and child rows with a solid violet badge and left edge', () => {
    renderSidebar([{ ...parent, status: 'needs_input' }, child('a', 'needs_input')], {
      activeSessionId: 'other',
    });
    fireEvent.click(screen.getByTestId('session-toggle-children-p'));
    for (const id of ['p', 'a']) {
      const item = screen.getByTestId(`session-item-${id}`);
      const edged = item.className.includes('border-l-violet-500') || item.parentElement?.className.includes('border-l-violet-500');
      expect(edged).toBe(true);
    }
    for (const badge of screen.getAllByTestId('status-badge-needs_input')) {
      expect(badge.className).toContain('bg-violet-600');
      expect(badge.className).toContain('text-white');
    }
  });

  it('draws the refresh border in the dense layout for parents and children', () => {
    localStorage.setItem(STORAGE_KEY_SESSION_LAYOUT, 'dense');
    renderSidebar([{ ...parent, status: 'working' }, child('a', 'needs_input')], {
      activeSessionId: 'p',
      refreshingSessionIds: new Set(['p', 'a']),
    });
    expect(screen.getByTestId('session-list').getAttribute('data-layout')).toBe('dense');
    const dense = screen.getByTestId('session-dense-item-p');
    expect(dense.querySelector('[data-testid="status-refresh-working"]')).not.toBeNull();
    const subgrid = screen.getByTestId('session-dense-subgrid-p');
    expect(subgrid.querySelector('[data-testid="status-refresh-needs_input"]')).not.toBeNull();
  });

  it('draws the refresh border in the auto dense layout from the session threshold', () => {
    const many = makeSessions(DENSE_SESSION_THRESHOLD);
    renderSidebar(many, { refreshingSessionIds: new Set([many[0].id]) });
    expect(screen.getByTestId('session-list').getAttribute('data-layout')).toBe('dense');
    const item = screen.getByTestId(`session-dense-item-${many[0].id}`);
    expect(item.querySelector('[data-testid="status-refresh-working"]')).not.toBeNull();
    expect(screen.getAllByTestId('status-refresh-working')).toHaveLength(1);
  });

  it('draws the refresh border on the compact popup badges only, not on the status dot', () => {
    renderSidebar([{ ...parent, status: 'working' }, child('a', 'needs_input')], {
      isCollapsed: true,
      activeSessionId: 'p',
      refreshingSessionIds: new Set(['p', 'a']),
    });
    const popup = screen.getByTestId('session-popup-p');
    expect(popup.querySelector('[data-testid="status-refresh-working"]')).not.toBeNull();
    expect(popup.querySelector('[data-testid="status-refresh-needs_input"]')).not.toBeNull();
    const dot = screen.getByTestId('session-compact-status-p');
    expect(dot.querySelector('svg')).toBeNull();
    expect(dot.className).toContain('bg-amber-400');
  });

  it('draws no refresh border in dense or compact views when nothing is refreshing', () => {
    localStorage.setItem(STORAGE_KEY_SESSION_LAYOUT, 'dense');
    const { unmount } = renderSidebar([{ ...parent, status: 'working' }, child('a', 'working')]);
    expect(screen.queryByTestId('status-refresh-working')).toBeNull();
    unmount();
    localStorage.clear();
    renderSidebar([{ ...parent, status: 'working' }, child('a', 'working')], { isCollapsed: true });
    expect(screen.queryByTestId('status-refresh-working')).toBeNull();
  });

  it('applies the solid violet Needs Input badge and left edge in the dense layout', () => {
    localStorage.setItem(STORAGE_KEY_SESSION_LAYOUT, 'dense');
    renderSidebar([{ ...parent, status: 'needs_input' }, child('a', 'needs_input'), child('b', 'working')], {
      activeSessionId: 'other',
    });
    for (const id of ['p', 'a']) {
      expect(screen.getByTestId(`session-item-${id}`).className).toContain('border-l-violet-500');
    }
    expect(screen.getByTestId('session-item-b').className).not.toContain('border-l-violet-500');
    const dense = screen.getByTestId('session-dense-item-p');
    const subgrid = screen.getByTestId('session-dense-subgrid-p');
    for (const badge of [
      ...dense.querySelectorAll('[data-testid="status-badge-needs_input"]'),
      ...subgrid.querySelectorAll('[data-testid="status-badge-needs_input"]'),
    ]) {
      expect(badge.className).toContain('bg-violet-600');
      expect(badge.className).toContain('text-white');
    }
    expect(dense.querySelector('[data-testid="status-badge-needs_input"]')).not.toBeNull();
    expect(subgrid.querySelector('[data-testid="status-badge-needs_input"]')).not.toBeNull();
  });

  it('applies the solid violet Needs Input badge in the compact popup without touching the status dot', () => {
    renderSidebar([{ ...parent, status: 'needs_input' }, child('a', 'needs_input'), child('b', 'idle')], {
      isCollapsed: true,
      activeSessionId: 'other',
    });
    const popup = screen.getByTestId('session-popup-p');
    const badges = popup.querySelectorAll('[data-testid="status-badge-needs_input"]');
    expect(badges).toHaveLength(2);
    for (const badge of badges) {
      expect(badge.className).toContain('bg-violet-600');
      expect(badge.className).toContain('text-white');
    }
    expect(screen.getByTestId('session-compact-child-item-a').className).toContain('border-l-violet-500');
    expect(screen.getByTestId('session-compact-child-item-b').className).not.toContain('border-l-violet-500');
    const dot = screen.getByTestId('session-compact-status-p');
    expect(dot.className).toContain('bg-purple-400');
    expect(dot.className).not.toContain('bg-violet-600');
  });

  it('keeps the violet edge on hover for Needs Input cards and rows in every view', () => {
    const edge = (item: HTMLElement) => {
      // A parent's card is the wrapper around its select button.
      const el = item.className.includes('border-l-violet-500') ? item : (item.parentElement as HTMLElement);
      expect(el.className).toContain('border-l-violet-500');
      expect(el.className).toContain('hover:border-l-violet-500');
    };
    const { unmount } = renderSidebar([{ ...parent, status: 'needs_input' }, child('a', 'needs_input')], {
      activeSessionId: 'other',
    });
    fireEvent.click(screen.getByTestId('session-toggle-children-p'));
    edge(screen.getByTestId('session-item-p'));
    edge(screen.getByTestId('session-item-a'));
    unmount();
    localStorage.setItem(STORAGE_KEY_SESSION_LAYOUT, 'dense');
    const dense = renderSidebar([{ ...parent, status: 'needs_input' }, child('a', 'needs_input')], {
      activeSessionId: 'other',
    });
    edge(screen.getByTestId('session-item-p'));
    edge(screen.getByTestId('session-item-a'));
    dense.unmount();
    localStorage.clear();
    renderSidebar([parent, child('a', 'needs_input')], { isCollapsed: true, activeSessionId: 'other' });
    edge(screen.getByTestId('session-compact-child-item-a'));
  });

  it('right-aligns the status icon column so the icon matches cards without children', () => {
    renderSidebar([parent, child('a', 'working')], { activeSessionId: 'p' });
    const summary = screen.getByTestId('session-children-summary-p');
    expect(summary.parentElement?.className).toContain('items-end');
    expect(summary.parentElement?.className).not.toContain('items-center');
  });

  it('colors the compact child count by urgency: Needs Input, then Working', () => {
    const { unmount } = renderSidebar([parent, child('a', 'working'), child('b', 'needs_input')], {
      isCollapsed: true,
      activeSessionId: 'p',
    });
    expect(screen.getByTestId('session-compact-child-count-p').getAttribute('data-urgency')).toBe('needs_input');
    unmount();
    const { unmount: unmount2 } = renderSidebar([parent, child('a', 'working'), child('b', 'idle')], { isCollapsed: true, activeSessionId: 'p' });
    expect(screen.getByTestId('session-compact-child-count-p').getAttribute('data-urgency')).toBe('working');
    unmount2();
    const neutral = renderSidebar([parent, child('a', 'idle'), child('b', 'error')], { isCollapsed: true, activeSessionId: 'p' });
    const bubble = screen.getByTestId('session-compact-child-count-p');
    expect(bubble.getAttribute('data-urgency')).toBe('none');
    expect(bubble.className).toContain('bg-zinc-600');
    expect(bubble.className).not.toContain('purple');
    expect(bubble.className).not.toContain('violet');
    neutral.unmount();
    renderSidebar([parent, child('a', 'idle')], { isCollapsed: true, activeSessionId: 'a' });
    const active = screen.getByTestId('session-compact-child-count-p');
    expect(active.className).toContain('bg-zinc-600');
    expect(active.className).toContain('ring-purple-400/40');
  });
});
