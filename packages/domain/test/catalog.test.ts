import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeProjectIntoCatalogYaml, parseOperationalCatalog } from '../src/catalog.js';

describe('Operational Catalog Validation', () => {
  it('merges a project while preserving existing catalog entries and comments', () => {
    const source = `# keep this comment\nversion: 1\nhosts:\n  local:\n    name: Local\n    projects:\n      existing:\n        name: Existing\n        path: ~/code/existing\n    harnesses: {}\n`;

    const result = mergeProjectIntoCatalogYaml(source, 'local', 'new-project', {
      name: 'New Project',
      path: '~/code/new-project',
      base_branch: 'main',
      enabled: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.content).toContain('# keep this comment');
    const parsed = parseOperationalCatalog(result.content);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.catalog.hosts.local.projects.existing.name).toBe('Existing');
    expect(parsed.catalog.hosts.local.projects['new-project'].base_branch).toBe('main');
  });

  it('rejects duplicate project IDs without mutating the source', () => {
    const source = `version: 1\nhosts:\n  local:\n    name: Local\n    projects:\n      existing:\n        name: Existing\n        path: ~/code/existing\n    harnesses: {}\n`;

    const result = mergeProjectIntoCatalogYaml(source, 'local', 'existing', {
      name: 'Replacement',
      path: '~/code/replacement',
      enabled: true,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors[0].message).toContain('already exists');
    expect(source).not.toContain('Replacement');
  });
  it('successfully parses and validates the canonical config/spawnea.example.yaml', () => {
    const examplePath = join(__dirname, '../../../config/spawnea.example.yaml');
    const exampleContent = readFileSync(examplePath, 'utf8');

    const result = parseOperationalCatalog(exampleContent);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.catalog.version).toBe(1);
    expect(Object.keys(result.catalog.hosts)).toEqual(['local', 'dev-workstation', 'deployment-example']);

    const hostLocal = result.catalog.hosts['local'];
    expect(hostLocal.id).toBe('local');
    expect(hostLocal.name).toBe('Local Workstation');
    expect(hostLocal.enabled).toBe(true);
    expect(hostLocal.ssh).toBeUndefined();
    expect(Object.keys(hostLocal.projects)).toEqual(['spawnea', 'scratch']);
    expect(hostLocal.projects.spawnea.worktree).toEqual({
      enabled: true,
      copy_files: ['.envrc.custom'],
    });
    expect(Object.keys(hostLocal.harnesses)).toEqual(['claude', 'codex', 'antigravity', 'shell']);

    const developmentHost = result.catalog.hosts['dev-workstation'];
    expect(developmentHost.id).toBe('dev-workstation');
    expect(developmentHost.name).toBe('Development Workstation');
    expect(developmentHost.enabled).toBe(true);
    expect(developmentHost.ssh).toEqual({ target: 'example-host', user: 'developer', port: 22 });
    expect(Object.keys(developmentHost.projects)).toEqual(['spawnea', 'scratch']);
    expect(developmentHost.projects.spawnea).toEqual({
      id: 'spawnea',
      name: 'Spawnea',
      path: '~/code/Spawnea',
      git_url: 'https://github.com/example/Spawnea.git',
      enabled: true,
    });
    expect(Object.keys(developmentHost.harnesses)).toEqual(['codex', 'hermes-python', 'shell']);
    expect(developmentHost.harnesses['hermes-python'].args).toEqual(['agent', 'example-agent-profile']);

    const hostDeploy = result.catalog.hosts['deployment-example'];
    expect(hostDeploy.id).toBe('deployment-example');
    expect(hostDeploy.enabled).toBe(false);
    expect(hostDeploy.ssh).toEqual({ target: 'example-host', user: 'deploy' });
    expect(hostDeploy.projects).toEqual({});
    expect(Object.keys(hostDeploy.harnesses)).toEqual(['shell']);
    expect(exampleContent).toContain('op://example-vault/example-server/hostname');
    expect(exampleContent).toContain('op://example-vault/example-server/project-root');
  });

  it('validates user config with 2 hosts (local + example-remote), 5 harnesses, and 1 project', () => {
    const userConfig = `
version: 1

hosts:
  local:
    name: dev-workstation
    projects:
      spawnea:
        name: spawnea
        path: /workspace/spawnea
    harnesses:
      antigravity:
        name: Antigravity
        command: agy
      codex:
        name: Codex
        command: codex
      hermes:
        name: Hermes
        command: hermes
  example-remote:
    name: Example Remote
    ssh:
      target: example-remote
    projects: {}
    harnesses:
      codex:
        name: Codex
        command: codex
      hermes:
        name: Hermes
        command: hermes
`;
    const result = parseOperationalCatalog(userConfig);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(Object.keys(result.catalog.hosts)).toEqual(['local', 'example-remote']);
    expect(Object.keys(result.catalog.hosts['local'].harnesses)).toEqual(['antigravity', 'codex', 'hermes']);
    expect(Object.keys(result.catalog.hosts['example-remote'].harnesses)).toEqual(['codex', 'hermes']);
    expect(Object.keys(result.catalog.hosts['local'].projects)).toEqual(['spawnea']);
  });

  it('accepts complete 1Password references for supported host fields', () => {
    const result = parseOperationalCatalog(`
version: 1
hosts:
  secure:
    name: Secure host
    ssh:
      target: op://example-vault/server/hostname
      user: op://example-vault/server/username
      port: op://example-vault/server/port
    projects:
      app:
        name: App
        path: op://example-vault/server/project-root
    harnesses: {}
`);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.catalog.hosts.secure.ssh?.port).toBe('op://example-vault/server/port');
    expect(result.catalog.hosts.secure.projects.app.path).toBe('op://example-vault/server/project-root');
  });

  it.each([
    'ssh://op://vault/item/hostname',
    'prefix-op://vault/item/hostname',
    'op://vault/item/hostname?attribute=value',
    'op://vault/item/hostname#fragment',
  ])('rejects partial or extended 1Password references: %s', (target) => {
    const result = parseOperationalCatalog(`
version: 1
hosts:
  secure:
    name: Secure host
    ssh:
      target: ${target}
    projects: {}
    harnesses: {}
`);

    expect(result.success).toBe(false);
  });

  it('rejects empty catalog content', () => {
    const result = parseOperationalCatalog('');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors[0].message).toContain('Catalog file is empty');
  });

  it('rejects invalid YAML syntax with line/path information', () => {
    const invalidYaml = `
version: 1
hosts:
  dev-workstation:
    name: [unclosed array
`;
    const result = parseOperationalCatalog(invalidYaml);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors[0].path).toBe('yaml');
    expect(result.errors[0].message).toContain('YAML syntax error');
  });

  it('rejects unsupported version numbers', () => {
    const yaml = `
version: 2
hosts: {}
`;
    const result = parseOperationalCatalog(yaml);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.some((e) => e.path === 'version' && e.message.includes('version must be 1'))).toBe(true);
  });

  it('rejects unsafe worktree copy paths while accepting exact nested paths', () => {
    const yaml = (copyPath: string) => `
version: 1
hosts:
  local:
    name: Local
    projects:
      project:
        name: Project
        path: /code/project
        worktree:
          enabled: true
          copy_files: ["${copyPath}"]
`;

    expect(parseOperationalCatalog(yaml('config/local.env')).success).toBe(true);
    for (const unsafe of ['../secret', '/tmp/secret', 'config/../secret', 'config\\secret']) {
      expect(parseOperationalCatalog(yaml(unsafe)).success).toBe(false);
    }
  });

  describe('Identifier Validation Rules', () => {
    it('rejects host IDs starting with uppercase letters, hyphens, or special characters', () => {
      const invalidHostIds = ['Invalid-Host', '-example-host', '_arch', 'example-host@developer', 'example-host developer', ''];
      for (const id of invalidHostIds) {
        const yaml = `
version: 1
hosts:
  "${id}":
    name: Test Host
    ssh:
      target: test
`;
        const result = parseOperationalCatalog(yaml);
        expect(result.success).toBe(false);
        if (result.success) continue;
        expect(
          result.errors.some((e) => e.message.includes('ID') || e.path.includes(id) || e.message.includes('invalid'))
        ).toBe(true);
      }
    });

    it('rejects invalid project and harness IDs', () => {
      const yaml = `
version: 1
hosts:
  example-host:
    name: Arch Host
    ssh:
      target: example-host
    projects:
      "Invalid_Proj":
        name: Bad Project
        path: ~/proj
    harnesses:
      "Harness@1":
        name: Bad Harness
        command: codex
`;
      const result = parseOperationalCatalog(yaml);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.errors.some((e) => e.path.includes('Invalid_Proj'))).toBe(true);
      expect(result.errors.some((e) => e.path.includes('Harness@1'))).toBe(true);
    });

    it('accepts valid alphanumeric, hyphen, and underscore IDs starting with lowercase or digit', () => {
      const yaml = `
version: 1
hosts:
  1-example_host-01:
    name: Valid Server
    ssh:
      target: 192.0.2.1
    projects:
      p-01_test:
        name: Project 1
        path: /opt/proj
    harnesses:
      h_01-test:
        name: Harness 1
        command: test
`;
      const result = parseOperationalCatalog(yaml);
      expect(result.success).toBe(true);
    });
  });

  describe('Required Fields & Empty String Validation', () => {
    it('rejects missing or empty required string fields', () => {
      const yaml = `
version: 1
hosts:
  example-host:
    name: ""
    ssh:
      target: "   "
    projects:
      proj1:
        name: "   "
        path: ""
    harnesses:
      harn1:
        name: ""
        command: "   "
`;
      const result = parseOperationalCatalog(yaml);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.errors.some((e) => e.path.includes('name'))).toBe(true);
      expect(result.errors.some((e) => e.path.includes('target'))).toBe(true);
      expect(result.errors.some((e) => e.path.includes('path'))).toBe(true);
      expect(result.errors.some((e) => e.path.includes('command'))).toBe(true);
    });
  });

  describe('Port & Argument Type Validation', () => {
    it('rejects invalid SSH ports', () => {
      const testCases = [-1, 0, 65536, 70000, 22.5];
      for (const port of testCases) {
        const yaml = `
version: 1
hosts:
  example-host:
    name: Arch
    ssh:
      target: example-host
      port: ${port}
`;
        const result = parseOperationalCatalog(yaml);
        expect(result.success).toBe(false);
      }
    });

    it('rejects non-string harness args', () => {
      const yaml = `
version: 1
hosts:
  example-host:
    name: Arch
    ssh:
      target: example-host
    harnesses:
      codex:
        name: Codex
        command: codex
        args:
          - valid_arg
          - 123
`;
      const result = parseOperationalCatalog(yaml);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.errors.some((e) => e.path.includes('args'))).toBe(true);
    });
  });

  describe('Strict Unknown Field Rejection', () => {
    it('rejects unknown top-level fields', () => {
      const yaml = `
version: 1
fleet_manager: auto
hosts: {}
`;
      const result = parseOperationalCatalog(yaml);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.errors.some((e) => e.message.includes('Unrecognized') || e.message.includes('unknown') || e.path.includes('fleet_manager'))).toBe(true);
    });

    it('rejects unknown fields in host, ssh, project, or harness mappings', () => {
      const yaml = `
version: 1
hosts:
  example-host:
    name: Arch
    unexpected_host_field: true
    ssh:
      target: example-host
      password: "secretpassword"
    projects:
      p1:
        name: P1
        path: /p1
        auto_sync: true
    harnesses:
      h1:
        name: H1
        command: h1
        timeout_ms: 5000
`;
      const result = parseOperationalCatalog(yaml);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.errors.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('Zero Raw Secrets Policy & Safe References', () => {
    it('rejects raw embedded private keys and masks the output', () => {
      const privateKeyMarker = ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ');
      const yaml = `
version: 1
hosts:
  example-host:
    name: Arch
    ssh:
      target: example-host
    harnesses:
      secret_harness:
        name: Secret Harness
        command: run
        args:
          - "${privateKeyMarker}"
`;
      const result = parseOperationalCatalog(yaml);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.errors.some((e) => e.message.includes('Raw private key detected'))).toBe(true);
      // Ensure private key body is never echoed raw in the error message
      for (const err of result.errors) {
        expect(err.message).not.toContain('b3BlbnNzaC1rZXktdjE');
      }
    });

    it('allows valid environment variables and 1Password reference syntax', () => {
      const yaml = `
version: 1
hosts:
  example-host:
    name: Arch
    ssh:
      target: "\${SSH_TARGET_HOST}"
      user: "\${SSH_USER}"
    projects:
      spawnea:
        name: Spawnea
        path: "\${HOME}/code/Spawnea"
        git_url: "https://\${GITHUB_TOKEN}@github.com/example/Spawnea.git"
    harnesses:
      custom:
        name: Custom Agent
        command: "agent-runner"
        args:
          - "--token"
          - "op://Personal/MyToken/credential"
          - "--env"
          - "$APP_ENV"
`;
      const result = parseOperationalCatalog(yaml);
      expect(result.success).toBe(true);
    });
  });

  it('validates without performing network or SSH host probing', () => {
    const yaml = `
version: 1
hosts:
  non-existent-host-999:
    name: Fake Host
    ssh:
      target: 192.0.2.1
      port: 65432
`;
    const start = performance.now();
    const result = parseOperationalCatalog(yaml);
    const elapsed = performance.now() - start;

    // Structural validation must run instantaneously without waiting for network timeouts
    expect(elapsed).toBeLessThan(50);
    expect(result.success).toBe(true);
  });
});
