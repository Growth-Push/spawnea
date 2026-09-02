import { dirname, join } from 'node:path';

export interface DesktopRuntimePaths {
  preloadPath: string;
  rendererPath: string;
}

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
