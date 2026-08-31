// Control characters are intentionally rejected from secret references.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_REGEX = /[\x00-\x1f\x7f]/;

export type SecretReference = string & { readonly __secretReference: unique symbol };
export type SecretBackedString = string;
export type SecretBackedPort = number | SecretReference;

/** Accepts only complete read references; interpolation and query parameters are intentionally unsupported. */
export function isOnePasswordReference(value: unknown): value is SecretReference {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('op://')) return false;
  if (CONTROL_CHARACTER_REGEX.test(value) || value.includes('?') || value.includes('#')) return false;
  const components = value.slice('op://'.length).split('/');
  return components.length >= 3
    && components.length <= 4
    && components.every((component) => component.trim().length > 0 && component !== '.' && component !== '..');
}

export function containsOnePasswordReference(value: unknown): boolean {
  return typeof value === 'string' && value.includes('op://');
}

export function isSecretBackedValue(value: unknown): boolean {
  return isOnePasswordReference(value);
}

export type SecretResolutionFailureCode =
  | 'cli_missing'
  | 'timeout'
  | 'authentication_required'
  | 'reference_not_found'
  | 'process_failed'
  | 'output_too_large'
  | 'invalid_value';

export class SecretResolutionError extends Error {
  constructor(
    public readonly code: SecretResolutionFailureCode,
    public readonly fieldPath: string
  ) {
    super(secretResolutionFailureMessage(code, fieldPath));
    this.name = 'SecretResolutionError';
  }
}

export interface CatalogPathLocator {
  kind: 'project' | 'worktree';
  hostId: string;
  projectId: string;
  worktreeLeaf?: string;
}

export function createCatalogProjectPathLocator(hostId: string, projectId: string): string {
  return `catalog-project://${encodeURIComponent(hostId)}/${encodeURIComponent(projectId)}`;
}

export function createCatalogWorktreePathLocator(hostId: string, projectId: string, worktreeLeaf: string): string {
  return `catalog-worktree://${encodeURIComponent(hostId)}/${encodeURIComponent(projectId)}/${encodeURIComponent(worktreeLeaf)}`;
}

export function parseCatalogPathLocator(value: string): CatalogPathLocator | null {
  const projectMatch = value.match(/^catalog-project:\/\/([^/]+)\/([^/]+)$/);
  if (projectMatch) {
    try {
      return { kind: 'project', hostId: decodeURIComponent(projectMatch[1]), projectId: decodeURIComponent(projectMatch[2]) };
    } catch {
      return null;
    }
  }
  const worktreeMatch = value.match(/^catalog-worktree:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (worktreeMatch) {
    try {
      return {
        kind: 'worktree',
        hostId: decodeURIComponent(worktreeMatch[1]),
        projectId: decodeURIComponent(worktreeMatch[2]),
        worktreeLeaf: decodeURIComponent(worktreeMatch[3]),
      };
    } catch {
      return null;
    }
  }
  return null;
}

export function secretResolutionFailureMessage(code: SecretResolutionFailureCode, fieldPath: string): string {
  const prefix = `Could not resolve credential-backed field '${fieldPath}'`;
  switch (code) {
    case 'cli_missing': return `${prefix}: the 1Password CLI is not installed or not available in PATH.`;
    case 'timeout': return `${prefix}: the 1Password CLI timed out.`;
    case 'authentication_required': return `${prefix}: sign in to the 1Password CLI and verify access, then retry.`;
    case 'reference_not_found': return `${prefix}: the referenced vault, item, section, or field was not found or is unavailable.`;
    case 'output_too_large': return `${prefix}: the 1Password CLI returned more data than this field permits.`;
    case 'invalid_value': return `${prefix}: the resolved value is invalid for this field.`;
    default: return `${prefix}: the 1Password CLI failed without exposing sensitive output.`;
  }
}
