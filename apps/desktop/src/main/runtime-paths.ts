import { dirname, join } from 'node:path';

export interface DesktopRuntimePaths {
  preloadPath: string;
  rendererPath: string;
}

/**
 * Resolves the preload script and renderer entry paths for the desktop runtime.
 *
 * @param appPath - The application path used to locate the runtime output directory
 * @returns The resolved preload script path and renderer HTML path
 */
export function resolveDesktopRuntimePaths(
  appPath: string,
  fileExists: (path: string) => boolean,
): DesktopRuntimePaths {
  // Packaged apps expose the application root, while launching the compiled
  // entry directly exposes out/main as the application path.
  const outputCandidates = [join(appPath, 'out'), dirname(appPath)];
  const outputPath = outputCandidates.find((candidate) =>
    fileExists(join(candidate, 'renderer', 'index.html'))
  ) ?? outputCandidates[0];
  const preloadCandidates = ['index.mjs', 'index.js', 'index.cjs'].map((filename) =>
    join(outputPath, 'preload', filename)
  );

  return {
    preloadPath: preloadCandidates.find(fileExists) ?? preloadCandidates[0],
    rendererPath: join(outputPath, 'renderer', 'index.html'),
  };
}
