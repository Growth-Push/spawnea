import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ContextBar } from './ContextBar';
import type { Session, Server, Project, Agent } from '@spawnea/domain';

describe('ContextBar session hierarchy actions', () => {
  afterEach(() => {
    cleanup();
  });

  const mockServer: Server = {
    id: 'srv-1',
    name: 'Local Server',
    host: 'localhost',
    sshPort: 22,
    enabled: true,
    createdAt: new Date(),
  };

  const mockProject: Project = {
    id: 'proj-1',
    serverId: 'srv-1',
    name: 'Spawnea',
    rootPath: '/repo',
    createdAt: new Date(),
  };

  const mockAgent: Agent = {
    id: 'agent-1',
    name: 'Claude Code',
    command: 'claude',
    harness: 'claude-code',
    createdAt: new Date(),
  };

  const rootSession: Session = {
    id: 'parent-1',
    name: 'Parent Session',
    serverId: 'srv-1',
    projectId: 'proj-1',
    agentId: 'agent-1',
    task: 'Parent task',
    branch: 'main',
    worktreePath: '/repo',
    tmuxSessionName: 'spawnea-parent',
    status: 'working',
    createdAt: new Date(),
    lastActivityAt: new Date(),
  };

  const childSession: Session = {
    id: 'child-1',
    parentSessionId: 'parent-1',
    childAlias: 'child-1',
    name: 'Child Session',
    serverId: 'srv-1',
    projectId: 'proj-1',
    agentId: 'agent-1',
    task: 'Child task',
    branch: 'main',
    worktreePath: '/repo',
    tmuxSessionName: 'spawnea-child-1',
    status: 'working',
    createdAt: new Date(),
    lastActivityAt: new Date(),
  };

  it('renders + child session button for root session and triggers callback', () => {
    const onCreateChild = vi.fn();
    render(
      <ContextBar
        session={rootSession}
        server={mockServer}
        project={mockProject}
        agent={mockAgent}
        onCreateChild={onCreateChild}
      />
    );

    const createBtn = screen.getByTestId('session-create-child-button');
    expect(createBtn).toBeDefined();

    fireEvent.click(createBtn);
    expect(onCreateChild).toHaveBeenCalledWith('parent-1');
  });

  it('hides + child session button for child session (enforcing 2-level cap)', () => {
    const onCreateChild = vi.fn();
    render(
      <ContextBar
        session={childSession}
        server={mockServer}
        project={mockProject}
        agent={mockAgent}
        onCreateChild={onCreateChild}
      />
    );

    expect(screen.queryByTestId('session-create-child-button')).toBeNull();
  });

  it('renders child alias badge when active session has childAlias', () => {
    render(
      <ContextBar
        session={childSession}
        server={mockServer}
        project={mockProject}
        agent={mockAgent}
      />
    );

    const badge = screen.getByTestId('contextbar-child-alias-badge');
    expect(badge).toBeDefined();
    expect(badge.textContent).toBe('child-1');
  });
});
