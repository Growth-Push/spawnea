import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { OperationalCatalog } from '@spawnea/domain';
import { LocalDiscoveryModal } from './LocalDiscoveryModal';

const catalog: OperationalCatalog = {
  version: 1,
  hosts: {
    local: { id: 'local', name: 'Local Machine', enabled: true, projects: {}, harnesses: {} },
  },
};

afterEach(() => vi.restoreAllMocks());

describe('LocalDiscoveryModal', () => {
  it('does not scan on open and cancel performs no mutation', () => {
    const scanLocalSetup = vi.fn();
    const applyLocalDiscovery = vi.fn();
    window.spawneaApi = { scanLocalSetup, applyLocalDiscovery } as any;
    const onClose = vi.fn();
    render(<LocalDiscoveryModal isOpen catalog={catalog} onClose={onClose} onApplied={vi.fn()} />);

    expect(scanLocalSetup).not.toHaveBeenCalled();
    expect(screen.getByText(/does not execute commands/i)).toBeDefined();
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(applyLocalDiscovery).not.toHaveBeenCalled();
  });

  it('requires scan, selection, preview, and a separate confirmation before applying', async () => {
    const scanLocalSetup = vi.fn().mockResolvedValue({
      scanId: 'scan-1',
      hosts: [],
      harnesses: [{ candidateId: 'codex', name: 'Codex CLI', command: 'codex', found: true, resolvedPath: '/usr/bin/codex' }],
      localHosts: [{ id: 'local', name: 'Local Machine' }],
      warnings: [],
    });
    const previewLocalDiscovery = vi.fn().mockResolvedValue({
      success: true,
      previewId: 'preview-1',
      errors: [],
      changes: [{ operation: 'add', path: 'hosts.local.harnesses.codex', after: { command: '/usr/bin/codex' } }],
    });
    const applyLocalDiscovery = vi.fn().mockResolvedValue({ success: true, catalog, filePath: '/config.yaml', errors: null });
    window.spawneaApi = { scanLocalSetup, previewLocalDiscovery, applyLocalDiscovery } as any;
    const onApplied = vi.fn().mockResolvedValue(undefined);

    render(<LocalDiscoveryModal isOpen catalog={catalog} onClose={vi.fn()} onApplied={onApplied} />);
    fireEvent.click(screen.getByTestId('local-discovery-scan'));
    await waitFor(() => expect(scanLocalSetup).toHaveBeenCalledTimes(1));
    expect(applyLocalDiscovery).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByLabelText('Select harness Codex CLI'));
    fireEvent.click(screen.getByTestId('local-discovery-preview'));
    await waitFor(() => expect(previewLocalDiscovery).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/confirmation required/i)).toBeDefined();
    expect(applyLocalDiscovery).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('local-discovery-confirm'));
    await waitFor(() => expect(applyLocalDiscovery).toHaveBeenCalledWith('preview-1'));
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it('warns that normal monitoring may contact a host only after it becomes active configuration', async () => {
    window.spawneaApi = {
      scanLocalSetup: vi.fn().mockResolvedValue({
        scanId: 'scan-host',
        hosts: [{ key: 'host-1', alias: 'build-box', address: '192.0.2.8', suggestedHostId: 'build-box', suggestedName: 'build-box' }],
        harnesses: [],
        localHosts: [{ id: 'local', name: 'Local Machine' }],
        warnings: [],
      }),
      previewLocalDiscovery: vi.fn().mockResolvedValue({
        success: true,
        previewId: 'preview-host',
        errors: [],
        changes: [{ operation: 'add', path: 'hosts.build-box', after: { ssh: { target: 'build-box' } } }],
      }),
    } as any;
    render(<LocalDiscoveryModal isOpen catalog={catalog} onClose={vi.fn()} onApplied={vi.fn()} />);
    fireEvent.click(screen.getByTestId('local-discovery-scan'));
    fireEvent.click(await screen.findByLabelText('Select host build-box'));
    fireEvent.click(screen.getByTestId('local-discovery-preview'));
    expect(await screen.findByText(/normal host-health monitoring may later try/i)).toBeDefined();
  });
});
