import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NewProjectModal } from './NewProjectModal';
import type { Server } from '@spawnea/domain';

const servers: Server[] = [{
  id: 'local',
  name: 'Local Workstation',
  host: 'localhost',
  sshPort: 22,
  enabled: true,
  createdAt: new Date(),
}];

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'spawneaApi');
});

describe('NewProjectModal', () => {
  it('discovers branches and submits a new catalog project', async () => {
    window.spawneaApi = {
      discoverProjectBranches: vi.fn().mockResolvedValue({
        isGitRepo: true,
        currentBranch: 'main',
        branches: ['main', 'develop'],
        suggestedBranches: ['main', 'develop'],
      }),
    } as any;
    const onSubmit = vi.fn().mockResolvedValue({ success: true });

    render(<NewProjectModal isOpen={true} onClose={vi.fn()} onSubmit={onSubmit} servers={servers} onOpenSettings={vi.fn()} />);
    fireEvent.change(screen.getByTestId('new-project-id'), { target: { value: 'demo-project' } });
    fireEvent.change(screen.getByTestId('new-project-name'), { target: { value: 'Demo Project' } });
    fireEvent.change(screen.getByTestId('new-project-path'), { target: { value: '~/code/demo-project' } });
    fireEvent.click(screen.getByTestId('new-project-discover-branches'));

    await waitFor(() => expect(screen.getByTestId('new-project-branch-main')).toBeDefined());
    fireEvent.click(screen.getByTestId('new-project-branch-main'));
    fireEvent.click(screen.getByTestId('new-project-submit'));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        serverId: 'local',
        projectId: 'demo-project',
        name: 'Demo Project',
        path: '~/code/demo-project',
        gitUrl: undefined,
        baseBranch: 'main',
      });
    });
  });

  it('shows catalog errors and does not close after a rejected save', async () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn().mockResolvedValue({ success: false, error: 'Project ID already exists' });

    render(<NewProjectModal isOpen={true} onClose={onClose} onSubmit={onSubmit} servers={servers} onOpenSettings={vi.fn()} />);
    fireEvent.change(screen.getByTestId('new-project-id'), { target: { value: 'duplicate' } });
    fireEvent.change(screen.getByTestId('new-project-name'), { target: { value: 'Duplicate' } });
    fireEvent.change(screen.getByTestId('new-project-path'), { target: { value: '~/code/duplicate' } });
    fireEvent.click(screen.getByTestId('new-project-submit'));

    await waitFor(() => expect(screen.getByTestId('new-project-error').textContent).toContain('already exists'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('fills the path from the native folder picker', async () => {
    const chooseProjectPath = vi.fn().mockResolvedValue({ canceled: false, path: '/selected/demo-project' });
    window.spawneaApi = { chooseProjectPath } as any;

    render(<NewProjectModal isOpen={true} onClose={vi.fn()} onSubmit={vi.fn()} servers={servers} onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByTestId('new-project-choose-path'));

    await waitFor(() => expect((screen.getByTestId('new-project-path') as HTMLInputElement).value).toBe('/selected/demo-project'));
    expect(chooseProjectPath).toHaveBeenCalledWith('local', undefined);
  });
});
