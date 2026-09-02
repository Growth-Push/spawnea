import type { WebContents } from 'electron';
import type {
  Session,
  CreateSessionInput,
  AdoptSessionInput,
  DiscoveredTmuxSession,
  HostTestResult,
  HostHealthResult,

  SessionContextFile,
  HostAdapter,
  HostSystemInfo,
  HostConnectionState,
  HostConnectionEndpoint,
  FileEntry,
  FileContentResult,
  GitStatusResult,
  GitDiffResult,
  GitDiffOptions,
  GitBranchDiscoveryResult,
  FinishSessionAction,
  FinishSessionOptions,
  FinishSessionResult,
  FinishSessionOrigin,
  ManagedWorktreeInspection,
  Logger,
  CatalogSsh,
  SessionCreationSource,
} from '@spawnea/domain';
import {
  createCatalogProjectPathLocator,
  createCatalogWorktreePathLocator,
  createLogger,
  containsOnePasswordReference,
  isOnePasswordReference,
  maskSensitiveString,
  parseCatalogPathLocator,
  resolveContainedPath,
  isLoopbackHost,
} from '@spawnea/domain';
import type { Repositories } from '@spawnea/db';
import {
  SSHHostAdapter,
  LocalHostAdapter,
  MockHostAdapter,
  prepareProjectFolder,
  TmuxManager,
  fetchHostSystemInfo,
  GitService,
  HostHealthChecker,
  OnePasswordResolver,
  type ManagedWorktreeIdentity,
  type ResolvedValueLease,
} from '@spawnea/hosts';
import { StateDetector } from '@spawnea/state';
import type { CatalogManager } from './catalog-manager.js';
import type { SessionContextStore } from './session-context-store.js';
import type { PtyBroker } from './pty-broker.js';

export interface AttachedSessionInfo {
  sessionId: string;
  serverId: string;
  cols: number;
  rows: number;
  webContents: WebContents;
}

export interface SessionManagerOptions {
  repositories: Repositories;
  catalogManager: CatalogManager;
  contextStore: SessionContextStore;
  ptyBroker: PtyBroker;
  hostAdapterFactory?: (serverId: string) => Promise<HostAdapter>;
  stateDetector?: StateDetector;
  logger?: Logger;
  hostHealthChecker?: HostHealthChecker;
  onePasswordResolver?: OnePasswordResolver;
}

export class SessionManager {
  private readonly repos: Repositories;
  private readonly catalogManager: CatalogManager;
  private readonly contextStore: SessionContextStore;
  private readonly ptyBroker: PtyBroker;
  private readonly tmuxManager: TmuxManager;
  private readonly gitService: GitService;
  private readonly stateDetector: StateDetector;
  private readonly hostHealthChecker: HostHealthChecker;
  private readonly customHostFactory?: (serverId: string) => Promise<HostAdapter>;
  private readonly logger: Logger;
  private readonly onePasswordResolver: OnePasswordResolver;
  private webContentsGetter?: () => WebContents | null;

  // Active Host Adapters by serverId (pooled)
  private readonly hostPool: Map<string, HostAdapter> = new Map();
  // Active session locks to prevent concurrent duplicate starts (FG-2.2.10)
  private readonly startingSessions: Set<string> = new Set();
  // In-memory host system telemetry cache
  private readonly hostSystemInfoCache: Map<string, HostSystemInfo> = new Map();
  // Active attached terminal sessions tracking for automatic transparent re-attachment
  private readonly attachedSessions: Map<string, AttachedSessionInfo> = new Map();

  constructor(options: SessionManagerOptions) {
    this.repos = options.repositories;
    this.catalogManager = options.catalogManager;
    this.contextStore = options.contextStore;
    this.ptyBroker = options.ptyBroker;
    this.customHostFactory = options.hostAdapterFactory;
    this.logger = options.logger || createLogger('SessionManager');
    this.onePasswordResolver = options.onePasswordResolver || new OnePasswordResolver();
    this.tmuxManager = new TmuxManager(this.logger.child('tmux'));
    this.gitService = new GitService(this.logger.child('git'));
    this.stateDetector = options.stateDetector || new StateDetector();
    this.hostHealthChecker =
      options.hostHealthChecker ||
      new HostHealthChecker({
        getHostAdapter: this.getHostAdapter.bind(this),
        logger: this.logger.child('health'),
        timeoutMs: 3000,
        degradedLatencyThresholdMs: 300,
      });

    this.hostHealthChecker.onHealthUpdated((health) => {
      const wc = this.getWebContents();
      if (wc && (typeof (wc as any).isDestroyed !== 'function' || !(wc as any).isDestroyed())) {
        wc.send('host:healthUpdated', health);
      }
    });

    this.hostHealthChecker.onAllUpdated((healthMap) => {
      const wc = this.getWebContents();
      if (wc && (typeof (wc as any).isDestroyed !== 'function' || !(wc as any).isDestroyed())) {
        wc.send('hosts:healthChanged', healthMap);
      }
    });
  }

  setWebContentsGetter(getter: () => WebContents | null): void {
    this.webContentsGetter = getter;
  }

  getWebContents(): WebContents | null {
    return this.webContentsGetter ? this.webContentsGetter() : null;
  }

  getHostHealthChecker(): HostHealthChecker {
    return this.hostHealthChecker;
  }

  private setupHostAdapterListeners(adapter: HostAdapter): void {
    if (typeof adapter.onConnectionStateChange === 'function') {
      adapter.onConnectionStateChange(async (state) => {
        this.logger.info('Host connection state changed', state as unknown as Record<string, unknown>);
        const wc = this.webContentsGetter?.();
        if (wc && (typeof wc.isDestroyed !== 'function' || !wc.isDestroyed())) {
          wc.send('host:connectionStateChanged', state);
        }

        // If host successfully recovered (reconnecting -> connected)
        if (state.status === 'connected' && state.attempt === 0) {
          await this.handleHostReconnected(state.serverId);
        }
      });
    }
  }

  private createCatalogSshAdapter(serverId: string, ssh: CatalogSsh): SSHHostAdapter {
    const credentialBacked = isOnePasswordReference(ssh.target)
      || (ssh.user ? isOnePasswordReference(ssh.user) : false)
      || (typeof ssh.port === 'string' && isOnePasswordReference(ssh.port));
    if (!credentialBacked) {
      return new SSHHostAdapter({
        serverId,
        target: ssh.target,
        user: ssh.user,
        port: typeof ssh.port === 'number' ? ssh.port : undefined,
        logger: this.logger.child(`ssh:${serverId}`),
      });
    }

    return new SSHHostAdapter({
      serverId,
      target: serverId,
      displayTarget: `${serverId} (credential-backed)`,
      credentialBacked: true,
      logger: this.logger.child(`ssh:${serverId}`),
      connectionOptionsProvider: async () => {
        const releases: Array<() => void> = [];
        try {
          const target = await this.onePasswordResolver.resolveString(ssh.target, `hosts.${serverId}.ssh.target`, 'ssh_target');
          releases.push(target.release);
          const user = ssh.user
            ? await this.onePasswordResolver.resolveString(ssh.user, `hosts.${serverId}.ssh.user`, 'ssh_user')
            : undefined;
          if (user) releases.push(user.release);
          const port = await this.onePasswordResolver.resolvePort(ssh.port, `hosts.${serverId}.ssh.port`);
          releases.push(port.release);
          return {
            target: target.value,
            user: user?.value,
            port: port.value,
            release: () => releases.splice(0).reverse().forEach((release) => release()),
          };
        } catch (error) {
          releases.splice(0).reverse().forEach((release) => release());
          throw error;
        }
      },
    });
  }

  private catalogSshIsCredentialBacked(ssh: CatalogSsh | undefined): boolean {
    return Boolean(ssh && (
      isOnePasswordReference(ssh.target)
      || (ssh.user ? isOnePasswordReference(ssh.user) : false)
      || (typeof ssh.port === 'string' && isOnePasswordReference(ssh.port))
    ));
  }

  private async resolveCatalogPathLocator(locatorValue: string): Promise<ResolvedValueLease<string>> {
    const locator = parseCatalogPathLocator(locatorValue);
    if (!locator) return { value: locatorValue, sensitive: false, release: () => undefined };
    const project = this.catalogManager.getState().catalog?.hosts[locator.hostId]?.projects[locator.projectId];
    if (!project) {
      throw new Error(`Credential-backed project '${locator.hostId}:${locator.projectId}' is no longer present in the catalog.`);
    }
    const resolved = await this.onePasswordResolver.resolveString(
      project.path,
      `hosts.${locator.hostId}.projects.${locator.projectId}.path`,
      'project_path'
    );
    return {
      value: locator.kind === 'worktree'
        ? `${resolved.value.replace(/\/+$/, '')}__worktrees/${locator.worktreeLeaf}`
        : resolved.value,
      sensitive: resolved.sensitive,
      release: resolved.release,
    };
  }

  public async resolveSessionWorktreePath(session: Session): Promise<ResolvedValueLease<string>> {
    return this.resolveCatalogPathLocator(session.worktreePath);
  }

  public async resolvePersistedSessionPath(
    session: Session,
    persistedPath: string
  ): Promise<ResolvedValueLease<string>> {
    const persistedRoot = session.worktreePath.replace(/\/+$/, '');
    const suffix = persistedPath === persistedRoot
      ? ''
      : persistedPath.startsWith(`${persistedRoot}/`)
        ? persistedPath.slice(persistedRoot.length)
        : (() => {
            throw new Error('Persisted session path is outside the workspace boundary.');
          })();
    const root = await this.resolveSessionWorktreePath(session);
    try {
      const resolvedPath = resolveContainedPath(root.value, `${root.value}${suffix}`);
      return {
        value: resolvedPath,
        sensitive: root.sensitive,
        release: root.release,
      };
    } catch (error) {
      root.release();
      throw error;
    }
  }

  private async resolveProjectRepositoryPath(projectId: string, rootPath: string): Promise<ResolvedValueLease<string>> {
    const locator = parseCatalogPathLocator(rootPath);
    if (locator) return this.resolveCatalogPathLocator(rootPath);
    const [hostId, rawProjectId = projectId] = projectId.includes(':') ? projectId.split(':', 2) : ['', projectId];
    const catalogPath = hostId
      ? this.catalogManager.getState().catalog?.hosts[hostId]?.projects[rawProjectId]?.path
      : undefined;
    if (catalogPath && isOnePasswordReference(catalogPath)) {
      return this.onePasswordResolver.resolveString(
        catalogPath,
        `hosts.${hostId}.projects.${rawProjectId}.path`,
        'project_path'
      );
    }
    return { value: rootPath, sensitive: false, release: () => undefined };
  }

  private async handleHostReconnected(serverId: string): Promise<void> {
    this.logger.info('Host reconnected, restoring active terminal streams', { serverId });
    for (const [sessionId, info] of this.attachedSessions.entries()) {
      if (info.serverId === serverId) {
        try {
          this.logger.info('Transparently re-attaching PTY stream for session after host recovery', { sessionId });
          const res = await this.attachSession(sessionId, info.webContents, info.cols, info.rows);
          if (info.webContents && (typeof info.webContents.isDestroyed !== 'function' || !info.webContents.isDestroyed())) {
            info.webContents.send('session:reconnected', { sessionId, ptyChannelId: res.ptyChannelId });
          }
        } catch (err) {
          this.logger.warn('Failed to re-attach session PTY on host recovery', { sessionId, error: err });
        }
      }
    }
  }

  /**
   * Retrieves or establishes a HostAdapter for a configured server profile.
   */
  async getHostAdapter(serverId: string): Promise<HostAdapter> {
    if (this.hostPool.has(serverId)) {
      return this.hostPool.get(serverId)!;
    }

    if (this.customHostFactory) {
      const adapter = await this.customHostFactory(serverId);
      this.setupHostAdapterListeners(adapter);
      this.hostPool.set(serverId, adapter);
      return adapter;
    }

    // Look up host in catalog first
    const catalog = this.catalogManager.getState().catalog;
    const catalogHost = catalog?.hosts[serverId];

    if (catalogHost?.ssh) {
      const sshAdapter = this.createCatalogSshAdapter(serverId, catalogHost.ssh);
      this.setupHostAdapterListeners(sshAdapter);
      this.hostPool.set(serverId, sshAdapter);
      return sshAdapter;
    }

    if (catalogHost && !catalogHost.ssh) {
      const localAdapter = new LocalHostAdapter({
        serverId,
        logger: this.logger.child(`local:${serverId}`),
      });
      this.setupHostAdapterListeners(localAdapter);
      this.hostPool.set(serverId, localAdapter);
      return localAdapter;
    }

    // Fallback: look up in SQLite servers repository
    const dbServer = await this.repos.servers.findById(serverId);
    if (!dbServer) {
      throw new Error(`Host profile '${serverId}' not found in catalog or database`);
    }

    const hasDirectSshSettings = Boolean(dbServer.sshConfigAlias || dbServer.sshUser || dbServer.sshPort !== 22);
    if (isLoopbackHost(dbServer.host) && !hasDirectSshSettings) {
      const localAdapter = new LocalHostAdapter({
        serverId,
        logger: this.logger.child(`local:${serverId}`),
      });
      this.setupHostAdapterListeners(localAdapter);
      this.hostPool.set(serverId, localAdapter);
      return localAdapter;
    }

    if (dbServer.id === 'mock-server') {
      const mockAdapter = new MockHostAdapter(serverId);
      this.setupHostAdapterListeners(mockAdapter);
      this.hostPool.set(serverId, mockAdapter);
      return mockAdapter;
    }

    const sshAdapter = new SSHHostAdapter({
      serverId,
      target: dbServer.sshConfigAlias || dbServer.host,
      user: dbServer.sshUser,
      port: dbServer.sshPort,
      logger: this.logger.child(`ssh:${serverId}`),
    });
    this.setupHostAdapterListeners(sshAdapter);
    this.hostPool.set(serverId, sshAdapter);
    return sshAdapter;
  }

  /**
   * Retrieves connection state for a given host profile.
   */
  async getHostConnectionState(serverId: string): Promise<HostConnectionState> {
    const host = await this.getHostAdapter(serverId);
    if (typeof host.getConnectionState === 'function') {
      return host.getConnectionState();
    }
    return {
      serverId,
      status: host.isConnected() ? 'connected' : 'disconnected',
      attempt: 0,
      maxAttempts: 5,
    };
  }

  /**
   * Resolves the actual connection endpoint for renderer-side transport decisions.
   */
  async getHostConnectionEndpoint(serverId: string): Promise<HostConnectionEndpoint | null> {
    const host = await this.getHostAdapter(serverId);
    if (typeof host.getConnectionEndpoint !== 'function') {
      return null;
    }
    return host.getConnectionEndpoint();
  }

  /**
   * Immediately retries connection for a given host profile (cancelling pending timers).
   */
  async retryHostConnection(serverId: string): Promise<HostConnectionState> {
    this.logger.info('Retrying host connection on demand (Retry Now)', { serverId });
    const host = await this.getHostAdapter(serverId);
    if (typeof (host as any).retryNow === 'function') {
      await (host as any).retryNow();
    } else if (typeof host.reconnect === 'function') {
      await host.reconnect();
    } else {
      await host.connect();
    }
    return this.getHostConnectionState(serverId);
  }

  /**
   * Retrieves host system telemetry (OS, kernel, CPU, memory, uptime) with in-memory caching.
   */
  async getHostSystemInfo(serverId: string, forceRefresh = false): Promise<HostSystemInfo | null> {
    if (!forceRefresh && this.hostSystemInfoCache.has(serverId)) {
      return this.hostSystemInfoCache.get(serverId) || null;
    }

    try {
      const host = await this.getHostAdapter(serverId);
      const info = await fetchHostSystemInfo(host, this.logger);
      if (info) {
        this.hostSystemInfoCache.set(serverId, info);
      }
      return info;
    } catch (err) {
      this.logger.warn('Failed to retrieve host system info (best effort)', { serverId, error: err });
      return null;
    }
  }

  /**
   * Tests SSH connection to a single selected host profile on demand (FG-1.2, FG-2.1).
   */
  async testHost(hostId: string): Promise<HostTestResult> {
    this.logger.info('Testing selected host connection', { hostId });
    try {
      const host = await this.getHostAdapter(hostId);
      return await host.testConnection();
    } catch (err: any) {
      const message = err?.message || String(err);
      this.logger.error('Host connection test error', err, { hostId });
      return {
        success: false,
        hostId,
        target: hostId,
        error: maskSensitiveString(message),
      };
    }
  }

  async discoverProjectBranches(
    serverId: string,
    projectPath: string,
    preferredBranch?: string
  ): Promise<GitBranchDiscoveryResult> {
    const host = await this.getHostAdapter(serverId);
    const resolvedPath = await this.resolveCatalogPathLocator(projectPath);
    try {
      return await this.gitService.discoverBranches(host, resolvedPath.value, preferredBranch);
    } finally {
      resolvedPath.release();
    }
  }

  /**
   * Checks health and latency of a single host in background.
   */
  async checkHostHealth(serverId: string): Promise<HostHealthResult> {
    return this.hostHealthChecker.checkHost(serverId);
  }

  /**
   * Checks health and latency across all catalog and database hosts concurrently in parallel.
   */
  async checkAllHostsHealth(options: { includeCredentialBacked?: boolean } = {}): Promise<Record<string, HostHealthResult>> {
    const catalog = this.catalogManager.getState().catalog;
    const credentialBackedCatalogIds = new Set(
      catalog
        ? Object.entries(catalog.hosts)
            .filter(([, host]) => this.catalogSshIsCredentialBacked(host.ssh))
            .map(([id]) => id)
        : []
    );
    const catalogHostEntries = catalog
      ? Object.entries(catalog.hosts).flatMap(([id, host]) => {
          const credentialBacked = this.catalogSshIsCredentialBacked(host.ssh);
          if (credentialBacked && !options.includeCredentialBacked) return [];
          return [{
            id,
            target: credentialBacked
              ? `${host.name || id} (1Password-backed)`
              : host.ssh?.target || host.name || id,
          }];
        })
      : [];
    const dbServers = await this.repos.servers.findAll();
    const dbHostEntries = dbServers.flatMap((s) => {
      if (!options.includeCredentialBacked
          && (credentialBackedCatalogIds.has(s.id) || s.host === 'credential-backed')) {
        return [];
      }
      return [{
        id: s.id,
        target: s.sshConfigAlias || s.host || s.id,
      }];
    });

    const map = new Map<string, { id: string; target?: string }>();
    for (const item of [...catalogHostEntries, ...dbHostEntries]) {
      if (!map.has(item.id)) {
        map.set(item.id, item);
      }
    }

    return this.hostHealthChecker.checkAllHosts(Array.from(map.values()));
  }

  /**
   * Retrieves all cached host health records.
   */
  getAllCachedHostHealth(): Record<string, HostHealthResult> {
    return this.hostHealthChecker.getAllCachedHealth();
  }

  /**
   * Retrieves cached host health for a single host.
   */
  getCachedHostHealth(serverId: string): HostHealthResult | undefined {
    return this.hostHealthChecker.getCachedHealth(serverId);
  }

  /**
   * Starts periodic parallel background checks across catalog and configured hosts.
   */
  startHostHealthMonitoring(intervalMs = 30000): () => void {
    return this.hostHealthChecker.startPeriodicChecks(() => {
      const catalog = this.catalogManager.getState().catalog;
      if (!catalog) return [];
      return Object.entries(catalog.hosts).flatMap(([id, host]) => {
        if (this.catalogSshIsCredentialBacked(host.ssh)) return [];
        return [{ id, target: host.ssh?.target || host.name || id }];
      });
    }, intervalMs);
  }

  /**
   * Stops periodic host health monitoring.
   */
  stopHostHealthMonitoring(): void {
    this.hostHealthChecker.stopPeriodicChecks();
  }


  /**
   * Creates an Spawnea-owned persistent session (FG-2.2, FG-2.5):
   * 1. Validates selections and prevents duplicate simultaneous starts.
   * 2. Prepares the remote project folder (reuse / clone / create).
   * 3. Creates persistent tmux session and launches the configured harness command.
   * 4. Persists session context file and saves SQLite session record.
   */
  async createSession(input: CreateSessionInput, creationSource: SessionCreationSource = 'ui'): Promise<Session> {
    if (!input.task || input.task.trim() === '') {
      throw new Error('Task description is required to create a session');
    }

    const slug = input.task
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 30) || 'task';

    const lockKey = `${input.serverId}:${input.projectId}`;
    if (this.startingSessions.has(lockKey)) {
      throw new Error(`Another session start is already in progress for project '${input.projectId}'`);
    }

    this.startingSessions.add(lockKey);
    let releaseProjectPath: () => void = () => undefined;
    try {
      this.logger.info('Initiating session creation', {
        serverId: input.serverId,
        projectId: input.projectId,
        agentId: input.agentId,
        task: input.task,
      });

      // 1. Resolve host, project, and agent definitions
      const host = await this.getHostAdapter(input.serverId);

      const catalog = this.catalogManager.getState().catalog;
      const catalogHost = catalog?.hosts[input.serverId];

      let rawProjId = input.projectId;
      if (rawProjId.includes(':')) {
        rawProjId = rawProjId.split(':')[1];
      }

      let rawHarnessId = input.agentId;
      if (rawHarnessId.includes(':')) {
        rawHarnessId = rawHarnessId.split(':')[1];
      }

      const catProject = catalogHost?.projects[rawProjId];
      const catHarness = catalogHost?.harnesses[rawHarnessId];

      const dbProject = await this.repos.projects.findById(input.projectId);
      const dbAgent = await this.repos.agents.findById(input.agentId);

      const configuredProjectPath = catProject?.path || dbProject?.rootPath;
      if (!configuredProjectPath) {
        throw new Error(`Project path for '${input.projectId}' could not be resolved`);
      }
      const projectPathLease = isOnePasswordReference(configuredProjectPath)
        ? await this.onePasswordResolver.resolveString(
            configuredProjectPath,
            `hosts.${input.serverId}.projects.${rawProjId}.path`,
            'project_path'
          )
        : await this.resolveCatalogPathLocator(configuredProjectPath);
      const projectPath = projectPathLease.value;
      releaseProjectPath = projectPathLease.release;

      const projectName = catProject?.name || dbProject?.name || 'Project';
      const gitUrl = catProject?.git_url || dbProject?.repoUrl || undefined;
      const configuredBaseBranch = catProject?.base_branch?.trim() || dbProject?.baseBranch?.trim() || undefined;
      const effectiveBaseBranch = configuredBaseBranch || input.baseBranch?.trim() || undefined;

      const harnessCommand = catHarness?.command || dbAgent?.command || 'bash';
      const harnessArgs = catHarness?.args || dbAgent?.argsTemplate || [];
      const harnessName = catHarness?.name || dbAgent?.name || 'Harness';

      // 2. Prepare remote project folder (FG-2.2.2 - FG-2.2.5)
      const prepResult = await prepareProjectFolder({
        host,
        path: projectPath,
        gitUrl,
        logger: this.logger.child('project-prep'),
      });

      if (!prepResult.success) {
        throw new Error(prepResult.error || `Failed to prepare project directory at ${projectPath}`);
      }

      // 3. Provision the optional session-owned worktree.
      const sessionId = `sess-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;
      const tmuxSessionName = `spawnea-${slug}-${Date.now().toString(36).substring(3)}`;
      const worktreeConfig = catProject?.worktree;
      let runtimePath = prepResult.path;
      let repositoryPath = prepResult.path;
      let branchName = effectiveBaseBranch || `task/${slug}`;
      let baseBranch: string | undefined;
      let baseCommit: string | undefined;
      let managedWorktree = false;
      let tmuxCreated = false;
      const shouldUseWorktree = input.useWorktree ?? (worktreeConfig?.enabled ?? false);

      try {
        if (shouldUseWorktree) {
          const provisioned = await this.gitService.createManagedWorktree({
            host,
            repositoryPath: prepResult.path,
            taskSlug: slug,
            sessionSuffix: sessionId.slice('sess-'.length),
            baseBranch: effectiveBaseBranch,
          });
          runtimePath = provisioned.worktreePath;
          repositoryPath = provisioned.repositoryPath;
          branchName = provisioned.branch;
          baseBranch = provisioned.baseBranch;
          baseCommit = provisioned.baseCommit;
          managedWorktree = true;

          if (worktreeConfig?.copy_files && worktreeConfig.copy_files.length > 0) {
            await this.gitService.copyFilesToWorktree(
              host,
              repositoryPath,
              runtimePath,
              worktreeConfig.copy_files
            );
          }
        }

        // 4. Establish the persistent tmux session in the effective runtime directory.
        const tmuxResult = await this.tmuxManager.createPersistentSession({
          host,
          sessionName: tmuxSessionName,
          cwd: runtimePath,
          command: harnessCommand,
          args: harnessArgs,
          env: undefined,
          logger: this.logger.child('tmux'),
        });

        if (!tmuxResult.success) {
          throw new Error(tmuxResult.error || `Failed to establish persistent tmux session '${tmuxSessionName}'`);
        }
        tmuxCreated = true;

        const nowIso = new Date().toISOString();
        const credentialBackedProject = isOnePasswordReference(catProject?.path);
        const persistedRuntimePath = credentialBackedProject
          ? managedWorktree
            ? createCatalogWorktreePathLocator(
                input.serverId,
                rawProjId,
                branchName.startsWith('spawnea/')
                  ? branchName.slice('spawnea/'.length)
                  : branchName.startsWith('spawnea/')
                    ? branchName.slice('spawnea/'.length)
                    : sessionId
              )
            : createCatalogProjectPathLocator(input.serverId, rawProjId)
          : runtimePath;

        // 5. Persist session context file before returning (FG-2.2.8)
        const contextFile: SessionContextFile = {
          version: 1,
          sessionId,
          sessionName: input.task,
          task: input.task,
          host: {
            id: input.serverId,
            name: catalogHost?.name || input.serverId,
            ssh: catalogHost?.ssh && !this.catalogSshIsCredentialBacked(catalogHost.ssh)
              ? {
                  target: catalogHost.ssh.target,
                  user: catalogHost.ssh.user,
                  port: typeof catalogHost.ssh.port === 'number' ? catalogHost.ssh.port : undefined,
                }
              : undefined,
          },
          project: {
            id: input.projectId,
            name: projectName,
            path: persistedRuntimePath,
            git_url: gitUrl,
          },
          worktree: managedWorktree && baseBranch
            ? {
                managed: true,
                path: persistedRuntimePath,
                branch: branchName,
                baseBranch,
                baseCommit,
              }
            : undefined,
          harness: {
            id: input.agentId,
            name: harnessName,
            command: harnessCommand,
            args: harnessArgs,
          },
          persistentSession: {
            type: 'tmux',
            name: tmuxSessionName,
            window: `${tmuxSessionName}:0`,
          },
          reconnectTarget: {
            type: 'tmux',
            name: tmuxSessionName,
            hostId: input.serverId,
          },
          status: 'working',
          creationSource,
          createdAt: nowIso,
          updatedAt: nowIso,
        };

        await this.contextStore.save(contextFile);

        // 6. Save in SQLite database
        const savedSession = await this.repos.sessions.save({
          id: sessionId,
          name: input.task,
          serverId: input.serverId,
          projectId: input.projectId,
          agentId: input.agentId,
          task: input.task,
          worktreePath: persistedRuntimePath,
          branch: branchName,
          baseBranch,
          baseCommit,
          managedWorktree,
          tmuxSessionName,
          status: 'working',
          creationSource,
        });

        this.logger.info('Session successfully created and persisted', {
          sessionId,
          tmuxSessionName,
          worktreePath: runtimePath,
          managedWorktree,
        });

        return savedSession;
      } catch (error) {
        await this.contextStore.delete(sessionId).catch(() => false);

        let runtimeStopped = !tmuxCreated;
        if (tmuxCreated) {
          runtimeStopped = await this.tmuxManager.killSession(host, tmuxSessionName).catch(() => false);
        }

        if (managedWorktree && runtimeStopped) {
          const removed = await this.gitService
            .removeManagedWorktree(host, repositoryPath, runtimePath)
            .catch(() => false);
          if (!removed) {
            this.logger.warn('Managed worktree was preserved after failed session creation', {
              worktreePath: runtimePath,
              branch: branchName,
            });
          }
        } else if (managedWorktree) {
          this.logger.warn('Managed worktree was preserved because its tmux session could not be stopped', {
            worktreePath: runtimePath,
            branch: branchName,
            tmuxSessionName,
          });
        }

        throw error;
      }
    } finally {
      releaseProjectPath();
      this.startingSessions.delete(lockKey);
    }
  }

  /** Updates the operator-facing name without changing task or runtime identity. */
  async renameSession(sessionId: string, requestedName: string): Promise<Session> {
    const name = requestedName.trim();
    if (!name) {
      throw new Error('Session title cannot be empty');
    }
    if (name.length > 120) {
      throw new Error('Session title must be 120 characters or fewer');
    }

    const existing = await this.repos.sessions.findById(sessionId);
    if (!existing) {
      throw new Error(`Session '${sessionId}' not found`);
    }
    if (existing.name === name) {
      return existing;
    }

    const updated = await this.repos.sessions.update(sessionId, { name });
    const contextUpdated = await this.contextStore.updateSessionName(sessionId, name);
    if (!contextUpdated) {
      this.logger.warn('Session renamed without a context file to update', { sessionId });
    }

    this.logger.info('Session display title updated', { sessionId });
    return updated;
  }

  /**
   * Attaches to an active session, establishing the interactive SSH PTY channel (FG-2.2.9).
   */
  async attachSession(
    sessionId: string,
    webContents: WebContents,
    cols = 80,
    rows = 24
  ): Promise<{ ptyChannelId: string }> {
    this.logger.info('Attaching to session', { sessionId });
    const session = await this.repos.sessions.findById(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    const host = await this.getHostAdapter(session.serverId);

    // Verify the persistent tmux session is actually alive before opening PTY
    const exists = await this.tmuxManager.hasSession(host, session.tmuxSessionName);
    if (!exists) {
      this.logger.warn('Tmux session not found on host during attach', {
        serverId: session.serverId,
        sessionName: session.tmuxSessionName,
      });
      await this.repos.sessions.updateStatus(sessionId, 'done');
      await this.contextStore.updateStatus(sessionId, 'done');
      throw new Error(
        `Persistent tmux session '${session.tmuxSessionName}' is no longer active on host '${session.serverId}'. It may have finished or exited.`
      );
    }

    const ptyChannelId = `pty-${sessionId}`;
    this.ptyBroker.close(ptyChannelId);

    const ptyStream = await this.tmuxManager.attachPty(host, session.tmuxSessionName, {
      cols,
      rows,
    });

    this.ptyBroker.registerPty(ptyChannelId, ptyStream, webContents);
    this.attachedSessions.set(sessionId, {
      sessionId,
      serverId: session.serverId,
      cols,
      rows,
      webContents,
    });

    if (session.status === 'disconnected') {
      await this.repos.sessions.updateStatus(sessionId, 'idle');
      await this.contextStore.updateStatus(sessionId, 'idle');
      if (webContents && (typeof (webContents as any).isDestroyed !== 'function' || !(webContents as any).isDestroyed())) {
        webContents.send('session:statusChanged', sessionId, 'idle');
      }
    }

    return { ptyChannelId };
  }

  /**
   * Detaches terminal interaction without ending remote execution (FG-2.3.1, FG-2.3.3).
   */
  async detachSession(sessionId: string): Promise<void> {
    this.logger.info('Detaching from session', { sessionId });
    this.attachedSessions.delete(sessionId);
    const ptyChannelId = `pty-${sessionId}`;
    this.ptyBroker.close(ptyChannelId);
    await this.repos.sessions.updateStatus(sessionId, 'disconnected');
    await this.contextStore.updateStatus(sessionId, 'disconnected');
  }

  /**
   * Explicitly ends an owned session and validates that execution ceased on the host (FG-2.7.3, FG-2.7.4).
   * 1. Looks up owned session record.
   * 2. Issues stop/kill command to the target host.
   * 3. Validates that the persistent tmux session is absent from the host before concluding.
   * 4. Closes local PTY channel broker stream upon validated termination.
   * 5. Transitions status to 'done' in SQLite and context store.
   */
  async stopSession(sessionId: string): Promise<void> {
    this.logger.info('Stopping session', { sessionId });
    this.attachedSessions.delete(sessionId);
    const session = await this.repos.sessions.findById(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    // 1. Send stop/kill command to the target host for the owned session
    const host = await this.getHostAdapter(session.serverId);
    const terminated = await this.tmuxManager.killSession(host, session.tmuxSessionName);

    // 2. Validate termination on the host (FG-2.7.3)
    if (!terminated) {
      this.logger.error('Session termination could not be verified on host', new Error('Tmux session still present'), {
        sessionId,
        tmuxSessionName: session.tmuxSessionName,
      });
      throw new Error(
        `Failed to verify termination of persistent session '${session.tmuxSessionName}' on host '${session.serverId}'. Execution may still be active.`
      );
    }

    // 3. Cleanly close local PTY broker stream upon verified termination
    const ptyChannelId = `pty-${sessionId}`;
    this.ptyBroker.close(ptyChannelId);

    // 4. Update status to 'done' in SQLite and context store (FG-2.7.4)
    await this.repos.sessions.updateStatus(sessionId, 'done');
    await this.contextStore.updateStatus(sessionId, 'done');
    this.logger.info('Session termination verified and recorded as done', { sessionId });
  }

  /**
   * Deletes a session completely (FG-2.6.5, FG-2.7.4):
   * 1. Closes any open PTY channel.
   * 2. Kills remote tmux session if still active on the host.
   * 3. Deletes session context file from disk.
   * 4. Deletes session from SQLite repository.
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    this.logger.info('Deleting session', { sessionId });
    this.attachedSessions.delete(sessionId);
    const ptyChannelId = `pty-${sessionId}`;
    this.ptyBroker.close(ptyChannelId);

    try {
      const session = await this.repos.sessions.findById(sessionId);
      if (session) {
        try {
          const host = await this.getHostAdapter(session.serverId);
          const exists = await this.tmuxManager.hasSession(host, session.tmuxSessionName);
          if (exists) {
            await this.tmuxManager.killSession(host, session.tmuxSessionName);
          }
        } catch (err) {
          this.logger.warn('Failed to clean up remote session resources during deletion (host may be unreachable)', { error: err });
        }
      }
    } catch (err) {
      this.logger.warn('Error querying session for tmux cleanup during deletion', { error: err });
    }

    try {
      await this.contextStore.delete(sessionId);
    } catch (err) {
      this.logger.warn('Failed to delete context file during deletion', { error: err });
    }

    try {
      await this.repos.sessions.delete(sessionId);
    } catch (err) {
      this.logger.warn('Failed to delete session from database during deletion', { error: err });
    }

    this.logger.info('Session deletion completed', { sessionId });
    return true;
  }

  /**
   * Finishes an isolated task worktree session (Integrate, Ignore, or Close) (Task 6.2.1).
   */
  async finishSession(
    sessionId: string,
    action: FinishSessionAction,
    options: FinishSessionOptions = {},
    origin: FinishSessionOrigin = 'ui'
  ): Promise<FinishSessionResult> {
    this.logger.info('Finishing managed worktree session', { sessionId, action, origin });
    if (origin === 'mcp-validated' && action !== 'close') {
      throw new Error("The 'mcp-validated' finalization origin is only valid for close requests");
    }
    const session = await this.repos.sessions.findById(sessionId);
    if (!session) {
      throw new Error(`Session with ID '${sessionId}' not found`);
    }

    if (action === 'ignore') {
      this.logger.info('Ignoring session finalization prompt without mutations', { sessionId });
      return { action: 'ignore', removed: false };
    }

    if (!session.managedWorktree) {
      throw new Error(`Session '${sessionId}' is not a managed worktree session and cannot be finalized`);
    }

    if (!session.branch) {
      throw new Error(`Session '${sessionId}' does not have an associated task branch`);
    }

    const project = await this.repos.projects.findById(session.projectId);
    if (!project) {
      throw new Error(`Project '${session.projectId}' associated with session '${sessionId}' not found`);
    }

    const host = await this.getHostAdapter(session.serverId);
    const repositoryPath = await this.resolveProjectRepositoryPath(session.projectId, project.rootPath);
    const worktreePath = await this.resolveSessionWorktreePath(session);
    try {
      const identity: ManagedWorktreeIdentity = {
        repositoryPath: repositoryPath.value,
        worktreePath: worktreePath.value,
        branch: session.branch,
        baseBranch: session.baseBranch || 'main',
        baseCommit: session.baseCommit,
      };

      if (action === 'integrate') {
        // 1. Safety check: Verify worktree is clean and base branch is clean and ready
        await this.gitService.verifyManagedWorktreeForFinalization(host, identity, true);

        // 2. Stop persistent session and detach PTY
        try {
          await this.stopSession(sessionId);
        } catch (err) {
          this.logger.warn('Failed to stop tmux session during integration (may already be stopped)', { error: err });
        }

        // 3. Merge task branch into base branch
        await this.gitService.mergeManagedBranch(host, identity);

        // 4. Remove worktree
        await this.gitService.removeManagedWorktree(host, repositoryPath.value, worktreePath.value);

        // 5. Delete integrated task branch
        await this.gitService.deleteIntegratedBranch(host, identity);

        // 6. Clean up session DB and context store
        await this.contextStore.delete(sessionId).catch(() => {});
        await this.repos.sessions.delete(sessionId).catch(() => {});

        this.logger.info('Session successfully integrated and finalized', { sessionId, branch: identity.branch });
        return { action: 'integrate', removed: true };
      }

      if (action === 'close') {
        // 1. Verify identity, but allow the explicit close flow to handle local changes.
        const inspection = await this.gitService.inspectManagedWorktree(host, identity);
        await this.gitService.verifyManagedWorktreeForFinalization(
          host,
          identity,
          false,
          false,
          inspection.state === 'integrated'
        );

        // 2. Stop persistent session and detach PTY
        try {
          await this.stopSession(sessionId);
        } catch (err) {
          this.logger.warn('Failed to stop tmux session during close (may already be stopped)', { error: err });
        }

        // 3. Preserve or discard local changes before removing the worktree.
        if (options.stashChanges) {
          await this.gitService.stashManagedWorktreeChanges(host, identity);
        } else {
          await this.gitService.discardManagedWorktreeChanges(host, identity);
        }

        // 4. Remove worktree (preserves task branch)
        await this.gitService.removeManagedWorktree(host, repositoryPath.value, worktreePath.value);

        // 5. Clean up session DB and context store
        await this.contextStore.delete(sessionId).catch(() => {});
        await this.repos.sessions.delete(sessionId).catch(() => {});

        this.logger.info('Session worktree closed and session record removed while preserving branch', {
          sessionId,
          branch: identity.branch,
        });
        return { action: 'close', removed: true };
      }

      throw new Error(`Unsupported finalization action: ${action}`);
    } finally {
      worktreePath.release();
      repositoryPath.release();
    }
  }

  async inspectManagedWorktree(sessionId: string): Promise<ManagedWorktreeInspection> {
    const session = await this.repos.sessions.findById(sessionId);
    if (!session?.managedWorktree || !session.branch) {
      throw new Error(`Session '${sessionId}' is not a managed worktree session`);
    }
    const project = await this.repos.projects.findById(session.projectId);
    if (!project) {
      throw new Error(`Project '${session.projectId}' associated with session '${sessionId}' not found`);
    }
    const host = await this.getHostAdapter(session.serverId);
    const repositoryPath = await this.resolveProjectRepositoryPath(session.projectId, project.rootPath);
    const worktreePath = await this.resolveSessionWorktreePath(session);
    try {
      return await this.gitService.inspectManagedWorktree(host, {
        repositoryPath: repositoryPath.value,
        worktreePath: worktreePath.value,
        branch: session.branch,
        baseBranch: session.baseBranch || 'main',
        baseCommit: session.baseCommit,
      });
    } finally {
      worktreePath.release();
      repositoryPath.release();
    }
  }

  /**
   * Discovers active unmanaged tmux sessions on a target host (FG-7.2.1).
   */
  async discoverExternalSessions(serverId: string): Promise<DiscoveredTmuxSession[]> {
    this.logger.info('Discovering external tmux sessions', { serverId });
    const host = await this.getHostAdapter(serverId);
    const existingSessions = await this.repos.sessions.findByServerId(serverId);
    const knownSessionNames = new Set(existingSessions.map((s) => s.tmuxSessionName));
    return this.tmuxManager.listExternalSessions(host, knownSessionNames);
  }

  /**
   * Adopts an external tmux session into Spawnea (FG-7.2.2).
   */
  async adoptSession(input: AdoptSessionInput): Promise<Session> {
    if (!input.tmuxSessionName || input.tmuxSessionName.trim() === '') {
      throw new Error('Tmux session name is required to adopt a session');
    }
    if (!input.serverId) {
      throw new Error('Server ID is required to adopt a session');
    }
    if (input.projectPath && containsOnePasswordReference(input.projectPath)) {
      throw new Error('1Password references must be selected from the operational catalog and cannot be persisted as ad-hoc project paths.');
    }

    this.logger.info('Adopting external tmux session', {
      serverId: input.serverId,
      tmuxSessionName: input.tmuxSessionName,
      projectId: input.projectId,
      agentId: input.agentId,
    });

    const host = await this.getHostAdapter(input.serverId);

    // 1. Verify tmux session actually exists on target host
    const exists = await this.tmuxManager.hasSession(host, input.tmuxSessionName);
    if (!exists) {
      throw new Error(`Tmux session '${input.tmuxSessionName}' not found on host '${input.serverId}'`);
    }

    // 2. Resolve or match project
    let finalProjectId = input.projectId;
    let projectPath = input.projectPath;
    let projectName = 'External Project';

    if (finalProjectId && finalProjectId.trim() !== '') {
      const dbProject = await this.repos.projects.findById(finalProjectId);
      if (dbProject) {
        projectPath = dbProject.rootPath;
        projectName = dbProject.name;
      }
    } else {
      // Search existing projects for matching path
      const serverProjects = await this.repos.projects.findByServerId(input.serverId);
      const matchingProj = projectPath ? serverProjects.find((p) => p.rootPath === projectPath) : undefined;

      if (matchingProj) {
        finalProjectId = matchingProj.id;
        projectName = matchingProj.name;
        projectPath = matchingProj.rootPath;
      } else {
        // Create ad-hoc project record in SQLite without modifying catalog file
        const resolvedPath = projectPath || `/tmp`;
        const folderName = resolvedPath.split('/').filter(Boolean).pop() || 'project';
        const adHocProjId = `proj-adhoc-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;
        const savedProj = await this.repos.projects.save({
          id: adHocProjId,
          serverId: input.serverId,
          name: folderName,
          rootPath: resolvedPath,
        });
        finalProjectId = savedProj.id;
        projectName = savedProj.name;
        projectPath = savedProj.rootPath;
      }
    }

    // 3. Resolve or match agent / harness
    let finalAgentId = input.agentId;
    let harnessName = 'Terminal';
    let harnessCommand = input.harnessCommand || 'bash';

    if (finalAgentId && finalAgentId.trim() !== '' && finalAgentId !== 'none' && finalAgentId !== 'terminal') {
      const dbAgent = await this.repos.agents.findById(finalAgentId);
      if (dbAgent) {
        harnessName = dbAgent.name;
        harnessCommand = dbAgent.command;
      }
    } else {
      // Use terminal harness without agent icon
      const existingTerminal = await this.repos.agents.findById('agent-terminal');
      if (existingTerminal) {
        finalAgentId = existingTerminal.id;
        harnessName = existingTerminal.name;
      } else {
        const savedAgent = await this.repos.agents.save({
          id: 'agent-terminal',
          name: 'Terminal',
          harness: 'none',
          command: 'bash',
        });
        finalAgentId = savedAgent.id;
        harnessName = savedAgent.name;
      }
    }

    const sessionId = `sess-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;
    const sessionDisplayName = input.sessionName || input.task || input.tmuxSessionName;
    const taskDescription = input.task || input.sessionName || `Adopted tmux session ${input.tmuxSessionName}`;
    const nowIso = new Date().toISOString();

    // 4. Save session context file
    const catalog = this.catalogManager.getState().catalog;
    const catalogHost = catalog?.hosts[input.serverId];

    const contextFile: SessionContextFile = {
      version: 1,
      sessionId,
      sessionName: sessionDisplayName,
      task: taskDescription,
      host: {
        id: input.serverId,
        name: catalogHost?.name || input.serverId,
        ssh: catalogHost?.ssh && !this.catalogSshIsCredentialBacked(catalogHost.ssh)
          ? {
              target: catalogHost.ssh.target,
              user: catalogHost.ssh.user,
              port: typeof catalogHost.ssh.port === 'number' ? catalogHost.ssh.port : undefined,
            }
          : undefined,
      },
      project: {
        id: finalProjectId,
        name: projectName,
        path: projectPath || '/tmp',
      },
      harness: {
        id: finalAgentId,
        name: harnessName,
        command: harnessCommand,
        args: [],
      },
      persistentSession: {
        type: 'tmux',
        name: input.tmuxSessionName,
        window: `${input.tmuxSessionName}:0`,
      },
      reconnectTarget: {
        type: 'tmux',
        name: input.tmuxSessionName,
        hostId: input.serverId,
      },
      status: 'working',
      creationSource: 'ui',
      isExternal: true,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    await this.contextStore.save(contextFile);

    // 5. Save in SQLite
    const savedSession = await this.repos.sessions.save({
      id: sessionId,
      name: sessionDisplayName,
      serverId: input.serverId,
      projectId: finalProjectId,
      agentId: finalAgentId,
      task: taskDescription,
      worktreePath: projectPath || '/tmp',
      branch: 'main',
      tmuxSessionName: input.tmuxSessionName,
      status: 'working',
      creationSource: 'ui',
      isExternal: true,
    });

    this.logger.info('External tmux session adopted successfully', { sessionId, tmuxSessionName: input.tmuxSessionName });
    return savedSession;
  }

  /**
   * Releases an adopted session non-destructively without terminating the running tmux session (FG-7.2.3).
   */
  async unadoptSession(sessionId: string): Promise<boolean> {
    this.logger.info('Releasing / un-adopting session (non-destructive)', { sessionId });
    this.attachedSessions.delete(sessionId);
    const ptyChannelId = `pty-${sessionId}`;
    this.ptyBroker.close(ptyChannelId);

    try {
      await this.contextStore.delete(sessionId);
    } catch (err) {
      this.logger.warn('Failed to delete context file during unadopt', { error: err });
    }

    try {
      await this.repos.sessions.delete(sessionId);
    } catch (err) {
      this.logger.warn('Failed to delete session from database during unadopt', { error: err });
    }

    this.logger.info('Session release (unadopt) completed - tmux process left alive', { sessionId });
    return true;
  }

  /**
   * Restores remembered Spawnea sessions on application startup (FG-2.3.2, FG-2.4.1).
   * 1. Reads all saved session context files from disk.
   * 2. Synchronizes any missing records into SQLite repository.
   * 3. Resets runtime active states ('working' / 'starting') to 'disconnected' since the app just launched and is not yet attached.
   * 4. Ensures no duplicate session identities.
   * 5. Performs initial reconciliation against target hosts.
   */
  async restoreSessions(): Promise<Session[]> {
    this.logger.info('Restoring remembered sessions on startup');

    // 1. Read context files from disk
    const contextFiles = await this.contextStore.list();
    const existingDbSessions = await this.repos.sessions.findAll();
    const dbSessionMap = new Map(existingDbSessions.map((s) => [s.id, s]));

    // 2. Reconcile context files into DB if missing
    for (const ctx of contextFiles) {
      if (!dbSessionMap.has(ctx.sessionId)) {
        const slug = ctx.task
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .substring(0, 30) || 'task';

        const restoredSession = await this.repos.sessions.save({
          id: ctx.sessionId,
          name: ctx.sessionName || ctx.task,
          serverId: ctx.host.id,
          projectId: ctx.project.id,
          agentId: ctx.harness.id,
          task: ctx.task,
          worktreePath: ctx.project.path,
          branch: ctx.worktree?.branch ?? `task/${slug}`,
          baseBranch: ctx.worktree?.baseBranch,
          baseCommit: ctx.worktree?.baseCommit,
          managedWorktree: ctx.worktree?.managed ?? false,
          tmuxSessionName: ctx.persistentSession.name,
          status: ctx.status === 'working' || ctx.status === 'starting' ? 'disconnected' : ctx.status,
          creationSource: ctx.creationSource ?? 'ui',
          isExternal: ctx.isExternal ?? false,
        });
        dbSessionMap.set(restoredSession.id, restoredSession);
      }
    }

    // 3. Reconcile live session statuses with target host reality
    return this.reconcileSessions();
  }

  /**
   * Reconciles all remembered sessions with remote host reality (FG-2.4.2 - FG-2.4.5).
   * - If host is reachable and tmux session exists: keeps/sets status as 'disconnected' (or 'working' if attached).
   * - If host is reachable and tmux session does not exist: marks status as 'done' (ended).
   * - If host is unreachable: preserves session context and status as 'disconnected' without marking as done.
   */
  async reconcileSessions(): Promise<Session[]> {
    this.logger.info('Reconciling remembered sessions with target host reality');
    const allSessions = await this.repos.sessions.findAll();
    const reconciled: Session[] = [];

    for (const session of allSessions) {
      const updated = await this.reconcileSession(session.id).catch((err) => {
        this.logger.warn('Failed to reconcile session, returning last known state', {
          sessionId: session.id,
          error: err,
        });
        return session;
      });
      reconciled.push(updated);
    }

    this.logger.info('Session reconciliation complete', { count: reconciled.length });
    return reconciled;
  }

  /**
   * Reconciles a single session with remote reality (FG-2.4.2, FG-2.4.3).
   */
  async reconcileSession(sessionId: string): Promise<Session> {
    const session = await this.repos.sessions.findById(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    let currentStatus = session.status;
    try {
      const host = await this.getHostAdapter(session.serverId);
      const exists = await this.tmuxManager.hasSession(host, session.tmuxSessionName);
      if (!exists) {
        if (session.status !== 'done') {
          this.logger.info('Marking concluded/missing tmux session as done', {
            sessionId: session.id,
            sessionName: session.tmuxSessionName,
          });
          await this.repos.sessions.updateStatus(session.id, 'done');
          await this.contextStore.updateStatus(session.id, 'done');
          currentStatus = 'done';
        }
      } else if (session.status === 'working' || session.status === 'starting') {
        this.logger.info('Resetting active session status to disconnected awaiting attach', {
          sessionId: session.id,
          previousStatus: session.status,
        });
        await this.repos.sessions.updateStatus(session.id, 'disconnected');
        await this.contextStore.updateStatus(session.id, 'disconnected');
        currentStatus = 'disconnected';
      }
    } catch (err) {
      // If host check fails (e.g. host unreachable), safely preserve disconnected state (FG-2.4.3)
      this.logger.warn('Host check failed during reconciliation, preserving session state', {
        sessionId: session.id,
        serverId: session.serverId,
        error: err,
      });
      if (session.status === 'working' || session.status === 'starting') {
        await this.repos.sessions.updateStatus(session.id, 'disconnected');
        await this.contextStore.updateStatus(session.id, 'disconnected');
        currentStatus = 'disconnected';
      }
    }

    return { ...session, status: currentStatus };
  }

  /**
   * Lists files for an active session's worktree path (FG-5.1).
   */
  async listFiles(sessionId: string, subPath?: string): Promise<FileEntry[]> {
    const session = await this.repos.sessions.findById(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    const host = await this.getHostAdapter(session.serverId);
    const worktreePath = await this.resolveSessionWorktreePath(session);
    try {
      const targetDir = subPath
        ? resolveContainedPath(worktreePath.value, subPath)
        : resolveContainedPath(worktreePath.value, worktreePath.value);

      return await host.listFiles(targetDir);
    } finally {
      worktreePath.release();
    }
  }

  /**
   * Reads a file for an active session's worktree path (FG-5.2).
   */
  async readFile(
    sessionId: string,
    relativePath: string,
    maxBytes?: number
  ): Promise<FileContentResult> {
    const session = await this.repos.sessions.findById(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    const host = await this.getHostAdapter(session.serverId);
    const worktreePath = await this.resolveSessionWorktreePath(session);
    try {
      const targetPath = resolveContainedPath(worktreePath.value, relativePath);

      return await host.readFile(targetPath, maxBytes);
    } finally {
      worktreePath.release();
    }
  }

  /**
   * Retrieves Git status for an active session's worktree path (FG-5.3).
   */
  async getGitStatus(sessionId: string): Promise<GitStatusResult> {
    const session = await this.repos.sessions.findById(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    const host = await this.getHostAdapter(session.serverId);
    const worktreePath = await this.resolveSessionWorktreePath(session);
    try {
      return await this.gitService.getGitStatus(host, worktreePath.value);
    } finally {
      worktreePath.release();
    }
  }

  /**
   * Retrieves Git diff for an active session's worktree path (FG-5.4).
   */
  async getGitDiff(sessionId: string, options?: GitDiffOptions): Promise<GitDiffResult> {
    const session = await this.repos.sessions.findById(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    const host = await this.getHostAdapter(session.serverId);
    const worktreePath = await this.resolveSessionWorktreePath(session);
    try {
      return await this.gitService.getGitDiff(host, worktreePath.value, options);
    } finally {
      worktreePath.release();
    }
  }

  /**
   * Releases resources on shutdown without terminating remote tmux sessions.
   */
  async dispose(): Promise<void> {
    this.logger.info('Disposing SessionManager: closing PTY streams, stopping health monitoring, and disconnecting host adapters');
    this.stopHostHealthMonitoring();
    this.ptyBroker.closeAll();
    for (const [serverId, host] of this.hostPool.entries()) {
      try {
        await host.disconnect();
      } catch (err) {
        this.logger.warn('Error disconnecting host adapter during dispose', { serverId, error: err });
      }
    }
    this.hostPool.clear();
  }
}
