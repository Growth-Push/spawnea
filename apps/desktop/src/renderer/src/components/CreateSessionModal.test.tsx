import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { CreateSessionModal } from './CreateSessionModal';
import type { Server, Project, Agent } from '@spawnea/domain';

describe('CreateSessionModal Harness Ordering', () => {
  afterEach(() => {
    cleanup();
  });

  const mockServers: Server[] = [
    {
      id: 'srv-1',
      name: 'Local Workstation',
      host: 'localhost',
      sshPort: 22,
      enabled: true,
      createdAt: new Date(),
    },
  ];

  const mockProjects: Project[] = [
    {
      id: 'srv-1:spawnea',
      serverId: 'srv-1',
      name: 'Spawnea',
      rootPath: '/workspace/spawnea',
      createdAt: new Date(),
    },
  ];

  const mockAgents: Agent[] = [
    {
      id: 'srv-1:shell',
      name: 'Interactive Shell',
      command: 'bash',
      harness: 'shell',
      createdAt: new Date(),
    },
    {
      id: 'srv-1:claude',
      name: 'Claude Code',
      command: 'claude',
      harness: 'claude',
      createdAt: new Date(),
    },
    {
      id: 'srv-1:codex',
      name: 'Codex CLI',
      command: 'codex',
      harness: 'codex',
      createdAt: new Date(),
    },
  ];

  it('orders harnesses so that interactive shell is always in the last position', () => {
    render(
      <CreateSessionModal
        isOpen={true}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
      />
    );

    const nativeSelect = screen.getByTestId('select-agent') as HTMLSelectElement;
    const optionValues = Array.from(nativeSelect.options).map((opt) => opt.value);

    // Shell must be placed last
    expect(optionValues[optionValues.length - 1]).toBe('srv-1:shell');
    expect(optionValues).toEqual(['srv-1:claude', 'srv-1:codex', 'srv-1:shell']);
  });

  it('renders "+ New Project..." option at the end when onOpenNewProject is provided', () => {
    render(
      <CreateSessionModal
        isOpen={true}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
        onOpenNewProject={vi.fn()}
      />
    );

    const projectSelect = screen.getByTestId('select-project') as HTMLSelectElement;
    const options = Array.from(projectSelect.options);
    const lastOption = options[options.length - 1];

    expect(lastOption.value).toBe('__new_project__');
    expect(lastOption.textContent).toBe('+ New Project...');
  });

  it('does not render "+ New Project..." option when onOpenNewProject is not provided', () => {
    render(
      <CreateSessionModal
        isOpen={true}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
      />
    );

    const projectSelect = screen.getByTestId('select-project') as HTMLSelectElement;
    const optionValues = Array.from(projectSelect.options).map((opt) => opt.value);
    expect(optionValues).not.toContain('__new_project__');
  });

  it('selecting "+ New Project..." invokes onOpenNewProject with current serverId', () => {
    const onOpenNewProject = vi.fn();
    render(
      <CreateSessionModal
        isOpen={true}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
        onOpenNewProject={onOpenNewProject}
      />
    );

    const projectSelect = screen.getByTestId('select-project') as HTMLSelectElement;
    projectSelect.value = '__new_project__';
    projectSelect.dispatchEvent(new Event('change', { bubbles: true }));

    expect(onOpenNewProject).toHaveBeenCalledWith('srv-1');
  });

  it('auto-selects createdProject when passed', () => {
    const { rerender } = render(
      <CreateSessionModal
        isOpen={true}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
        onOpenNewProject={vi.fn()}
      />
    );

    const extraProject: Project = {
      id: 'srv-1:extra-app',
      serverId: 'srv-1',
      name: 'Extra App',
      rootPath: '/workspace/extra',
      createdAt: new Date(),
    };

    rerender(
      <CreateSessionModal
        isOpen={true}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        servers={mockServers}
        projects={[...mockProjects, extraProject]}
        agents={mockAgents}
        onOpenNewProject={vi.fn()}
        createdProject={{ serverId: 'srv-1', projectId: 'extra-app' }}
      />
    );

    const projectSelect = screen.getByTestId('select-project') as HTMLSelectElement;
    expect(projectSelect.value).toBe('srv-1:extra-app');
  });

  it('does not close modal on Escape when hasChildModalOpen is true', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <CreateSessionModal
        isOpen={true}
        onClose={onClose}
        onSubmit={vi.fn()}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
        hasChildModalOpen={true}
      />
    );

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).not.toHaveBeenCalled();

    rerender(
      <CreateSessionModal
        isOpen={true}
        onClose={onClose}
        onSubmit={vi.fn()}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
        hasChildModalOpen={false}
      />
    );

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('places default focus on Target Host trigger when modal opens', async () => {
    render(
      <CreateSessionModal
        isOpen={true}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
      />
    );

    const hostTrigger = screen.getByTestId('select-server-trigger');
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(hostTrigger);
    });
  });

  it('expands Target Host combo with ArrowDown and selects with Enter', () => {
    const multiServers: Server[] = [
      ...mockServers,
      {
        id: 'srv-2',
        name: 'Remote Server',
        host: '192.0.2.100',
        sshPort: 22,
        enabled: true,
        createdAt: new Date(),
      },
    ];

    render(
      <CreateSessionModal
        isOpen={true}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        servers={multiServers}
        projects={mockProjects}
        agents={mockAgents}
      />
    );

    const hostTrigger = screen.getByTestId('select-server-trigger');
    const nativeSelect = screen.getByTestId('select-server') as HTMLSelectElement;
    expect(nativeSelect.value).toBe('srv-1');

    // Press ArrowDown to expand dropdown
    fireEvent.keyDown(hostTrigger, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeDefined();

    // Press ArrowDown again to move highlight to srv-2
    fireEvent.keyDown(hostTrigger, { key: 'ArrowDown' });

    // Press Enter to select
    fireEvent.keyDown(hostTrigger, { key: 'Enter' });

    expect(nativeSelect.value).toBe('srv-2');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('selects items in combos using number keys 1..0 and renders index badges', () => {
    const multiServers: Server[] = [
      ...mockServers,
      {
        id: 'srv-2',
        name: 'Remote Server',
        host: '192.0.2.100',
        sshPort: 22,
        enabled: true,
        createdAt: new Date(),
      },
    ];

    render(
      <CreateSessionModal
        isOpen={true}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        servers={multiServers}
        projects={mockProjects}
        agents={mockAgents}
      />
    );

    const hostTrigger = screen.getByTestId('select-server-trigger');
    const nativeSelect = screen.getByTestId('select-server') as HTMLSelectElement;

    // Open host dropdown to verify badges 1 and 2
    fireEvent.keyDown(hostTrigger, { key: 'ArrowDown' });
    expect(screen.getByText('1')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();

    // Press '2' to select second server
    fireEvent.keyDown(hostTrigger, { key: '2' });
    expect(nativeSelect.value).toBe('srv-2');

    // Press '1' to select first server
    fireEvent.keyDown(hostTrigger, { key: '1' });
    expect(nativeSelect.value).toBe('srv-1');
  });

  it('triggers + New Project... by pressing n or N when focused on Project Root', () => {
    const onOpenNewProject = vi.fn();
    render(
      <CreateSessionModal
        isOpen={true}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
        onOpenNewProject={onOpenNewProject}
      />
    );

    const projectTrigger = screen.getByTestId('select-project-trigger');

    // Open project dropdown and verify badge 'N' on New Project
    fireEvent.keyDown(projectTrigger, { key: 'ArrowDown' });
    expect(screen.getByText('N')).toBeDefined();

    // Press 'n' to trigger
    fireEvent.keyDown(projectTrigger, { key: 'n' });
    expect(onOpenNewProject).toHaveBeenCalledWith('srv-1');

    // Press 'N' to trigger again
    fireEvent.keyDown(projectTrigger, { key: 'N' });
    expect(onOpenNewProject).toHaveBeenCalledTimes(2);
  });

  it('closes only the open dropdown and keeps modal open when Escape is pressed on an open combo', () => {
    const onClose = vi.fn();
    render(
      <CreateSessionModal
        isOpen={true}
        onClose={onClose}
        onSubmit={vi.fn()}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
      />
    );

    const hostTrigger = screen.getByTestId('select-server-trigger');
    fireEvent.keyDown(hostTrigger, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeDefined();

    // Press Escape on the open combo
    fireEvent.keyDown(hostTrigger, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('defaults worktree to unchecked even when project has worktree configured in catalog', () => {
    const catalog = {
      version: 1 as const,
      hosts: {
        'srv-1': {
          id: 'srv-1',
          name: 'Local Workstation',
          enabled: true,
          projects: {
            'srv-1:spawnea': {
              id: 'srv-1:spawnea',
              name: 'Spawnea',
              path: '/workspace/spawnea',
              enabled: true,
              worktree: {
                enabled: true,
                copy_files: [],
              },
            },
          },
          harnesses: {},
        },
      },
    };

    render(
      <CreateSessionModal
        isOpen={true}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
        catalog={catalog}
      />
    );

    const checkbox = screen.getByTestId('checkbox-use-worktree') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it('preserves an explicit worktree choice on list refresh and resets it on reopen', () => {
    const catalog = {
      version: 1 as const,
      hosts: {
        'srv-1': {
          id: 'srv-1', name: 'Local Workstation', enabled: true,
          projects: {
            'srv-1:spawnea': {
              id: 'srv-1:spawnea', name: 'Spawnea', path: '/workspace/spawnea',
              enabled: true, worktree: { enabled: true, copy_files: [] },
            },
          },
          harnesses: {},
        },
      },
    };
    const props = {
      isOpen: true, onClose: vi.fn(), onSubmit: vi.fn(),
      servers: mockServers, projects: mockProjects, agents: mockAgents, catalog,
    };
    const { rerender } = render(<CreateSessionModal {...props} />);
    fireEvent.click(screen.getByTestId('checkbox-use-worktree'));
    expect((screen.getByTestId('checkbox-use-worktree') as HTMLInputElement).checked).toBe(true);

    rerender(<CreateSessionModal {...props} servers={[...mockServers]} agents={[...mockAgents]} projects={[...mockProjects]} />);
    expect((screen.getByTestId('checkbox-use-worktree') as HTMLInputElement).checked).toBe(true);

    rerender(<CreateSessionModal {...props} isOpen={false} />);
    rerender(<CreateSessionModal {...props} />);
    expect((screen.getByTestId('checkbox-use-worktree') as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByTestId('checkbox-use-worktree'));
    rerender(<CreateSessionModal {...props} catalog={{ ...catalog, hosts: {} }} />);
    expect((screen.getByTestId('checkbox-use-worktree') as HTMLInputElement).checked).toBe(false);
  });

  it('keeps connection test and retry buttons in the sequential keyboard focus order', async () => {
    const testServer = vi.fn()
      .mockResolvedValueOnce({ success: true, hostId: 'srv-1', target: 'localhost' })
      .mockResolvedValueOnce({ success: false, hostId: 'srv-1', target: 'localhost', error: 'Unavailable' });
    const originalApi = window.spawneaApi;
    window.spawneaApi = { ...originalApi, testServer };
    try {
      render(<CreateSessionModal isOpen={true} onClose={vi.fn()} onSubmit={vi.fn()}
        servers={mockServers} projects={mockProjects} agents={mockAgents} />);
      const assertFocusable = (id: string) => {
        const button = screen.getByTestId(id);
        expect(button.tabIndex).toBe(0);
        expect((button as HTMLButtonElement).disabled).toBe(false);
        button.focus();
        expect(document.activeElement).toBe(button);
        return button;
      };
      fireEvent.click(assertFocusable('test-host-button'));
      await screen.findByTestId('host-status-connected');
      fireEvent.click(assertFocusable('test-host-button'));
      await screen.findByTestId('retry-host-test');
      assertFocusable('retry-host-test');
    } finally {
      window.spawneaApi = originalApi;
    }
  });

  it('ignores shortcuts and navigation when modifier keys (ctrl, meta, alt) are pressed', () => {
    const multiServers: Server[] = [
      ...mockServers,
      {
        id: 'srv-2',
        name: 'Remote Server',
        host: '192.0.2.100',
        sshPort: 22,
        enabled: true,
        createdAt: new Date(),
      },
    ];
    const onOpenNewProject = vi.fn();

    render(
      <CreateSessionModal
        isOpen={true}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        servers={multiServers}
        projects={mockProjects}
        agents={mockAgents}
        onOpenNewProject={onOpenNewProject}
      />
    );

    const hostTrigger = screen.getByTestId('select-server-trigger');
    const nativeSelect = screen.getByTestId('select-server') as HTMLSelectElement;

    // Ctrl+2 or Alt+2 should not select server 2
    fireEvent.keyDown(hostTrigger, { key: '2', ctrlKey: true });
    expect(nativeSelect.value).toBe('srv-1');

    fireEvent.keyDown(hostTrigger, { key: '2', altKey: true });
    expect(nativeSelect.value).toBe('srv-1');

    fireEvent.keyDown(hostTrigger, { key: '2', metaKey: true });
    expect(nativeSelect.value).toBe('srv-1');

    // Ctrl+Enter or Alt+Space should not open the dropdown
    fireEvent.keyDown(hostTrigger, { key: 'Enter', ctrlKey: true });
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.keyDown(hostTrigger, { key: ' ', altKey: true });
    expect(screen.queryByRole('listbox')).toBeNull();

    // Ctrl+n or Alt+n on project trigger should not trigger onOpenNewProject
    const projectTrigger = screen.getByTestId('select-project-trigger');
    fireEvent.keyDown(projectTrigger, { key: 'n', ctrlKey: true });
    expect(onOpenNewProject).not.toHaveBeenCalled();

    fireEvent.keyDown(projectTrigger, { key: 'n', altKey: true });
    expect(onOpenNewProject).not.toHaveBeenCalled();
  });

  it('handles empty options gracefully without opening dropdown or throwing', () => {
    render(
      <CreateSessionModal
        isOpen={true}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        servers={[]}
        projects={[]}
        agents={[]}
      />
    );

    const hostTrigger = screen.getByTestId('select-server-trigger');
    expect(hostTrigger.textContent).toContain('No hosts configured');

    // Clicking when options are empty does not open dropdown
    fireEvent.click(hostTrigger);
    expect(screen.queryByRole('listbox')).toBeNull();

    // Keyboard navigation when options are empty does not open dropdown
    fireEvent.keyDown(hostTrigger, { key: 'ArrowDown' });
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.keyDown(hostTrigger, { key: 'Enter' });
    expect(screen.queryByRole('listbox')).toBeNull();

    const projectTrigger = screen.getByTestId('select-project-trigger');
    expect(projectTrigger.textContent).toContain('No projects for host');

    const agentTrigger = screen.getByTestId('select-agent-trigger');
    expect(agentTrigger.textContent).toContain('No harnesses for host');
  });
});
