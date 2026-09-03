// Control characters are intentionally rejected from filesystem paths.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

/**
 * Canonicalizes a path without touching the filesystem. Windows separators
 * are normalized so containment checks behave consistently across hosts.
 */
export function canonicalizePath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('Path must be a non-empty string');
  }
  if (input.includes('\0')) throw new Error('Path contains an unsupported character');

  const portableInput = input.replace(/\\/g, '/');
  const driveAbsolute = /^[A-Za-z]:\//.test(portableInput);
  const absolute = portableInput.startsWith('/') || driveAbsolute;
  const segments: string[] = [];
  for (const segment of portableInput.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') {
        segments.pop();
      } else if (!absolute) {
        segments.push('..');
      }
      continue;
    }
    segments.push(segment);
  }

  const joined = segments.join('/');
  if (absolute) return driveAbsolute ? joined : joined ? `/${joined}` : '/';
  return joined || '.';
}

/**
 * Returns true only when candidate is the root or a descendant of root.
 * The segment boundary prevents /worktree-other matching /worktree.
 */
export function isPathContained(root: string, candidate: string): boolean {
  try {
    const canonicalRoot = canonicalizePath(root).replace(/\/+$/, '') || '/';
    const canonicalCandidate = canonicalizePath(candidate);
    if (canonicalRoot === '/') return canonicalCandidate.startsWith('/');
    const isWindowsPath = /^[A-Za-z]:\//.test(canonicalRoot);
    const comparisonRoot = isWindowsPath ? canonicalRoot.toLowerCase() : canonicalRoot;
    const comparisonCandidate = isWindowsPath
      ? canonicalCandidate.toLowerCase()
      : canonicalCandidate;
    return (
      comparisonCandidate === comparisonRoot ||
      comparisonCandidate.startsWith(`${comparisonRoot}/`)
    );
  } catch {
    return false;
  }
}

/**
 * Resolves a path beneath root and rejects absolute paths or traversal outside it.
 */
export function resolveContainedPath(root: string, requestedPath: string): string {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
    throw new Error('Path must be a non-empty string');
  }
  const isAbsolute = requestedPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(requestedPath);
  const candidate = isAbsolute
    ? canonicalizePath(requestedPath)
    : canonicalizePath(`${root.replace(/\/+$/, '')}/${requestedPath}`);
  if (!isPathContained(root, candidate)) {
    throw new Error('Path must remain inside the workspace boundary');
  }
  return candidate;
}

/**
 * Returns a canonical descendant path relative to root, or throws when outside.
 */
export function relativeContainedPath(root: string, candidate: string): string {
  const canonicalRoot = canonicalizePath(root).replace(/\/+$/, '') || '/';
  const canonicalCandidate = resolveContainedPath(root, candidate);
  if (canonicalCandidate === canonicalRoot) return '';
  return canonicalCandidate.slice(canonicalRoot === '/' ? 1 : canonicalRoot.length + 1);
}

/**
 * Validates a filename that will be appended to a single artifact directory.
 */
export function assertSafeFilename(filename: string): string {
  if (typeof filename !== 'string') {
    throw new Error('Artifact filename must be a string');
  }
  const normalized = filename.trim();
  if (
    !normalized ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.length > 255 ||
    normalized.includes('/') ||
    normalized.includes('\\') ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    throw new Error('Artifact filename must be a single safe base filename');
  }
  return normalized;
}
