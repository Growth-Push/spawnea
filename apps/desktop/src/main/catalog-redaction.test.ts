import { describe, expect, it } from 'vitest';
import { parseOperationalCatalog } from '@spawnea/domain';
import {
  sanitizeCatalogForRenderer,
  sanitizeCatalogResultForRenderer,
} from './catalog-redaction.js';

describe('catalog renderer redaction', () => {
  it('replaces references with labels and safe locators while retaining literal fields', () => {
    const parsed = parseOperationalCatalog(`
version: 1
hosts:
  secure:
    name: Secure
    ssh:
      target: op://vault/server/hostname
      user: op://vault/server/username
      port: op://vault/server/port
    projects:
      app:
        name: App
        path: op://vault/server/project-root
    harnesses: {}
  literal:
    name: Literal
    ssh:
      target: literal.example
      user: deploy
      port: 2222
    projects: {}
    harnesses: {}
`);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const sanitized = sanitizeCatalogForRenderer(parsed.catalog);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain('op://');
    expect(sanitized?.hosts.secure.ssh).toEqual({
      target: '1Password-backed',
      user: undefined,
      port: undefined,
    });
    expect(sanitized?.hosts.secure.projects.app.path).toBe('catalog-project://secure/app');
    expect(sanitized?.hosts.literal.ssh).toEqual({
      target: 'literal.example',
      user: 'deploy',
      port: 2222,
    });
  });

  it('redacts references from validation errors returned over IPC', () => {
    const result = sanitizeCatalogResultForRenderer({
      success: false,
      catalog: null,
      filePath: '/tmp/catalog.yaml',
      errors: [{
        path: 'hosts.secure.ssh.target',
        message: 'Invalid value op://private-vault/private-item/hostname',
      }],
    });

    expect(JSON.stringify(result)).not.toContain('private-vault');
    expect(result.errors?.[0].message).toContain('[REDACTED 1PASSWORD REFERENCE]');
  });
});
