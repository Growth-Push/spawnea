import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AdoptSessionModal } from './AdoptSessionModal';
import type { Server, Project, Agent, DiscoveredTmuxSession } from '@spawnea/domain';

describe('AdoptSessionModal (FG-7.2.1, FG-7.2.2)', () => {
  const mockServers: Server[] = [
    {
      id: 'srv-1',
      name: 'Local Workstation',
      host: 'localhost',
      sshPort: 22,
      enabled: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
    {
      id: 'srv-2',
      name: 'Remote GPU Host',
      host: 'gpu.dev.example.test',
      sshPort: 2222,
      enabled: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
  ];

  const mockProjects: Project[] = [
    {
      id: 'proj-1',
      serverId: 'srv-1',
      name: 'Spawnea Core',
      rootPath: '/workspace/spawnea',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
    {
      id: 'proj-2',
      serverId: 'srv-1',
      name: 'Frontend Web',
      rootPath: '/workspace/code/frontend',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
  ];

  const mockAgents: Agent[] = [
    {
      id: 'agent-claude',
      name: 'Claude Code',
      harness: 'claude',
      command: 'claude',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
    {
      id: 'agent-codex',
      name: 'Codex Agent',
      harness: 'codex',
      command: 'codex',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
  ];

  const mockDiscovered: DiscoveredTmuxSession[] = [
    {
      sessionName: 'my-external-shell',
      windowsCount: 2,
      createdAt: new Date('2026-01-01T12:00:00Z'),
      panePid: 12345,
      currentCommand: 'bash',
      currentPath: '/workspace/spawnea',
    },
    {
      sessionName: 'remote-claude-agent',
      windowsCount: 1,
      createdAt: new Date('2026-01-01T14:00:00Z'),
      panePid: 12350,
      currentCommand: 'claude',
      currentPath: '/workspace/code/frontend',
    },
  ];

  beforeEach(() => {
    (window as any).spawneaApi = {
      discoverExternalSessions: vi.fn().mockResolvedValue(mockDiscovered),
    };
  });

  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <AdoptSessionModal
        isOpen={false}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('discovers and displays active external tmux sessions', async () => {
    render(
      <AdoptSessionModal
        isOpen={true}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
      />
    );

    expect(screen.getByText('Discover & Adopt External tmux Sessions')).toBeDefined();

    await waitFor(() => {
      expect(screen.getByText('my-external-shell')).toBeDefined();
      expect(screen.getByText('remote-claude-agent')).toBeDefined();
    });

    expect(screen.getByText('/workspace/spawnea')).toBeDefined();
    expect(screen.getByText('2 win')).toBeDefined();
  });

  it('selects a discovered session and populates adoption form', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(
      <AdoptSessionModal
        isOpen={true}
        onClose={onClose}
        onSubmit={onSubmit}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('discovered-session-remote-claude-agent')).toBeDefined();
    });

    // Click on the claude session
    fireEvent.click(screen.getByTestId('discovered-session-remote-claude-agent'));

    // Verify form is displayed and auto-populated
    const nameInput = screen.getByTestId('adopt-input-name') as HTMLInputElement;
    expect(nameInput.value).toBe('remote-claude-agent');

    const projectSelect = screen.getByTestId('adopt-select-project') as HTMLSelectElement;
    expect(projectSelect.value).toBe('proj-2'); // Matched /workspace/code/frontend

    const harnessSelect = screen.getByTestId('adopt-select-harness') as HTMLSelectElement;
    expect(harnessSelect.value).toBe('agent-claude'); // Matched claude command

    // Submit adoption
    fireEvent.click(screen.getByTestId('submit-adopt-session'));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        serverId: 'srv-1',
        tmuxSessionName: 'remote-claude-agent',
        sessionName: 'remote-claude-agent',
        projectId: 'proj-2',
        projectPath: '/workspace/code/frontend',
        agentId: 'agent-claude',
        harnessCommand: 'claude',
        task: 'remote-claude-agent',
      });
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('supports adopting terminal-only session without agent harness', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(
      <AdoptSessionModal
        isOpen={true}
        onClose={onClose}
        onSubmit={onSubmit}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('discovered-session-my-external-shell')).toBeDefined();
    });

    // Click bash shell session
    fireEvent.click(screen.getByTestId('discovered-session-my-external-shell'));

    const harnessSelect = screen.getByTestId('adopt-select-harness') as HTMLSelectElement;
    expect(harnessSelect.value).toBe('none'); // Defaults to None / Terminal Only for bash

    // Submit adoption
    fireEvent.click(screen.getByTestId('submit-adopt-session'));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        serverId: 'srv-1',
        tmuxSessionName: 'my-external-shell',
        sessionName: 'my-external-shell',
        projectId: 'proj-1',
        projectPath: '/workspace/spawnea',
        agentId: undefined, // Terminal only
        harnessCommand: 'bash',
        task: 'my-external-shell',
      });
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('handles empty discovery gracefully', async () => {
    (window as any).spawneaApi.discoverExternalSessions = vi.fn().mockResolvedValue([]);

    render(
      <AdoptSessionModal
        isOpen={true}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('No unmanaged tmux sessions found')).toBeDefined();
    });
  });
});
