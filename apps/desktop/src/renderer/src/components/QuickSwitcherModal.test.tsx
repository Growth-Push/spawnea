import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { QuickSwitcherModal } from './QuickSwitcherModal';
import type { Session, Server, Project, Agent } from '@spawnea/domain';

const mockServers: Server[] = [
  {
    id: 'srv-1',
    name: 'Dev Server Alpha',
    host: 'dev-alpha.example.test',
    sshPort: 22,
    enabled: true,
    createdAt: new Date(),
  },
];

const mockProjects: Project[] = [
  {
    id: 'proj-1',
    serverId: 'srv-1',
    name: 'Backend API',
    rootPath: '/srv/code/backend-api',
    createdAt: new Date(),
  },
];

const mockAgents: Agent[] = [
  {
    id: 'agent-claude',
    name: 'Claude Code',
    harness: 'claude',
    command: 'claude',
    createdAt: new Date(),
  },
];

const mockSessions: Session[] = [
  {
    id: 'sess-1',
    name: 'Feature Auth Session',
    serverId: 'srv-1',
    projectId: 'proj-1',
    agentId: 'agent-claude',
    task: 'Implement JWT authentication',
    worktreePath: '/srv/code/backend-api/worktrees/auth',
    branch: 'feat/jwt-auth',
    tmuxSessionName: 'spawnea-auth',
    status: 'working',
    createdAt: new Date(),
    lastActivityAt: new Date(),
  },
  {
    id: 'sess-2',
    name: 'Model Optimization',
    serverId: 'srv-1',
    projectId: 'proj-1',
    agentId: 'agent-claude',
    task: 'Optimize quantization pipeline',
    worktreePath: '/srv/code/backend-api/worktrees/quant',
    branch: 'feat/quantization',
    tmuxSessionName: 'spawnea-quant',
    status: 'needs_input',
    createdAt: new Date(),
    lastActivityAt: new Date(),
  },
];

describe('QuickSwitcherModal component', () => {
  it('does not render when isOpen is false', () => {
    render(
      <QuickSwitcherModal
        isOpen={false}
        onClose={vi.fn()}
        sessions={mockSessions}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
        activeSessionId="sess-1"
        activeTab="terminal"
        onSelectSession={vi.fn()}
        onSelectTab={vi.fn()}
        onOpenCreateModal={vi.fn()}
        onRefresh={vi.fn()}
        onToggleSidebar={vi.fn()}
      />
    );

    expect(screen.queryByTestId('quick-switcher-modal')).toBeNull();
  });

  it('renders modal with search input, session items, tabs, and action items when open', () => {
    render(
      <QuickSwitcherModal
        isOpen={true}
        onClose={vi.fn()}
        sessions={mockSessions}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
        activeSessionId="sess-1"
        activeTab="terminal"
        onSelectSession={vi.fn()}
        onSelectTab={vi.fn()}
        onOpenCreateModal={vi.fn()}
        onRefresh={vi.fn()}
        onToggleSidebar={vi.fn()}
      />
    );

    expect(screen.getByTestId('quick-switcher-modal')).toBeDefined();
    expect(screen.getByTestId('quick-switcher-input')).toBeDefined();
    expect(screen.getByText('Feature Auth Session')).toBeDefined();
    expect(screen.getByText('Model Optimization')).toBeDefined();
    expect(screen.getByText('Switch to Terminal')).toBeDefined();
    expect(screen.getByText('Switch to Files')).toBeDefined();
    expect(screen.getByText('Switch to Git Diff')).toBeDefined();
    expect(screen.getByText('Switch to Artifacts')).toBeDefined();
    expect(screen.getByText('New Session')).toBeDefined();
    expect(screen.getByText('Toggle Sidebar')).toBeDefined();
    expect(screen.queryByText('Report State Feedback')).toBeNull();
  });

  it('filters items dynamically based on search query', () => {
    render(
      <QuickSwitcherModal
        isOpen={true}
        onClose={vi.fn()}
        sessions={mockSessions}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
        activeSessionId="sess-1"
        activeTab="terminal"
        onSelectSession={vi.fn()}
        onSelectTab={vi.fn()}
        onOpenCreateModal={vi.fn()}
        onRefresh={vi.fn()}
        onToggleSidebar={vi.fn()}
      />
    );

    const input = screen.getByTestId('quick-switcher-input');

    // Search for "quantization"
    fireEvent.change(input, { target: { value: 'quantization' } });
    expect(screen.getByText('Model Optimization')).toBeDefined();
    expect(screen.queryByText('Feature Auth Session')).toBeNull();

    // Search for "diff"
    fireEvent.change(input, { target: { value: 'diff' } });
    expect(screen.getByText('Switch to Git Diff')).toBeDefined();
    expect(screen.queryByText('Switch to Terminal')).toBeNull();

    // Search for non-existing query
    fireEvent.change(input, { target: { value: 'nonexistentxyz123' } });
    expect(screen.getByText(/No matching sessions, commands, or tabs found/)).toBeDefined();
  });

  it('handles keyboard navigation (ArrowDown, ArrowUp, Enter) to select an item', () => {
    const onSelectSession = vi.fn();
    const onClose = vi.fn();

    render(
      <QuickSwitcherModal
        isOpen={true}
        onClose={onClose}
        sessions={mockSessions}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
        activeSessionId="sess-1"
        activeTab="terminal"
        onSelectSession={onSelectSession}
        onSelectTab={vi.fn()}
        onOpenCreateModal={vi.fn()}
        onRefresh={vi.fn()}
        onToggleSidebar={vi.fn()}
      />
    );

    const input = screen.getByTestId('quick-switcher-input');

    // 1. Initial selection is index 0 (sess-1)
    // Press ArrowDown to navigate to index 1 (sess-2)
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    // Press Enter to select
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSelectSession).toHaveBeenCalledWith('sess-2');
    expect(onClose).toHaveBeenCalled();
  });

  it('handles tab selection action on click or enter', () => {
    const onSelectTab = vi.fn();
    const onClose = vi.fn();

    render(
      <QuickSwitcherModal
        isOpen={true}
        onClose={onClose}
        sessions={mockSessions}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
        activeSessionId="sess-1"
        activeTab="terminal"
        onSelectSession={vi.fn()}
        onSelectTab={onSelectTab}
        onOpenCreateModal={vi.fn()}
        onRefresh={vi.fn()}
        onToggleSidebar={vi.fn()}
      />
    );

    // Click "Switch to Files"
    const filesItem = screen.getByTestId('quick-switcher-item-tab-files');
    fireEvent.click(filesItem);

    expect(onSelectTab).toHaveBeenCalledWith('files');
    expect(onClose).toHaveBeenCalled();
  });

  it('closes when Escape key is pressed or backdrop is clicked', () => {
    const onClose = vi.fn();

    render(
      <QuickSwitcherModal
        isOpen={true}
        onClose={onClose}
        sessions={mockSessions}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
        activeSessionId="sess-1"
        activeTab="terminal"
        onSelectSession={vi.fn()}
        onSelectTab={vi.fn()}
        onOpenCreateModal={vi.fn()}
        onRefresh={vi.fn()}
        onToggleSidebar={vi.fn()}
      />
    );

    const input = screen.getByTestId('quick-switcher-input');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    const backdrop = screen.getByTestId('quick-switcher-modal');
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
