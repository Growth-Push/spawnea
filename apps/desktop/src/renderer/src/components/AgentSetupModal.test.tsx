import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentSetupModal } from './AgentSetupModal';
import type { OperationalCatalog } from '@spawnea/domain';

const mockCatalog: OperationalCatalog = {
  version: 1,
  hosts: {
    'srv-local': {
      id: 'srv-local',
      name: 'Local Workstation',
      enabled: true,
      harnesses: {
        'codex-cli': {
          id: 'codex-cli',
          name: 'Codex CLI',
          command: 'codex',
          args: [],
          enabled: true,
        },
      },
      projects: {
        'proj-spawnea': {
          id: 'proj-spawnea',
          name: 'Spawnea Project',
          path: '/workspace/mock-user/code/spawnea',
          base_branch: 'main',
          enabled: true,
        },
      },
    },
  },
};

describe('AgentSetupModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });

    (window as any).spawneaApi = {
      getCliPathStatus: vi.fn().mockResolvedValue({
        installed: false,
        targetPath: '/path/to/resources/spawnea',
        symlinkPath: '/workspace/mock-user/.local/bin/spawnea',
        isValid: false,
      }),
      installCliInPath: vi.fn().mockResolvedValue({
        installed: true,
        targetPath: '/path/to/resources/spawnea',
        symlinkPath: '/workspace/mock-user/.local/bin/spawnea',
        isValid: true,
      }),
      getActiveProfile: vi.fn().mockResolvedValue(null),
    };
  });

  it('opens, closes, and reopens without changing hook order', async () => {
    const onClose = vi.fn();
    const modal = (isOpen: boolean) => (
      <AgentSetupModal
        isOpen={isOpen}
        catalog={mockCatalog}
        profile="test-profile"
        onClose={onClose}
      />
    );
    const { rerender } = render(modal(false));
    expect(screen.queryByRole('dialog')).toBeNull();

    for (let cycle = 0; cycle < 2; cycle += 1) {
      rerender(modal(true));
      expect(screen.getByRole('dialog')).toBeDefined();
      expect(screen.getByTestId('shell-completion-snippet').textContent)
        .toContain('export SPAWNEA_PROFILE="test-profile"');
      await waitFor(() => {
        expect(window.spawneaApi.getCliPathStatus).toHaveBeenCalledTimes(cycle + 1);
      });
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(cycle + 1);
      rerender(modal(false));
      expect(screen.queryByRole('dialog')).toBeNull();
    }
  });

  it('renders modal with instruction card, catalog summary, and PATH install section', async () => {
    render(
      <AgentSetupModal
        isOpen={true}
        catalog={mockCatalog}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByTestId('agent-setup-modal')).toBeDefined();
    expect(screen.getByText('Configure Spawnea with your Agent')).toBeDefined();
    expect(screen.getByText('Copy and send this to your agent')).toBeDefined();
    expect(screen.getAllByText(/Spawnea Project/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/codex-cli/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId('install-cli-path-button')).toBeDefined();
  });

  it('copies prompt instructions containing live catalog when clicking copy button', async () => {
    render(
      <AgentSetupModal
        isOpen={true}
        catalog={mockCatalog}
        onClose={vi.fn()}
      />
    );

    const copyBtn = screen.getByTestId('copy-prompt-instruction-button');
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalled();
      const copiedText = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
      expect(copiedText).toContain('Spawnea Agent Orchestration');
      expect(copiedText).toContain('proj-spawnea');
      expect(copiedText).toContain('/workspace/mock-user/code/spawnea');
      expect(copiedText).toContain('codex-cli');
    });
  });

  it('installs CLI to user PATH when clicking install button', async () => {
    render(
      <AgentSetupModal
        isOpen={true}
        catalog={mockCatalog}
        onClose={vi.fn()}
      />
    );

    const installBtn = screen.getByTestId('install-cli-path-button');
    fireEvent.click(installBtn);

    await waitFor(() => {
      expect((window as any).spawneaApi.installCliInPath).toHaveBeenCalled();
      expect(screen.getByText('Installed in ~/.local/bin/spawnea')).toBeDefined();
    });
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(
      <AgentSetupModal
        isOpen={true}
        catalog={mockCatalog}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByTestId('agent-setup-close-button'));
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when Escape key is pressed', () => {
    const onClose = vi.fn();
    render(
      <AgentSetupModal
        isOpen={true}
        catalog={mockCatalog}
        onClose={onClose}
      />
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('switches between Zsh and Bash shell completion tabs', async () => {
    render(
      <AgentSetupModal
        isOpen={true}
        catalog={mockCatalog}
        onClose={vi.fn()}
      />
    );

    // Initial tab is Zsh
    const snippetEl = screen.getByTestId('shell-completion-snippet');
    expect(snippetEl.textContent).toContain('completion zsh');

    // Switch to Bash
    fireEvent.click(screen.getByTestId('shell-tab-bash'));
    expect(snippetEl.textContent).toContain('completion bash');

    // Copying copies the active bash snippet
    const copyBtn = screen.getByTestId('copy-completion-command-button');
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('eval "$(spawnea completion bash)"');
    });

    // Switch back to Zsh
    fireEvent.click(screen.getByTestId('shell-tab-zsh'));
    expect(snippetEl.textContent).toContain('completion zsh');
  });

  it('preserves host-qualified project and harness IDs and excludes disabled entries', async () => {
    const catalogWithDisabled: OperationalCatalog = {
      version: 1,
      hosts: {
        local: {
          id: 'local',
          name: 'Local Host',
          enabled: true,
          harnesses: {
            activeHarness: {
              id: 'activeHarness',
              name: 'Active Harness',
              command: 'codex',
              args: [],
              enabled: true,
            },
            disabledHarness: {
              id: 'disabledHarness',
              name: 'Disabled Harness',
              command: 'claude',
              args: [],
              enabled: false,
            },
          },
          projects: {
            activeProject: {
              id: 'activeProject',
              name: 'Active Project',
              path: '/path/active',
              base_branch: 'main',
              enabled: true,
            },
            disabledProject: {
              id: 'disabledProject',
              name: 'Disabled Project',
              path: '/path/disabled',
              base_branch: 'main',
              enabled: false,
            },
          },
        },
        disabledHost: {
          id: 'disabledHost',
          name: 'Disabled Host',
          enabled: false,
          harnesses: {},
          projects: {},
        },
      },
    };

    render(
      <AgentSetupModal
        isOpen={true}
        catalog={catalogWithDisabled}
        onClose={vi.fn()}
      />
    );

    const copyBtn = screen.getByTestId('copy-prompt-instruction-button');
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalled();
      const prompt = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
      // Qualified ID with host prefix preserved, even for local host
      expect(prompt).toContain('local:activeProject');
      expect(prompt).toContain('local:activeHarness');
      // Disabled entries excluded
      expect(prompt).not.toContain('local:disabledProject');
      expect(prompt).not.toContain('local:disabledHarness');
      expect(prompt).not.toContain('disabledHost');
    });
  });

  it('renders PATH warning notice when CLI is installed but not in PATH', async () => {
    (window as any).spawneaApi.getCliPathStatus = vi.fn().mockResolvedValue({
      installed: true,
      targetPath: '/workspace/mock-user/resources/spawnea',
      symlinkPath: '/workspace/mock-user/.local/bin/spawnea',
      isValid: true,
      isInPath: false,
    });

    render(
      <AgentSetupModal
        isOpen={true}
        catalog={mockCatalog}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('cli-not-in-path-warning')).toBeDefined();
      expect(screen.getByText(/~[/\\]\.local[/\\]bin is not in your PATH/)).toBeDefined();
    });
  });

  it('does not re-steal focus when parent component re-renders with a new onClose callback', async () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <AgentSetupModal
          isOpen={true}
          catalog={mockCatalog}
          onClose={vi.fn()}
        />
      );

      // Fast-forward initial focus timer
      vi.advanceTimersByTime(60);
      const closeBtn = screen.getByTestId('agent-setup-close-button');
      expect(document.activeElement).toBe(closeBtn);

      // Now focus the copy button
      const copyBtn = screen.getByTestId('copy-prompt-instruction-button');
      copyBtn.focus();
      expect(document.activeElement).toBe(copyBtn);

      // Re-render with a fresh callback (simulating App re-render)
      rerender(
        <AgentSetupModal
          isOpen={true}
          catalog={mockCatalog}
          onClose={vi.fn()}
        />
      );

      vi.advanceTimersByTime(100);
      // Focus should remain on copyBtn, NOT stolen back to closeBtn
      expect(document.activeElement).toBe(copyBtn);
    } finally {
      vi.useRealTimers();
    }
  });

  it('includes named profile flags and environment variables when profile is active', async () => {
    (window as any).spawneaApi.getActiveProfile = vi.fn().mockResolvedValue('work-profile');

    render(
      <AgentSetupModal
        isOpen={true}
        catalog={mockCatalog}
        profile="work-profile"
        onClose={vi.fn()}
      />
    );

    // Profile badge shown in header and catalog
    expect(screen.getByTestId('agent-setup-profile-badge').textContent).toContain('work-profile');
    expect(screen.getByTestId('catalog-profile-indicator').textContent).toContain('work-profile');

    // Completion snippet includes export SPAWNEA_PROFILE="work-profile"
    const snippetEl = screen.getByTestId('shell-completion-snippet');
    expect(snippetEl.textContent).toContain('export SPAWNEA_PROFILE="work-profile"');

    // Copying prompt contains --profile work-profile and SPAWNEA_PROFILE explanation
    const copyBtn = screen.getByTestId('copy-prompt-instruction-button');
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalled();
      const prompt = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
      expect(prompt).toContain('--profile work-profile');
      expect(prompt).toContain('SPAWNEA_PROFILE');
      expect(prompt).toContain('### Active Profile\n- `work-profile`');
    });
  });
});
