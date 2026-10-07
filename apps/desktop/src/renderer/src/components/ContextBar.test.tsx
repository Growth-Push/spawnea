import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ContextBar } from './ContextBar';
import { isPureShellSession } from './StatusBadge';
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

  it('does not render child session creation button in context bar', () => {
    render(
      <ContextBar
        session={rootSession}
        server={mockServer}
        project={mockProject}
        agent={mockAgent}
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

  it('renders status badge for agent sessions with normal status', () => {
    render(
      <ContextBar
        session={{ ...rootSession, status: 'working' }}
        server={mockServer}
        project={mockProject}
        agent={mockAgent}
      />
    );

    expect(screen.getByTestId('status-badge-working')).toBeDefined();
  });

  it('recognizes a shell executable when its command includes arguments', () => {
    expect(isPureShellSession(
      { agentId: 'agent-custom' },
      { id: 'agent-custom', harness: 'custom', name: 'Local task', command: '/bin/bash -l' }
    )).toBe(true);
  });

  it('does not assume an unidentified session is a shell', () => {
    expect(isPureShellSession({ status: 'idle' })).toBe(false);
    expect(isPureShellSession({ status: 'idle' }, { command: 'codex' })).toBe(false);
    expect(isPureShellSession({ status: 'idle' }, { command: 'dash' })).toBe(true);
  });

  it('suppresses status badge for pure shell sessions when sitting at prompt (idle/done)', () => {
    const shellAgent: Agent = {
      id: 'agent-shell',
      name: 'Bash',
      command: 'bash',
      harness: 'shell',
      createdAt: new Date(),
    };

    const { rerender } = render(
      <ContextBar
        session={{ ...rootSession, status: 'idle', agentId: 'agent-shell' }}
        server={mockServer}
        project={mockProject}
        agent={shellAgent}
      />
    );

    expect(screen.queryByTestId('status-badge-idle')).toBeNull();

    rerender(
      <ContextBar
        session={{ ...rootSession, status: 'done', agentId: 'agent-shell' }}
        server={mockServer}
        project={mockProject}
        agent={shellAgent}
      />
    );

    expect(screen.queryByTestId('status-badge-done')).toBeNull();
  });

  it('keeps feedback button accessible for pure shell sessions even when status badge is suppressed', () => {
    const shellAgent: Agent = {
      id: 'agent-shell',
      name: 'Bash',
      command: 'bash',
      harness: 'shell',
      createdAt: new Date(),
    };

    const onReportFeedback = vi.fn();

    render(
      <ContextBar
        session={{ ...rootSession, status: 'idle', agentId: 'agent-shell' }}
        server={mockServer}
        project={mockProject}
        agent={shellAgent}
        onReportFeedback={onReportFeedback}
      />
    );

    expect(screen.queryByTestId('status-badge-idle')).toBeNull();
    const feedbackBtn = screen.getByTestId('session-feedback-button');
    expect(feedbackBtn).toBeDefined();

    fireEvent.click(feedbackBtn);
    expect(onReportFeedback).toHaveBeenCalledWith(rootSession.id);
  });

  it('renders status badge for pure shell sessions when working, error, or disconnected', () => {
    const shellAgent: Agent = {
      id: 'agent-shell',
      name: 'Bash',
      command: 'bash',
      harness: 'shell',
      createdAt: new Date(),
    };

    const { rerender } = render(
      <ContextBar
        session={{ ...rootSession, status: 'working', agentId: 'agent-shell' }}
        server={mockServer}
        project={mockProject}
        agent={shellAgent}
      />
    );

    expect(screen.getByTestId('status-badge-working')).toBeDefined();

    rerender(
      <ContextBar
        session={{ ...rootSession, status: 'error', agentId: 'agent-shell' }}
        server={mockServer}
        project={mockProject}
        agent={shellAgent}
      />
    );

    expect(screen.getByTestId('status-badge-error')).toBeDefined();

    rerender(
      <ContextBar
        session={{ ...rootSession, status: 'disconnected', agentId: 'agent-shell' }}
        server={mockServer}
        project={mockProject}
        agent={shellAgent}
      />
    );

    expect(screen.getByTestId('status-badge-disconnected')).toBeDefined();
  });

  it('recognizes catalog shell sessions (e.g. local:shell with command zsh)', () => {
    const catalogShellAgent: Agent = {
      id: 'local:shell',
      name: 'Interactive Shell (Local Machine)',
      command: 'zsh',
      harness: 'zsh',
      createdAt: new Date(),
    };

    const { rerender } = render(
      <ContextBar
        session={{ ...rootSession, status: 'idle', agentId: 'local:shell' }}
        server={mockServer}
        project={mockProject}
        agent={catalogShellAgent}
      />
    );

    // Idle badge suppressed for catalog shell session
    expect(screen.queryByTestId('status-badge-idle')).toBeNull();

    rerender(
      <ContextBar
        session={{ ...rootSession, status: 'working', agentId: 'local:shell' }}
        server={mockServer}
        project={mockProject}
        agent={catalogShellAgent}
      />
    );

    // Working badge visible for catalog shell session
    expect(screen.getByTestId('status-badge-working')).toBeDefined();
  });
});
