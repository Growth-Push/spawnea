import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CreateChildSessionModal } from './CreateChildSessionModal';
import type { Session, Agent, Server } from '@spawnea/domain';

describe('CreateChildSessionModal', () => {
  afterEach(() => {
    cleanup();
  });

  const mockParentSession: Session = {
    id: 'parent-1',
    name: 'Parent Project Feature',
    serverId: 'srv-1',
    projectId: 'proj-1',
    agentId: 'agent-claude',
    task: 'Implement parent task',
    branch: 'main',
    worktreePath: '/workspace/spawnea',
    tmuxSessionName: 'spawnea-parent',
    status: 'working',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    lastActivityAt: new Date('2026-09-01T01:00:00Z'),
  };

  const mockAgents: Agent[] = [
    {
      id: 'agent-claude',
      name: 'Claude Code',
      command: 'claude',
      harness: 'claude-code',
      createdAt: new Date(),
    },
    {
      id: 'agent-codex',
      name: 'Codex CLI',
      command: 'codex',
      harness: 'custom',
      createdAt: new Date(),
    },
  ];

  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <CreateChildSessionModal
        isOpen={false}
        parentSession={mockParentSession}
        agents={mockAgents}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when parentSession is null', () => {
    const { container } = render(
      <CreateChildSessionModal
        isOpen={true}
        parentSession={null}
        agents={mockAgents}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders modal with parent information and default workspace mode', () => {
    render(
      <CreateChildSessionModal
        isOpen={true}
        parentSession={mockParentSession}
        agents={mockAgents}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    expect(screen.getByTestId('create-child-session-modal')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Create Child Session' })).toBeDefined();
    expect(screen.getByText('Parent Project Feature')).toBeDefined();
    expect(screen.getByTestId('child-session-task-input')).toBeDefined();
    expect(screen.getByTestId('child-workspace-same-project')).toBeDefined();
    expect(screen.getByTestId('child-workspace-new-worktree')).toBeDefined();
  });

  it('submits form with same-project mode by default', () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateChildSessionModal
        isOpen={true}
        parentSession={mockParentSession}
        agents={mockAgents}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />
    );

    const taskInput = screen.getByTestId('child-session-task-input');
    fireEvent.change(taskInput, { target: { value: 'Inspect database migrations' } });

    const submitBtn = screen.getByTestId('submit-create-child-button');
    fireEvent.click(submitBtn);

    expect(onSubmit).toHaveBeenCalledWith({
      parentSessionId: 'parent-1',
      task: 'Inspect database migrations',
      workspace: 'same-project',
      agentId: 'agent-claude',
      name: undefined,
    });
  });

  it('submits form with new-worktree workspace mode and custom name', () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateChildSessionModal
        isOpen={true}
        parentSession={mockParentSession}
        agents={mockAgents}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />
    );

    fireEvent.change(screen.getByTestId('child-session-task-input'), {
      target: { value: 'Refactor auth module' },
    });
    fireEvent.change(screen.getByTestId('child-session-name-input'), {
      target: { value: 'Auth Refactor' },
    });
    fireEvent.click(screen.getByTestId('child-workspace-new-worktree'));

    fireEvent.click(screen.getByTestId('submit-create-child-button'));

    expect(onSubmit).toHaveBeenCalledWith({
      parentSessionId: 'parent-1',
      name: 'Auth Refactor',
      task: 'Refactor auth module',
      workspace: 'new-worktree',
      agentId: 'agent-claude',
    });
  });

  it('calls onClose when cancel button is clicked', () => {
    const onClose = vi.fn();
    render(
      <CreateChildSessionModal
        isOpen={true}
        parentSession={mockParentSession}
        agents={mockAgents}
        onClose={onClose}
        onSubmit={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId('cancel-create-child-button'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not steal focus or clear inputs when background sync triggers re-render', () => {
    let onCloseFn = vi.fn();
    const { rerender } = render(
      <CreateChildSessionModal
        isOpen={true}
        parentSession={mockParentSession}
        agents={mockAgents}
        onClose={onCloseFn}
        onSubmit={vi.fn()}
      />
    );

    const taskInput = screen.getByTestId('child-session-task-input') as HTMLTextAreaElement;
    taskInput.focus();
    fireEvent.change(taskInput, { target: { value: 'Working on background fix' } });

    expect(document.activeElement).toBe(taskInput);
    expect(taskInput.value).toBe('Working on background fix');

    // Simulate background sync cycle in App: new onClose reference and refreshed agents
    onCloseFn = vi.fn();
    rerender(
      <CreateChildSessionModal
        isOpen={true}
        parentSession={{ ...mockParentSession }}
        agents={[...mockAgents]}
        onClose={onCloseFn}
        onSubmit={vi.fn()}
      />
    );

    // Focus must still be on the taskInput, NOT stolen by the close X button
    const closeBtn = screen.getByTestId('close-create-child-modal-button');
    expect(document.activeElement).not.toBe(closeBtn);
    expect(document.activeElement).toBe(taskInput);
    expect(taskInput.value).toBe('Working on background fix');
  });

  it('renders host and agent combos with parent host selected by default and filtered agents', () => {
    const mockServers: Server[] = [
      {
        id: 'srv-1',
        name: 'arch-matt',
        host: 'localhost',
        sshPort: 22,
        enabled: true,
        createdAt: new Date(),
      },
      {
        id: 'srv-2',
        name: 'Growth Push VPS',
        host: '10.0.0.2',
        sshPort: 22,
        enabled: true,
        createdAt: new Date(),
      },
    ];

    const multiHostAgents: Agent[] = [
      {
        id: 'srv-1:claude',
        name: 'Claude Code (arch-matt)',
        command: 'claude',
        harness: 'claude-code',
        createdAt: new Date(),
      },
      {
        id: 'srv-1:codex',
        name: 'Codex (arch-matt)',
        command: 'codex',
        harness: 'codex',
        createdAt: new Date(),
      },
      {
        id: 'srv-2:hermes',
        name: 'Hermes (Growth Push VPS)',
        command: 'hermes',
        harness: 'hermes',
        createdAt: new Date(),
      },
    ];

    const parentWithScopedAgent: Session = {
      ...mockParentSession,
      serverId: 'srv-1',
      agentId: 'srv-1:codex',
    };

    render(
      <CreateChildSessionModal
        isOpen={true}
        parentSession={parentWithScopedAgent}
        agents={multiHostAgents}
        servers={mockServers}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    const hostSelect = screen.getByTestId('child-session-host-select') as HTMLSelectElement;
    const agentSelect = screen.getByTestId('child-session-agent-select') as HTMLSelectElement;

    // Host is locked to parent's host
    expect(hostSelect.value).toBe('srv-1');
    expect(hostSelect.disabled).toBe(true);

    // Default agent is parent's agent
    expect(agentSelect.value).toBe('srv-1:codex');

    // Only agents for srv-1 are shown, srv-2 agents are excluded
    const agentOptions = Array.from(agentSelect.options).map((opt) => opt.textContent?.trim());
    expect(agentOptions).toContain('Claude Code');
    expect(agentOptions).toContain('Codex (Parent Default)');
    expect(agentOptions).not.toContain('Hermes');
  });
});
