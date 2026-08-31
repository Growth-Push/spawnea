import { describe, expect, it } from 'vitest';
import {
  createCatalogProjectPathLocator,
  createCatalogWorktreePathLocator,
  isOnePasswordReference,
  parseCatalogPathLocator,
} from '../src/index.js';

describe('secret references and safe catalog locators', () => {
  it('recognizes supported read-reference shapes including names with spaces', () => {
    expect(isOnePasswordReference('op://example-vault/example-server/hostname')).toBe(true);
    expect(isOnePasswordReference('op://vault/item/section/field')).toBe(true);
    expect(isOnePasswordReference('op://vault/item')).toBe(false);
  });

  it('round-trips project and worktree locators without storing a reference or path', () => {
    const project = createCatalogProjectPathLocator('remote host', 'customer/app');
    const worktree = createCatalogWorktreePathLocator('remote host', 'customer/app', 'task-abc');

    expect(project).not.toContain('op://');
    expect(parseCatalogPathLocator(project)).toEqual({
      kind: 'project',
      hostId: 'remote host',
      projectId: 'customer/app',
    });
    expect(parseCatalogPathLocator(worktree)).toEqual({
      kind: 'worktree',
      hostId: 'remote host',
      projectId: 'customer/app',
      worktreeLeaf: 'task-abc',
    });
  });

  it('treats malformed encoded locators as ordinary non-locators', () => {
    expect(parseCatalogPathLocator('catalog-project://bad%XX/project')).toBeNull();
  });
});
