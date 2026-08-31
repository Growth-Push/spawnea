import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@spawnea/domain';
import { CatalogManager } from './catalog-manager.js';
import { LocalDiscoveryService, parseHostsSuggestions } from './local-discovery-service.js';

const catalogYaml = `# retained catalog comment
version: 1
hosts:
  local:
    name: Local Machine
    enabled: true
    projects: {}
    harnesses: {}
`;

describe('local discovery security parser', () => {
  it('discards an entire suspicious line and never returns sensitive aliases', () => {
    const result = parseHostsSuggestions(`
192.0.2.2 safe-box safe-box.example.test
192.0.2.3 production pass
192.0.2.4 token-vault
192.0.2.5 safe credential=value
192.0.2.6 url https://example.test
192.0.2.7 commented-safe # password belongs only to a comment
not-an-ip ignored-host
127.0.0.1 localhost
`);

    expect(result).toEqual([
      { alias: 'safe-box', address: '192.0.2.2' },
      { alias: 'safe-box.example.test', address: '192.0.2.2' },
      { alias: 'commented-safe', address: '192.0.2.7' },
    ]);
  });

  it('rejects control characters and malformed aliases', () => {
    expect(parseHostsSuggestions('192.0.2.2 good\u0000bad\n192.0.2.3 -invalid')).toEqual([]);
  });
});

describe('LocalDiscoveryService', () => {
  let directory: string;
  let catalogPath: string;
  let manager: CatalogManager;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'spawnea-discovery-'));
    catalogPath = join(directory, 'spawnea.yaml');
    writeFileSync(catalogPath, catalogYaml, 'utf8');
    manager = new CatalogManager({ catalogPath });
    manager.load();
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function createService(readHosts = vi.fn().mockResolvedValue('192.0.2.8 build-box')) {
    return {
      readHosts,
      service: new LocalDiscoveryService(manager, createLogger('LocalDiscoveryTest'), {
        readHosts,
        pathValue: '/allowlisted/bin',
        resolveHarness: vi.fn(async (commands) => ({ command: commands[0], path: `/allowlisted/bin/${commands[0]}` })),
      }),
    };
  }

  it('does not scan automatically and only checks the fixed harness allowlist', async () => {
    const { service, readHosts } = createService();
    expect(readHosts).not.toHaveBeenCalled();

    const result = await service.scan();
    expect(readHosts).toHaveBeenCalledTimes(1);
    expect(result.harnesses.map((item) => item.candidateId)).toEqual(['claude', 'codex', 'hermes', 'opencode', 'shell']);
    expect(result.localHosts).toEqual([{ id: 'local', name: 'Local Machine' }]);
  });

  it('reports a hosts-file permission failure without blocking harness suggestions', async () => {
    const { service } = createService(vi.fn().mockRejectedValue(new Error('permission denied')));
    const result = await service.scan();
    expect(result.hosts).toEqual([]);
    expect(result.warnings).toContain('Could not read the local hosts file. No host suggestions are shown.');
    expect(result.harnesses.every((item) => item.found)).toBe(true);
  });

  it('keeps scan and preview byte-for-byte read-only, then applies only the confirmed preview', async () => {
    const { service } = createService();
    const before = readFileSync(catalogPath, 'utf8');
    const scan = await service.scan();
    expect(readFileSync(catalogPath, 'utf8')).toBe(before);

    const preview = await service.preview({
      scanId: scan.scanId,
      hosts: [],
      harnesses: [{ candidateId: 'codex', hostId: 'local', harnessId: 'codex', name: 'Codex CLI', mode: 'add' }],
    });
    expect(preview.success).toBe(true);
    expect(readFileSync(catalogPath, 'utf8')).toBe(before);

    const applied = await service.apply(preview.previewId!);
    expect(applied.success).toBe(true);
    const after = readFileSync(catalogPath, 'utf8');
    expect(after).toContain('# retained catalog comment');
    expect(manager.getActiveCatalog()?.hosts.local.harnesses.codex.command).toBe('/allowlisted/bin/codex');
  });

  it('rejects a stale confirmation and preserves the concurrent catalog edit', async () => {
    const { service } = createService();
    const scan = await service.scan();
    const preview = await service.preview({
      scanId: scan.scanId,
      hosts: [],
      harnesses: [{ candidateId: 'hermes', hostId: 'local', harnessId: 'hermes', name: 'Hermes', mode: 'add' }],
    });
    expect(preview.success).toBe(true);

    const externallyEdited = `${catalogYaml}\n# external edit\n`;
    writeFileSync(catalogPath, externallyEdited, 'utf8');
    const applied = await service.apply(preview.previewId!);

    expect(applied.success).toBe(false);
    expect(applied.conflict).toBe(true);
    expect(readFileSync(catalogPath, 'utf8')).toBe(externallyEdited);
  });

  it('rejects renderer-provided host keys and harnesses outside the latest scan evidence', async () => {
    const { service } = createService();
    const scan = await service.scan();
    const invalidHost = await service.preview({
      scanId: scan.scanId,
      hosts: [{ suggestionKey: 'forged', hostId: 'evil', name: 'Evil', mode: 'add' }],
      harnesses: [],
    });
    expect(invalidHost.success).toBe(false);

    const missingHarnessService = new LocalDiscoveryService(manager, createLogger('LocalDiscoveryTest'), {
      readHosts: async () => '',
      resolveHarness: async () => null,
    });
    const missingScan = await missingHarnessService.scan();
    const invalidHarness = await missingHarnessService.preview({
      scanId: missingScan.scanId,
      hosts: [],
      harnesses: [{ candidateId: 'codex', hostId: 'local', harnessId: 'codex', name: 'Codex', mode: 'add' }],
    });
    expect(invalidHarness.success).toBe(false);
  });
});
