import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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
});
