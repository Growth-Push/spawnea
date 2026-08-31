import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, readFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { CatalogManager } from './catalog-manager.js';

describe('CatalogManager (Main Process)', () => {
  let tempDir: string;
  let tempCatalogPath: string;

  const validYaml = `
version: 1
hosts:
  example-remote:
    name: Example Remote
    enabled: true
    ssh:
      target: example-host
      user: developer
      port: 22
    projects:
      spawnea:
        name: Spawnea
        path: ~/code/Spawnea
        git_url: https://github.com/example/Spawnea.git
    harnesses:
      codex:
        name: Codex
        command: codex
        args: []
`;

  const updatedValidYaml = `
version: 1
hosts:
  example-remote:
    name: Example Remote Updated
    enabled: true
    ssh:
      target: example-host
      user: developer
      port: 2222
    projects:
      spawnea:
        name: Spawnea Pro
        path: ~/code/SpawneaPro
    harnesses:
      hermes:
        name: Hermes
        command: hermes
        args: ["agent"]
`;

  const invalidYamlSyntax = `
version: 1
hosts:
  example-remote:
    name: [broken yaml
`;

  const invalidSchemaYaml = `
version: 2
hosts:
  Arch-Invalid-ID:
    name: Bad Host
`;

  beforeEach(() => {
    tempDir = join(tmpdir(), `spawnea-catalog-test-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`);
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true });
    }
    tempCatalogPath = join(tempDir, 'spawnea.yaml');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    try {
      if (existsSync(tempCatalogPath)) {
        unlinkSync(tempCatalogPath);
      }
    } catch {
      // Ignore cleanup error
    }
  });

  it('prefers SPAWNEA_CONFIG over SPAWNEA_CATALOG_PATH', () => {
    const canonicalPath = join(tempDir, 'canonical.yaml');
    vi.stubEnv('SPAWNEA_CATALOG_PATH', tempCatalogPath);
    vi.stubEnv('SPAWNEA_CONFIG', canonicalPath);
    expect(new CatalogManager().getCatalogPath()).toBe(canonicalPath);

    vi.stubEnv('SPAWNEA_CONFIG', '');
    expect(new CatalogManager().getCatalogPath()).toBe(tempCatalogPath);
  });

  it('loads a valid catalog at startup', () => {
    writeFileSync(tempCatalogPath, validYaml, 'utf8');

    const manager = new CatalogManager({ catalogPath: tempCatalogPath });
    const state = manager.load();

    expect(state.catalog).not.toBeNull();
    expect(state.errors).toBeNull();
    expect(manager.getActiveCatalog()?.hosts['example-remote'].name).toBe('Example Remote');
  });

  it('handles missing file gracefully without crashing', () => {
    const missingPath = join(tempDir, 'non-existent.yaml');
    const manager = new CatalogManager({ catalogPath: missingPath });
    const state = manager.load();

    expect(state.catalog).toBeNull();
    expect(state.errors).not.toBeNull();
    expect(state.errors?.[0].message).toContain('not found');
  });

  it('handles initial startup file with validation errors', () => {
    writeFileSync(tempCatalogPath, invalidSchemaYaml, 'utf8');

    const manager = new CatalogManager({ catalogPath: tempCatalogPath });
    const state = manager.load();

    expect(state.catalog).toBeNull();
    expect(state.errors).not.toBeNull();
    expect(state.errors?.length).toBeGreaterThan(0);
  });

  it('atomically updates catalog when reload succeeds with valid YAML', () => {
    writeFileSync(tempCatalogPath, validYaml, 'utf8');

    const manager = new CatalogManager({ catalogPath: tempCatalogPath });
    manager.load();
    expect(manager.getActiveCatalog()?.hosts['example-remote'].name).toBe('Example Remote');

    // Update file on disk
    writeFileSync(tempCatalogPath, updatedValidYaml, 'utf8');

    const reloadResult = manager.reload();
    expect(reloadResult.success).toBe(true);
    expect(reloadResult.errors).toBeNull();
    expect(manager.getActiveCatalog()?.hosts['example-remote'].name).toBe('Example Remote Updated');
    expect(manager.getActiveCatalog()?.hosts['example-remote'].ssh?.port).toBe(2222);
  });

  it('rejects candidate on invalid reload, preserves previous valid catalog, and exposes new errors', () => {
    writeFileSync(tempCatalogPath, validYaml, 'utf8');

    const manager = new CatalogManager({ catalogPath: tempCatalogPath });
    manager.load();
    expect(manager.getActiveCatalog()?.hosts['example-remote'].name).toBe('Example Remote');

    // Write syntax error to file
    writeFileSync(tempCatalogPath, invalidYamlSyntax, 'utf8');

    const reloadResult = manager.reload();
    expect(reloadResult.success).toBe(false);
    expect(reloadResult.errors).not.toBeNull();
    expect(reloadResult.errors?.[0].path).toBe('yaml');

    // CRITICAL ACCEPTANCE CRITERION: Previous valid catalog remains active
    expect(manager.getActiveCatalog()).not.toBeNull();
    expect(manager.getActiveCatalog()?.hosts['example-remote'].name).toBe('Example Remote');
    expect(manager.getLastErrors()).toEqual(reloadResult.errors);
  });

  it('rejects reload if raw private keys are added to the file', () => {
    writeFileSync(tempCatalogPath, validYaml, 'utf8');

    const manager = new CatalogManager({ catalogPath: tempCatalogPath });
    manager.load();

    const yamlWithSecret = `
version: 1
hosts:
  example-remote:
    name: Example Remote
    ssh:
      target: example-host
    harnesses:
      bad:
        name: Bad
        command: codex
        args:
          - "-----BEGIN RSA PRIVATE KEY-----"
`;
    writeFileSync(tempCatalogPath, yamlWithSecret, 'utf8');

    const reloadResult = manager.reload();
    expect(reloadResult.success).toBe(false);
    expect(reloadResult.errors?.some((e) => e.message.includes('Raw private key detected'))).toBe(true);

    // Prior valid catalog still active
    expect(manager.getActiveCatalog()?.hosts['example-remote'].name).toBe('Example Remote');
  });

  it('correctly maps active catalog to flat server, project, and agent lists including local host', () => {
    const yamlWithLocal = `
version: 1
hosts:
  local:
    name: Local Machine
    enabled: true
    projects:
      proj-local:
        name: Local Project
        path: /workspace/project
    harnesses:
      local-shell:
        name: Shell
        command: bash
  example-remote:
    name: Example Remote
    enabled: true
    ssh:
      target: example-host
    projects: {}
    harnesses: {}
`;
    writeFileSync(tempCatalogPath, yamlWithLocal, 'utf8');

    const manager = new CatalogManager({ catalogPath: tempCatalogPath });
    manager.load();

    const flat = manager.getFlatLists();
    expect(flat.servers).toHaveLength(2);

    const localServer = flat.servers.find((s) => s.id === 'local');
    expect(localServer).toBeDefined();
    expect(localServer?.host).toBe('localhost');
    expect(localServer?.sshUser).toBeUndefined();

    const remoteServer = flat.servers.find((s) => s.id === 'example-remote');
    expect(remoteServer?.host).toBe('example-host');

    expect(flat.projects).toHaveLength(1);
    expect(flat.projects[0].id).toBe('local:proj-local');

    expect(flat.agents).toHaveLength(1);
    expect(flat.agents[0].id).toBe('local:local-shell');
  });

  it('adds a project to the YAML source of truth without dropping existing entries', async () => {
    writeFileSync(tempCatalogPath, `# preserve this comment\n${validYaml}`, 'utf8');

    const manager = new CatalogManager({ catalogPath: tempCatalogPath });
    manager.load();
    const result = await manager.addProject({
      serverId: 'example-remote',
      projectId: 'new-project',
      name: 'New Project',
      path: '~/code/new-project',
      baseBranch: 'main',
    });

    expect(result.success).toBe(true);
    expect(readFileSync(tempCatalogPath, 'utf8')).toContain('# preserve this comment');
    expect(manager.getActiveCatalog()?.hosts['example-remote'].projects.spawnea.name).toBe('Spawnea');
    expect(manager.getActiveCatalog()?.hosts['example-remote'].projects['new-project']).toMatchObject({
      id: 'new-project',
      name: 'New Project',
      path: '~/code/new-project',
      base_branch: 'main',
    });
  });

  it('rejects duplicate projects and leaves the YAML unchanged', async () => {
    writeFileSync(tempCatalogPath, validYaml, 'utf8');
    const before = readFileSync(tempCatalogPath, 'utf8');
    const manager = new CatalogManager({ catalogPath: tempCatalogPath });
    manager.load();

    const result = await manager.addProject({
      serverId: 'example-remote',
      projectId: 'spawnea',
      name: 'Replacement',
      path: '~/code/replacement',
    });

    expect(result.success).toBe(false);
    expect(result.errors?.[0].message).toContain('already exists');
    expect(readFileSync(tempCatalogPath, 'utf8')).toBe(before);
  });

  describe('Path Resolution Order', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('resolves SPAWNEA_CONFIG or SPAWNEA_CATALOG_PATH when specified in env', () => {
      process.env.SPAWNEA_CONFIG = tempCatalogPath;
      const manager = new CatalogManager();
      expect(manager.getCatalogPath()).toBe(tempCatalogPath);
    });



    it('resolves SPAWNEA_HOME/config.yaml when defined', () => {
      delete process.env.SPAWNEA_CONFIG;
      delete process.env.SPAWNEA_CATALOG_PATH;

      process.env.SPAWNEA_HOME = tempDir;
      expect(new CatalogManager().getCatalogPath()).toBe(join(tempDir, 'config.yaml'));
    });

    it('uses the per-user config directory instead of the repository', () => {
      delete process.env.SPAWNEA_CONFIG;
      delete process.env.SPAWNEA_CATALOG_PATH;
      delete process.env.SPAWNEA_HOME;

      expect(new CatalogManager().getCatalogPath()).toBe(
        join(homedir(), '.config', 'spawnea', 'config.yaml'),
      );
    });
  });
});
