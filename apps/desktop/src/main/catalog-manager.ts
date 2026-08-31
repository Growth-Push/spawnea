import { readFileSync, existsSync } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  createLogger,
  parseOperationalCatalog,
  mergeProjectIntoCatalogYaml,
  mergeDiscoveryIntoCatalogYaml,
  type OperationalCatalog,
  type CatalogValidationError,
  type CatalogState,
  type CatalogReloadResult,
  type Server,
  type Project,
  type Agent,
  type Logger,
  type AddProjectToCatalogInput,
  type CatalogDiscoveryMutation,
  type CatalogDiscoveryMutationChange,
  type LocalDiscoveryApplyResult,
  createCatalogProjectPathLocator,
  isOnePasswordReference,
} from '@spawnea/domain';

export interface CatalogDiscoveryPreview {
  revision: string;
  content: string;
  changes: CatalogDiscoveryMutationChange[];
}

export interface CatalogManagerOptions {
  catalogPath?: string;
  logger?: Logger;
}

export class CatalogManager {
  private catalogPath: string;
  private activeCatalog: OperationalCatalog | null = null;
  private lastErrors: CatalogValidationError[] | null = null;
  private readonly logger: Logger;
  private readonly options: CatalogManagerOptions;

  constructor(options: CatalogManagerOptions = {}) {
    this.options = options;
    this.logger = options.logger ?? createLogger('CatalogManager');

    this.catalogPath = this.resolveCatalogPath(options);
  }

  private resolveCatalogPath(options: CatalogManagerOptions): string {
    // 1. Explicit path in options
    if (options.catalogPath) {
      return resolve(options.catalogPath);
    }

    // 2. Explicit environment variable.
    const envPath = process.env.SPAWNEA_CONFIG || process.env.SPAWNEA_CATALOG_PATH;
    if (envPath) {
      return resolve(envPath);
    }

    // 3. Product home directory if defined. A missing file still resolves to
    // the canonical location so startup errors tell the user where to create it.
    const productHome = process.env.SPAWNEA_HOME;
    if (productHome) {
      const homeConfig = join(resolve(productHome), 'config.yaml');
      const homeSpawnea = join(resolve(productHome), 'spawnea.yaml');
      if (existsSync(homeSpawnea)) return homeSpawnea;
      return homeConfig;
    }

    // 4. User standard configuration directory. Operational configuration is
    // user-owned runtime data and must never be discovered from the source tree.
    const userSpawneaConfig = join(homedir(), '.config/spawnea/config.yaml');
    return userSpawneaConfig;
  }

  public getCatalogPath(): string {
    return this.catalogPath;
  }

  public setCatalogPath(newPath: string): void {
    this.catalogPath = resolve(newPath);
  }

  public getActiveCatalog(): OperationalCatalog | null {
    return this.activeCatalog;
  }

  public getLastErrors(): CatalogValidationError[] | null {
    return this.lastErrors;
  }

  /**
   * Adds a project to the canonical YAML catalog without dropping existing
   * entries or comments. The candidate is validated before the file changes,
   * then written through a same-directory temporary file and renamed.
   */
  public async addProject(input: AddProjectToCatalogInput): Promise<CatalogReloadResult> {
    let source: string;
    try {
      source = await readFile(this.catalogPath, 'utf8');
    } catch (err) {
      return this.mutationFailure(`Failed to read catalog file: ${err instanceof Error ? err.message : String(err)}`);
    }

    const project = {
      name: input.name.trim(),
      path: input.path.trim(),
      enabled: true,
      ...(input.gitUrl?.trim() ? { git_url: input.gitUrl.trim() } : {}),
      ...(input.baseBranch?.trim() ? { base_branch: input.baseBranch.trim() } : {}),
    };

    const merged = mergeProjectIntoCatalogYaml(source, input.serverId, input.projectId, project);
    if (!merged.success) {
      this.lastErrors = merged.errors;
      return {
        success: false,
        catalog: this.activeCatalog,
        filePath: this.catalogPath,
        errors: merged.errors,
      };
    }

    const tempPath = `${this.catalogPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tempPath, merged.content, { encoding: 'utf8', mode: 0o600 });
      await rename(tempPath, this.catalogPath);
    } catch (err) {
      await unlink(tempPath).catch(() => undefined);
      return this.mutationFailure(`Failed to write catalog file: ${err instanceof Error ? err.message : String(err)}`);
    }

    return this.reload();
  }

  public async previewDiscoveryMutation(
    mutation: CatalogDiscoveryMutation
  ): Promise<{ success: true; preview: CatalogDiscoveryPreview } | { success: false; errors: CatalogValidationError[] }> {
    let source: string;
    try {
      source = await readFile(this.catalogPath, 'utf8');
    } catch (err) {
      return { success: false, errors: [{ path: 'file', message: `Failed to read catalog file: ${err instanceof Error ? err.message : String(err)}` }] };
    }

    const merged = mergeDiscoveryIntoCatalogYaml(source, mutation);
    if (!merged.success) return merged;
    return {
      success: true,
      preview: {
        revision: createHash('sha256').update(source).digest('hex'),
        content: merged.content,
        changes: merged.changes,
      },
    };
  }

  public async applyDiscoveryPreview(preview: CatalogDiscoveryPreview): Promise<LocalDiscoveryApplyResult> {
    let source: string;
    try {
      source = await readFile(this.catalogPath, 'utf8');
    } catch (err) {
      return { ...this.mutationFailure(`Failed to read catalog file: ${err instanceof Error ? err.message : String(err)}`), conflict: false };
    }

    const currentRevision = createHash('sha256').update(source).digest('hex');
    if (currentRevision !== preview.revision) {
      return {
        ...this.mutationFailure('Catalog changed after the preview. Scan and review the proposed changes again.'),
        conflict: true,
      };
    }

    const validation = parseOperationalCatalog(preview.content);
    if (!validation.success) {
      this.lastErrors = validation.errors;
      return { success: false, catalog: this.activeCatalog, filePath: this.catalogPath, errors: validation.errors, conflict: false };
    }

    const tempPath = `${this.catalogPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tempPath, preview.content, { encoding: 'utf8', mode: 0o600 });
      await rename(tempPath, this.catalogPath);
    } catch (err) {
      await unlink(tempPath).catch(() => undefined);
      return { ...this.mutationFailure(`Failed to write catalog file: ${err instanceof Error ? err.message : String(err)}`), conflict: false };
    }

    return { ...this.reload(), conflict: false };
  }

  private mutationFailure(message: string): CatalogReloadResult {
    const errors = [{ path: 'file', message }];
    this.lastErrors = errors;
    return {
      success: false,
      catalog: this.activeCatalog,
      filePath: this.catalogPath,
      errors,
    };
  }

  public getState(): CatalogState {
    return {
      catalog: this.activeCatalog,
      filePath: this.catalogPath,
      errors: this.lastErrors,
    };
  }

  /**
   * Loads and validates the catalog from disk at application startup.
   */
  public load(): CatalogState {
    this.catalogPath = this.resolveCatalogPath(this.options);
    this.logger.info('Loading operational catalog', { path: this.catalogPath });

    if (!existsSync(this.catalogPath)) {
      const error: CatalogValidationError = {
        path: 'file',
        message: `Catalog configuration file not found at path: ${this.catalogPath}`,
      };
      this.lastErrors = [error];
      this.logger.warn('Catalog file does not exist', { path: this.catalogPath });
      return this.getState();
    }

    let fileContent: string;
    try {
      fileContent = readFileSync(this.catalogPath, 'utf8');
    } catch (err) {
      const error: CatalogValidationError = {
        path: 'file',
        message: `Failed to read catalog file: ${err instanceof Error ? err.message : String(err)}`,
      };
      this.lastErrors = [error];
      this.logger.error('Failed to read catalog file', err, { path: this.catalogPath });
      return this.getState();
    }

    const result = parseOperationalCatalog(fileContent);
    if (result.success) {
      this.activeCatalog = result.catalog;
      this.lastErrors = null;
      this.logger.info('Operational catalog loaded and validated successfully', {
        hostsCount: Object.keys(result.catalog.hosts).length,
      });
    } else {
      this.lastErrors = result.errors;
      this.logger.warn('Operational catalog contains validation errors', {
        errors: result.errors,
      });
    }

    return this.getState();
  }

  /**
   * Explicitly reloads the catalog from disk.
   * On validation failure, keeps the last valid catalog active and reports new errors.
   */
  public reload(): CatalogReloadResult {
    this.catalogPath = this.resolveCatalogPath(this.options);
    this.logger.info('Reloading operational catalog requested', { path: this.catalogPath });

    if (!existsSync(this.catalogPath)) {
      const error: CatalogValidationError = {
        path: 'file',
        message: `Catalog configuration file not found at path: ${this.catalogPath}`,
      };
      this.lastErrors = [error];
      this.logger.warn('Reload failed: catalog file not found', { path: this.catalogPath });
      return {
        success: false,
        catalog: this.activeCatalog,
        filePath: this.catalogPath,
        errors: this.lastErrors,
      };
    }

    let fileContent: string;
    try {
      fileContent = readFileSync(this.catalogPath, 'utf8');
    } catch (err) {
      const error: CatalogValidationError = {
        path: 'file',
        message: `Failed to read catalog file on reload: ${err instanceof Error ? err.message : String(err)}`,
      };
      this.lastErrors = [error];
      this.logger.error('Failed to read catalog file on reload', err, { path: this.catalogPath });
      return {
        success: false,
        catalog: this.activeCatalog,
        filePath: this.catalogPath,
        errors: this.lastErrors,
      };
    }

    const result = parseOperationalCatalog(fileContent);
    if (result.success) {
      this.activeCatalog = result.catalog;
      this.lastErrors = null;
      this.logger.info('Operational catalog reloaded successfully', {
        hostsCount: Object.keys(result.catalog.hosts).length,
      });
      return {
        success: true,
        catalog: this.activeCatalog,
        filePath: this.catalogPath,
        errors: null,
      };
    } else {
      // Retain last valid catalog, expose errors
      this.lastErrors = result.errors;
      this.logger.warn('Reload rejected invalid catalog candidate. Retaining last valid catalog.', {
        errorCount: result.errors.length,
        errors: result.errors,
      });
      return {
        success: false,
        catalog: this.activeCatalog,
        filePath: this.catalogPath,
        errors: this.lastErrors,
      };
    }
  }

  /**
   * Helper to derive flat Server, Project, and Agent entities from the active operational catalog.
   */
  public getFlatLists(): { servers: Server[]; projects: Project[]; agents: Agent[] } {
    if (!this.activeCatalog) {
      return { servers: [], projects: [], agents: [] };
    }

    const servers: Server[] = [];
    const projects: Project[] = [];
    const agentsMap = new Map<string, Agent>();

    for (const host of Object.values(this.activeCatalog.hosts)) {
      const credentialBackedTarget = Boolean(host.ssh && isOnePasswordReference(host.ssh.target));
      const credentialBackedUser = Boolean(host.ssh?.user && isOnePasswordReference(host.ssh.user));
      const credentialBackedPort = Boolean(host.ssh && typeof host.ssh.port === 'string');
      servers.push({
        id: host.id,
        name: host.name,
        host: host.ssh ? (credentialBackedTarget ? 'credential-backed' : host.ssh.target) : 'localhost',
        sshUser: credentialBackedUser ? undefined : host.ssh?.user,
        sshPort: host.ssh && !credentialBackedPort && typeof host.ssh.port === 'number' ? host.ssh.port : 22,
        sshConfigAlias: credentialBackedTarget ? undefined : host.ssh?.target,
        enabled: host.enabled,
        createdAt: new Date(),
      });

      for (const proj of Object.values(host.projects)) {
        projects.push({
          id: `${host.id}:${proj.id}`,
          serverId: host.id,
          name: proj.name,
          rootPath: isOnePasswordReference(proj.path)
            ? createCatalogProjectPathLocator(host.id, proj.id)
            : proj.path,
          repoUrl: proj.git_url,
          baseBranch: proj.base_branch,
          createdAt: new Date(),
        });
      }

      for (const harness of Object.values(host.harnesses)) {
        const agentKey = `${host.id}:${harness.id}`;
        agentsMap.set(agentKey, {
          id: agentKey,
          name: `${harness.name} (${host.name})`,
          harness: harness.command,
          command: harness.command,
          argsTemplate: harness.args,
          createdAt: new Date(),
        });
      }
    }

    return {
      servers,
      projects,
      agents: Array.from(agentsMap.values()),
    };
  }
}
