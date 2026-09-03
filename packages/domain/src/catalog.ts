import { z } from 'zod';
import { parse as parseYaml, parseDocument } from 'yaml';
import { maskSensitiveString } from './logger.js';
import { containsOnePasswordReference, isOnePasswordReference, type SecretBackedPort } from './secret-reference.js';

export interface CatalogSsh {
  target: string;
  user?: string;
  port?: SecretBackedPort;
}

export interface CatalogProject {
  id: string;
  name: string;
  path: string;
  git_url?: string;
  base_branch?: string;
  worktree?: {
    enabled: boolean;
    copy_files: string[];
  };
  tmux?: {
    options: Record<string, string | number | boolean>;
    commands: string[];
  };
  enabled: boolean;
}

export interface CatalogHarness {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
}

export interface CatalogHost {
  id: string;
  name: string;
  enabled: boolean;
  ssh?: CatalogSsh;
  projects: Record<string, CatalogProject>;
  harnesses: Record<string, CatalogHarness>;
}

export interface OperationalCatalog {
  version: 1;
  hosts: Record<string, CatalogHost>;
}

export interface CatalogValidationError {
  path: string;
  message: string;
}

export type CatalogValidationResult =
  | { success: true; catalog: OperationalCatalog; errors?: never }
  | { success: false; catalog?: never; errors: CatalogValidationError[] };

export interface CatalogState {
  catalog: OperationalCatalog | null;
  filePath: string;
  errors: CatalogValidationError[] | null;
}

export interface CatalogReloadResult {
  success: boolean;
  catalog: OperationalCatalog | null;
  filePath: string;
  errors: CatalogValidationError[] | null;
}

export type CatalogProjectInput = Omit<CatalogProject, 'id'>;

export type CatalogYamlProjectMutationResult =
  | { success: true; content: string }
  | { success: false; errors: CatalogValidationError[] };

export interface CatalogDiscoveryMutation {
  hosts: Array<{
    id: string;
    name: string;
    target: string;
    user?: string;
    port?: number;
    mode: 'add' | 'update';
  }>;
  harnesses: Array<{
    hostId: string;
    id: string;
    name: string;
    command: string;
    mode: 'add' | 'update';
  }>;
}

export interface CatalogDiscoveryMutationChange {
  operation: 'add' | 'update';
  path: string;
  before?: unknown;
  after: unknown;
}

export type CatalogYamlDiscoveryMutationResult =
  | { success: true; content: string; changes: CatalogDiscoveryMutationChange[] }
  | { success: false; errors: CatalogValidationError[] };

/** Applies an already-confirmable discovery selection while preserving unrelated YAML. */
export function mergeDiscoveryIntoCatalogYaml(
  yamlContent: string,
  mutation: CatalogDiscoveryMutation
): CatalogYamlDiscoveryMutationResult {
  const document = parseDocument(yamlContent);
  if (document.errors.length > 0) {
    return {
      success: false,
      errors: [{ path: 'yaml', message: `YAML syntax error: ${document.errors[0].message}` }],
    };
  }

  const validation = validateOperationalCatalog(document.toJS());
  if (!validation.success) return validation;
  const changes: CatalogDiscoveryMutationChange[] = [];
  const changedPaths = new Set<string>();

  for (const hostInput of mutation.hosts) {
    if (!IDENTIFIER_REGEX.test(hostInput.id)) {
      return { success: false, errors: [{ path: `hosts.${hostInput.id}`, message: `Host ID '${hostInput.id}' is invalid.` }] };
    }
    const hostPath = `hosts.${hostInput.id}`;
    if (changedPaths.has(hostPath)) {
      return { success: false, errors: [{ path: hostPath, message: `Host '${hostInput.id}' was selected more than once.` }] };
    }
    changedPaths.add(hostPath);
    const existing = validation.catalog.hosts[hostInput.id];
    if (hostInput.mode === 'add' && existing) {
      return { success: false, errors: [{ path: `hosts.${hostInput.id}`, message: `Host '${hostInput.id}' already exists; choose update explicitly.` }] };
    }
    if (hostInput.mode === 'update' && !existing) {
      return { success: false, errors: [{ path: `hosts.${hostInput.id}`, message: `Host '${hostInput.id}' no longer exists.` }] };
    }

    const ssh = {
      target: hostInput.target,
      ...(hostInput.user ? { user: hostInput.user } : {}),
      ...(hostInput.port ? { port: hostInput.port } : {}),
    };
    const after = existing
      ? { name: hostInput.name, enabled: true, ssh }
      : { name: hostInput.name, enabled: true, ssh, projects: {}, harnesses: {} };
    changes.push({
      operation: hostInput.mode,
      path: hostPath,
      ...(existing ? { before: { name: existing.name, enabled: existing.enabled, ssh: existing.ssh } } : {}),
      after,
    });

    if (existing) {
      document.setIn(['hosts', hostInput.id, 'name'], hostInput.name);
      document.setIn(['hosts', hostInput.id, 'enabled'], true);
      document.setIn(['hosts', hostInput.id, 'ssh'], ssh);
    } else {
      document.setIn(['hosts', hostInput.id], after);
    }
  }

  for (const harnessInput of mutation.harnesses) {
    if (!IDENTIFIER_REGEX.test(harnessInput.id)) {
      return { success: false, errors: [{ path: `hosts.${harnessInput.hostId}.harnesses.${harnessInput.id}`, message: `Harness ID '${harnessInput.id}' is invalid.` }] };
    }
    const harnessPath = `hosts.${harnessInput.hostId}.harnesses.${harnessInput.id}`;
    if (changedPaths.has(harnessPath)) {
      return { success: false, errors: [{ path: harnessPath, message: `Harness '${harnessInput.id}' was selected more than once.` }] };
    }
    changedPaths.add(harnessPath);
    const host = validation.catalog.hosts[harnessInput.hostId];
    if (!host) {
      return { success: false, errors: [{ path: `hosts.${harnessInput.hostId}`, message: `Host '${harnessInput.hostId}' was not found.` }] };
    }
    if (host.ssh) {
      return { success: false, errors: [{ path: `hosts.${harnessInput.hostId}`, message: 'Local executable discovery can only update a host without ssh configuration.' }] };
    }
    const existing = host.harnesses[harnessInput.id];
    if (harnessInput.mode === 'add' && existing) {
      return { success: false, errors: [{ path: `hosts.${harnessInput.hostId}.harnesses.${harnessInput.id}`, message: `Harness '${harnessInput.id}' already exists; choose update explicitly.` }] };
    }
    if (harnessInput.mode === 'update' && !existing) {
      return { success: false, errors: [{ path: `hosts.${harnessInput.hostId}.harnesses.${harnessInput.id}`, message: `Harness '${harnessInput.id}' no longer exists.` }] };
    }
    const after = { name: harnessInput.name, command: harnessInput.command, args: [], enabled: true };
    changes.push({
      operation: harnessInput.mode,
      path: harnessPath,
      ...(existing ? { before: { name: existing.name, command: existing.command, args: existing.args, enabled: existing.enabled } } : {}),
      after,
    });
    document.setIn(['hosts', harnessInput.hostId, 'harnesses', harnessInput.id], after);
  }

  const content = document.toString();
  const candidate = parseOperationalCatalog(content);
  return candidate.success ? { success: true, content, changes } : candidate;
}

/**
 * Adds one project to an already parsed catalog document while retaining the
 * document's existing comments and formatting as much as the YAML library can.
 */
export function mergeProjectIntoCatalogYaml(
  yamlContent: string,
  hostId: string,
  projectId: string,
  project: CatalogProjectInput
): CatalogYamlProjectMutationResult {
  const document = parseDocument(yamlContent);
  if (document.errors.length > 0) {
    return {
      success: false,
      errors: [{ path: 'yaml', message: `YAML syntax error: ${document.errors[0].message}` }],
    };
  }

  const raw = document.toJS();
  const validation = validateOperationalCatalog(raw);
  if (!validation.success) return validation;

  const host = validation.catalog.hosts[hostId];
  if (!host) {
    return { success: false, errors: [{ path: `hosts.${hostId}`, message: `Host '${hostId}' was not found in the catalog.` }] };
  }
  if (host.projects[projectId]) {
    return {
      success: false,
      errors: [{ path: `hosts.${hostId}.projects.${projectId}`, message: `Project ID '${projectId}' already exists on host '${hostId}'.` }],
    };
  }

  document.setIn(['hosts', hostId, 'projects', projectId], project);
  const content = document.toString();
  const candidate = parseOperationalCatalog(content);
  return candidate.success ? { success: true, content } : candidate;
}

// Identifier validation rule: start with lowercase letter or digit, contain only lowercase letters, digits, hyphens, and underscores
export const IDENTIFIER_REGEX = /^[a-z0-9][a-z0-9_-]*$/;

export function isExactRepositoryRelativePath(value: string): boolean {
  if (!value || value.trim() !== value || value.startsWith('/') || value.startsWith('\\') || value.includes('\\')) {
    return false;
  }
  return value.split('/').every((component) => component !== '' && component !== '.' && component !== '..');
}

// Pattern for raw private keys
const RAW_PRIVATE_KEY_REGEX = /-----BEGIN [A-Z0-9\s_-]+PRIVATE KEY-----/i;

export const CatalogSshSchema = z
  .object({
    target: z.string().trim().min(1, 'SSH target must not be empty').refine(
      (value) => !containsOnePasswordReference(value) || isOnePasswordReference(value),
      'SSH target must be a literal value or one complete op:// reference'
    ),
    user: z.string().trim().min(1, 'SSH user must not be empty').refine(
      (value) => !containsOnePasswordReference(value) || isOnePasswordReference(value),
      'SSH user must be a literal value or one complete op:// reference'
    ).optional(),
    port: z
      .union([
        z.number()
          .int('SSH port must be an integer')
          .min(1, 'SSH port must be at least 1')
          .max(65535, 'SSH port must not exceed 65535'),
        z.string().refine(isOnePasswordReference, 'SSH port string must be one complete op:// reference'),
      ])
      .optional(),
  })
  .strict();

export const CatalogProjectSchema = z
  .object({
    name: z.string().trim().min(1, 'Project name must not be empty'),
    path: z.string().trim().min(1, 'Project path must not be empty').refine(
      (value) => !containsOnePasswordReference(value) || isOnePasswordReference(value),
      'Project path must be a literal value or one complete op:// reference'
    ),
    git_url: z.string().trim().min(1, 'git_url must not be empty').optional(),
    base_branch: z.string().trim().min(1, 'base_branch must not be empty').optional(),
    worktree: z
      .object({
        enabled: z.boolean().default(false),
        copy_files: z.array(
          z.string()
            .min(1, 'copy_files entries must not be empty')
            .refine(isExactRepositoryRelativePath, {
              message: 'copy_files entries must be exact repository-relative paths without traversal or backslashes',
            })
        ).default([]),
      })
      .strict()
      .optional(),
    tmux: z
      .object({
        options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
        commands: z.array(z.string().trim().min(1, 'tmux commands must not be empty')).default([]),
      })
      .strict()
      .optional(),
    enabled: z.boolean().default(true),
  })
  .strict();

export const CatalogHarnessSchema = z
  .object({
    name: z.string().trim().min(1, 'Harness name must not be empty'),
    command: z.string().trim().min(1, 'Harness command must not be empty'),
    args: z.array(z.string()).default([]),
    enabled: z.boolean().default(true),
  })
  .strict();

export const RawCatalogHostSchema = z
  .object({
    name: z.string().trim().min(1, 'Host name must not be empty'),
    enabled: z.boolean().default(true),
    ssh: CatalogSshSchema.optional(),
    projects: z.record(z.string(), CatalogProjectSchema).default({}),
    harnesses: z.record(z.string(), CatalogHarnessSchema).default({}),
  })
  .strict();

export const RawOperationalCatalogSchema = z
  .object({
    version: z.literal(1, {
      error: () => 'Catalog version must be 1 for Pilot 1',
    }),
    hosts: z.record(z.string(), RawCatalogHostSchema),
  })
  .strict();

/**
 * Recursively scans an object or array to ensure no raw secrets or private keys exist.
 * Allows safe references ($VAR, ${VAR}, op://...).
 */
function checkForRawSecrets(data: unknown, currentPath = ''): CatalogValidationError[] {
  const errors: CatalogValidationError[] = [];

  if (data === null || data === undefined) {
    return errors;
  }

  if (typeof data === 'string') {
    if (RAW_PRIVATE_KEY_REGEX.test(data)) {
      errors.push({
        path: currentPath || 'value',
        message: 'Raw private key detected. Plaintext secrets are prohibited in catalog files.',
      });
    }
    return errors;
  }

  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      const itemPath = currentPath ? `${currentPath}[${i}]` : `[${i}]`;
      errors.push(...checkForRawSecrets(data[i], itemPath));
    }
    return errors;
  }

  if (typeof data === 'object') {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      const fieldPath = currentPath ? `${currentPath}.${key}` : key;
      errors.push(...checkForRawSecrets(value, fieldPath));
    }
  }

  return errors;
}

/**
 * Validates a parsed catalog object against the canonical operational catalog specification.
 */
export function validateOperationalCatalog(raw: unknown): CatalogValidationResult {
  const errors: CatalogValidationError[] = [];

  if (!raw || typeof raw !== 'object') {
    return {
      success: false,
      errors: [{ path: 'root', message: 'Catalog must be a YAML mapping/object' }],
    };
  }

  // Check for raw private keys / prohibited credentials
  const secretErrors = checkForRawSecrets(raw);
  if (secretErrors.length > 0) {
    return {
      success: false,
      errors: secretErrors.map((e) => ({
        path: e.path,
        message: maskSensitiveString(e.message),
      })),
    };
  }

  // Validate top-level and nested structure via Zod
  const parseResult = RawOperationalCatalogSchema.safeParse(raw);
  if (!parseResult.success) {
    for (const issue of parseResult.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'root';
      const message = maskSensitiveString(issue.message);
      errors.push({ path, message });
    }
    return { success: false, errors };
  }

  const validatedRaw = parseResult.data;
  const transformedHosts: Record<string, CatalogHost> = {};

  // Validate Host IDs and child Project/Harness IDs
  for (const [hostId, hostDef] of Object.entries(validatedRaw.hosts)) {
    if (!IDENTIFIER_REGEX.test(hostId)) {
      errors.push({
        path: `hosts.${hostId}`,
        message: `Host ID '${hostId}' is invalid. IDs must start with a lowercase letter or digit and contain only lowercase letters, digits, hyphens, and underscores.`,
      });
      continue;
    }

    const transformedProjects: Record<string, CatalogProject> = {};
    for (const [projectId, projectDef] of Object.entries(hostDef.projects)) {
      if (!IDENTIFIER_REGEX.test(projectId)) {
        errors.push({
          path: `hosts.${hostId}.projects.${projectId}`,
          message: `Project ID '${projectId}' is invalid. IDs must start with a lowercase letter or digit and contain only lowercase letters, digits, hyphens, and underscores.`,
        });
      } else {
        transformedProjects[projectId] = {
          id: projectId,
          ...projectDef,
        };
      }
    }

    const transformedHarnesses: Record<string, CatalogHarness> = {};
    for (const [harnessId, harnessDef] of Object.entries(hostDef.harnesses)) {
      if (!IDENTIFIER_REGEX.test(harnessId)) {
        errors.push({
          path: `hosts.${hostId}.harnesses.${harnessId}`,
          message: `Harness ID '${harnessId}' is invalid. IDs must start with a lowercase letter or digit and contain only lowercase letters, digits, hyphens, and underscores.`,
        });
      } else {
        transformedHarnesses[harnessId] = {
          id: harnessId,
          ...harnessDef,
        };
      }
    }

    transformedHosts[hostId] = {
      id: hostId,
      name: hostDef.name,
      enabled: hostDef.enabled,
      ssh: hostDef.ssh,
      projects: transformedProjects,
      harnesses: transformedHarnesses,
    };
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  const catalog: OperationalCatalog = {
    version: 1,
    hosts: transformedHosts,
  };

  return { success: true, catalog };
}

/**
 * Parses and validates raw YAML string content as an Operational Catalog.
 */
export function parseOperationalCatalog(yamlContent: string): CatalogValidationResult {
  if (!yamlContent || yamlContent.trim() === '') {
    return {
      success: false,
      errors: [{ path: 'root', message: 'Catalog file is empty' }],
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlContent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      errors: [
        {
          path: 'yaml',
          message: maskSensitiveString(`YAML syntax error: ${message}`),
        },
      ],
    };
  }

  return validateOperationalCatalog(parsed);
}
