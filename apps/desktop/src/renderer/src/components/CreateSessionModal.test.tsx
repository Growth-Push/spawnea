import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { CreateSessionModal } from './CreateSessionModal';
import type { Server, Project, Agent } from '@spawnea/domain';

describe('CreateSessionModal', () => {
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
    {
      id: 'srv-2',
      name: 'Remote Box',
      host: '192.0.2.100',
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
    {
      id: 'srv-1:frontend',
      serverId: 'srv-1',
      name: 'Web Frontend',
      rootPath: '/srv/code/frontend-app',
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

  it('renders target host segmented pills with local and remote indicators without latency or offline badges', () => {
    render(
      <CreateSessionModal
        isOpen={true}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        servers={mockServers}
        projects={mockProjects}
        agents={mockAgents}
        hostHealthMap={{
          'srv-1': { hostId: 'srv-1', target: 'localhost', status: 'healthy', latencyMs: 8, lastCheckedAt: new Date().toISOString() },
          'srv-2': { hostId: 'srv-2', target: '192.0.2.100', status: 'unreachable', latencyMs: 45, lastCheckedAt: new Date().toISOString() },
        }}
      />
    );

    expect(screen.getByTestId('host-pill-group')).toBeDefined();
    expect(screen.getByTestId('host-badge-local')).toBeDefined();
    expect(screen.getByTestId('host-badge-remote')).toBeDefined();
    expect(screen.queryByTestId('host-latency')).toBeNull();
    expect(screen.queryByText('offline')).toBeNull();
  });

  it('allows 1-click host selection via segmented pills and keyboard navigation', () => {
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

    const nativeSelect = screen.getByTestId('select-server') as HTMLSelectElement;
    expect(nativeSelect.value).toBe('srv-1');

    // Click srv-2 pill directly (1-click selection)
    const srv2Pill = screen.getByTestId('host-pill-srv-2');
    fireEvent.click(srv2Pill);
    expect(nativeSelect.value).toBe('srv-2');

    // Arrow navigation from active pill to previous pill
    const activeHostTrigger = screen.getByTestId('select-server-trigger');
    fireEvent.keyDown(activeHostTrigger, { key: 'ArrowLeft' });
    expect(nativeSelect.value).toBe('srv-1');

    // Number key selection
    fireEvent.keyDown(activeHostTrigger, { key: '2' });
    expect(nativeSelect.value).toBe('srv-2');
  });

  it('filters projects in real time when typing in searchable combobox', async () => {
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

    const input = screen.getByTestId('select-project-input') as HTMLInputElement;

    // Filter by name
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Frontend' } });

    expect(screen.getByRole('listbox')).toBeDefined();
    expect(screen.getByRole('option', { name: /Web Frontend/ })).toBeDefined();
    expect(screen.queryByRole('option', { name: /Spawnea/ })).toBeNull();

    // Filter by path
    fireEvent.change(input, { target: { value: 'spawnea' } });
    expect(screen.getByRole('option', { name: /Spawnea/ })).toBeDefined();
    expect(screen.queryByRole('option', { name: /Web Frontend/ })).toBeNull();
  });

  it('navigates project combobox options with ArrowDown, ArrowUp, and Enter', () => {
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

    const input = screen.getByTestId('select-project-input');
    const nativeSelect = screen.getByTestId('select-project') as HTMLSelectElement;
    expect(nativeSelect.value).toBe('srv-1:spawnea');

    // Press ArrowDown to open and move highlight to second project
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeDefined();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(nativeSelect.value).toBe('srv-1:frontend');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('appends "+ New Project..." option at the bottom and triggers onOpenNewProject on click or N', () => {
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

    const trigger = screen.getByTestId('select-project-trigger');
    fireEvent.click(trigger);

    const newProjectOption = screen.getByRole('option', { name: /\+ New Project\.\.\./ });
    expect(newProjectOption).toBeDefined();
    fireEvent.click(newProjectOption);
    expect(onOpenNewProject).toHaveBeenCalledWith('srv-1');

    // Keyboard shortcut 'n' / 'N' on trigger
    onOpenNewProject.mockClear();
    fireEvent.keyDown(trigger, { key: 'n' });
    expect(onOpenNewProject).toHaveBeenCalledWith('srv-1');

    // Typing 'n' inside search input must not trigger onOpenNewProject
    onOpenNewProject.mockClear();
    const input = screen.getByTestId('select-project-input');
    fireEvent.keyDown(input, { key: 'n' });
    expect(onOpenNewProject).not.toHaveBeenCalled();
  });

  it('renders two-tier agent selection with provider pills and profile selection', () => {
    const multiAgents: Agent[] = [
      {
        id: 'srv-1:hermes-fast',
        name: 'Hermes Fast',
        command: 'hermes --fast',
        harness: 'hermes',
        createdAt: new Date(),
      },
      {
        id: 'srv-1:hermes-pro',
        name: 'Hermes Reasoning',
        command: 'hermes --deep',
        harness: 'hermes',
        createdAt: new Date(),
      },
      {
        id: 'srv-1:grok',
        name: 'Grok Beta',
        command: 'grok',
        harness: 'grok',
        createdAt: new Date(),
      },
      {
        id: 'srv-1:shell',
        name: 'Interactive Shell',
        command: 'bash',
        harness: 'shell',
        createdAt: new Date(),
      },
    ];

    render(
      <CreateSessionModal
        isOpen={true}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        servers={mockServers}
        projects={mockProjects}
        agents={multiAgents}
      />
    );

    // Top tier: Provider group exists with brand icons
    const providerGroup = screen.getByTestId('agent-provider-group');
    expect(providerGroup).toBeDefined();
    expect(within(providerGroup).getByTestId('provider-icon-hermes')).toBeDefined();
    expect(screen.getByTestId('provider-radio-grok')).toBeDefined();
    expect(screen.getByTestId('provider-radio-shell')).toBeDefined();

    // Secondary tier: Hermes has multiple profiles so profile selector is shown
    expect(screen.getByTestId('agent-profile-selector')).toBeDefined();
    expect(screen.getByTestId('profile-pill-srv-1:hermes-fast')).toBeDefined();
    expect(screen.getByTestId('profile-pill-srv-1:hermes-pro')).toBeDefined();

    // Selecting Hermes Reasoning profile updates agentId
    fireEvent.click(screen.getByTestId('profile-pill-srv-1:hermes-pro'));
    const nativeSelect = screen.getByTestId('select-agent') as HTMLSelectElement;
    expect(nativeSelect.value).toBe('srv-1:hermes-pro');

    // Switching provider to Grok
    fireEvent.click(screen.getByTestId('provider-radio-grok'));
    expect(nativeSelect.value).toBe('srv-1:grok');
  });

  it('transforms task name into lowercase slug and provides live preview of branch and tmux', () => {
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

    const taskInput = screen.getByTestId('input-task-name');
    fireEvent.change(taskInput, { target: { value: 'Fix OAuth Login Bug #404!' } });

    // Slug: lowercase, hyphenated, alphanumeric, max 30
    const previewSlug = screen.getByTestId('preview-slug');
    expect(previewSlug.textContent).toBe('fix-oauth-login-bug-404');

    const previewTmux = screen.getByTestId('preview-tmux-session');
    expect(previewTmux.textContent).toBe('spawnea-fix-oauth-login-bug-404');
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
    await waitFor(() => {
      expect(document.activeElement).toBe(hostTrigger);
    });
  });

  it('closes only the open combobox dropdown and keeps modal open when Escape is pressed on project combobox', () => {
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

    const input = screen.getByTestId('select-project-input');
    fireEvent.focus(input);
    expect(screen.getByRole('listbox')).toBeDefined();

    // Press Escape on the open combobox
    fireEvent.keyDown(input, { key: 'Escape' });
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
          id: 'srv-1',
          name: 'Local Workstation',
          enabled: true,
          projects: {
            'srv-1:spawnea': {
              id: 'srv-1:spawnea',
              name: 'Spawnea',
              path: '/workspace/spawnea',
              enabled: true,
              worktree: { enabled: true, copy_files: [] },
            },
          },
          harnesses: {},
        },
      },
    };
    const props = {
      isOpen: true,
      onClose: vi.fn(),
      onSubmit: vi.fn(),
      servers: mockServers,
      projects: mockProjects,
      agents: mockAgents,
      catalog,
    };
    const { rerender } = render(<CreateSessionModal {...props} />);
    fireEvent.click(screen.getByTestId('checkbox-use-worktree'));
    expect((screen.getByTestId('checkbox-use-worktree') as HTMLInputElement).checked).toBe(true);

    rerender(
      <CreateSessionModal
        {...props}
        servers={[...mockServers]}
        agents={[...mockAgents]}
        projects={[...mockProjects]}
      />
    );
    expect((screen.getByTestId('checkbox-use-worktree') as HTMLInputElement).checked).toBe(true);

    rerender(<CreateSessionModal {...props} isOpen={false} />);
    rerender(<CreateSessionModal {...props} />);
    expect((screen.getByTestId('checkbox-use-worktree') as HTMLInputElement).checked).toBe(false);
  });

  it('keeps connection test and retry buttons in the sequential keyboard focus order', async () => {
    const testServer = vi
      .fn()
      .mockResolvedValueOnce({ success: true, hostId: 'srv-1', target: 'localhost' })
      .mockResolvedValueOnce({ success: false, hostId: 'srv-1', target: 'localhost', error: 'Unavailable' });
    const originalApi = window.spawneaApi;
    window.spawneaApi = { ...originalApi, testServer };
    try {
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
    const nativeSelect = screen.getByTestId('select-server') as HTMLSelectElement;

    // Ctrl+2 or Alt+2 should not select server 2
    fireEvent.keyDown(hostTrigger, { key: '2', ctrlKey: true });
    expect(nativeSelect.value).toBe('srv-1');

    fireEvent.keyDown(hostTrigger, { key: '2', altKey: true });
    expect(nativeSelect.value).toBe('srv-1');
  });

  it('allows opening new project when host has 0 projects and onOpenNewProject is passed', () => {
    const onOpenNewProject = vi.fn();
    render(
      <CreateSessionModal
        isOpen={true}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        servers={mockServers}
        projects={[]}
        agents={mockAgents}
        onOpenNewProject={onOpenNewProject}
      />
    );

    const trigger = screen.getByTestId('select-project-trigger') as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    fireEvent.click(trigger);

    const newProjectOption = screen.getByRole('option', { name: /\+ New Project\.\.\./ });
    expect(newProjectOption).toBeDefined();
    fireEvent.click(newProjectOption);
    expect(onOpenNewProject).toHaveBeenCalledWith('srv-1');

    // Shortcut 'n' should also work
    onOpenNewProject.mockClear();
    fireEvent.keyDown(trigger, { key: 'n' });
    expect(onOpenNewProject).toHaveBeenCalledWith('srv-1');
  });

  it('navigates provider pills with ArrowRight / ArrowLeft and respects canonical order', () => {
    const customAgents: Agent[] = [
      { id: 'srv-1:shell', name: 'Shell', command: 'bash', harness: 'shell', createdAt: new Date() },
      { id: 'srv-1:hermes', name: 'Hermes', command: 'hermes', harness: 'hermes', createdAt: new Date() },
      { id: 'srv-1:codex', name: 'Codex', command: 'codex', harness: 'codex', createdAt: new Date() },
    ];

    render(
      <CreateSessionModal
        isOpen={true}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        servers={mockServers}
        projects={mockProjects}
        agents={customAgents}
      />
    );

    // Initial agent is first available agent: srv-1:hermes (or user clicks codex)
    // Canonical order in pill selector: codex (idx 0) -> hermes (idx 1) -> shell (idx 2)
    const codexRadio = screen.getByTestId('provider-radio-codex');
    fireEvent.click(codexRadio);

    const nativeSelect = screen.getByTestId('select-agent') as HTMLSelectElement;
    expect(nativeSelect.value).toBe('srv-1:codex');

    const codexTrigger = screen.getByTestId('select-agent-trigger');
    // ArrowRight should move to Hermes (next in canonical order)
    fireEvent.keyDown(codexTrigger, { key: 'ArrowRight' });
    expect(nativeSelect.value).toBe('srv-1:hermes');

    // Number key '3' should move to shell (3rd provider)
    const hermesTrigger = screen.getByTestId('select-agent-trigger');
    fireEvent.keyDown(hermesTrigger, { key: '3' });
    expect(nativeSelect.value).toBe('srv-1:shell');
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

    const projectTrigger = screen.getByTestId('select-project-trigger');
    expect(projectTrigger.textContent).toContain('No projects for host');

    const agentTrigger = screen.getByTestId('select-agent-trigger');
    expect(agentTrigger.textContent).toContain('No harnesses for host');
  });
});
