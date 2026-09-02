import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDesktopRuntimePaths } from './runtime-paths.js';

describe('desktop runtime paths', () => {
  it('resolves renderer and preload from the application root, not the bundled chunk directory', () => {
    const appPath = '/opt/spawnea/resources/app.asar';
    const expectedPreload = join(appPath, 'out/preload/index.cjs');

    expect(resolveDesktopRuntimePaths(appPath, (path) => path === expectedPreload)).toEqual({
      preloadPath: expectedPreload,
      rendererPath: join(appPath, 'out/renderer/index.html'),
    });
  });

  it('keeps a deterministic preload path when the build output is missing', () => {
    const appPath = '/workspace/apps/desktop';

    expect(resolveDesktopRuntimePaths(appPath, () => false).preloadPath).toBe(
      join(appPath, 'out/preload/index.mjs')
    );
  });

  it('resolves sibling output directories when Electron starts from out/main', () => {
    const appPath = '/workspace/apps/desktop/out/main';
    const rendererPath = join('/workspace/apps/desktop', 'out/renderer/index.html');
    const preloadPath = join('/workspace/apps/desktop', 'out/preload/index.cjs');
    const existingPaths = new Set([rendererPath, preloadPath]);

    expect(resolveDesktopRuntimePaths(appPath, (path) => existingPaths.has(path))).toEqual({
      preloadPath,
      rendererPath,
    });
  });
});
