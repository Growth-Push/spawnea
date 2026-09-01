import { app, BrowserWindow, ipcMain, shell, dialog, type WebContents } from 'electron';
import { join, resolve, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createDatabase, createRepositories, type Repositories } from '@spawnea/db';
import {
  createLogger,
  createFileLogHandler,
  DefaultLogger,
  createCatalogProjectPathLocator,
  isOnePasswordReference,
  maskSensitiveData,
  type CreateSessionInput,
  type Session,
  type LogLevel,
  type ArtifactDirection,
} from '@spawnea/domain';
import { CatalogManager } from './catalog-manager.js';
import { SessionContextStore } from './session-context-store.js';
import { PtyBroker } from './pty-broker.js';
import { SessionManager } from './session-manager.js';
import { SessionSupervisor } from './session-supervisor.js';
import { NotificationBroker } from './notification-broker.js';
import { ArtifactManager } from './artifact-manager.js';
import { LocalDiscoveryService } from './local-discovery-service.js';
import { AgentControlService } from './agent-control-service.js';
import { ControlMcpGateway } from './control-mcp-gateway.js';
import { isControlMcpEnabled } from './control-config.js';
import { initializeProcessPath } from './process-path.js';
import { resolveSpawneaUserDataPath } from './product-paths.js';
import {
  sanitizeCatalogResultForRenderer,
  sanitizeCatalogStateForRenderer,
} from './catalog-redaction.js';

initializeProcessPath();

const derivedLegacyUserDataPath = app.getPath('userData');
const smokeUserDataPath = process.env.SPAWNEA_SMOKE_TEST === '1' || process.argv.includes('--smoke-test')
  ? mkdtempSync(join(tmpdir(), 'spawnea-smoke-'))
  : undefined;
app.setName('spawnea');
app.setPath('userData', resolveSpawneaUserDataPath(
  app.getPath('appData'),
  derivedLegacyUserDataPath,
  process.env.SPAWNEA_USER_DATA_DIR || smokeUserDataPath,
));

// Polyfill global __filename and __dirname for native modules in ESM if needed
try {
  const metaUrl = import.meta.url;
  if (metaUrl) {
    const curFile = fileURLToPath(metaUrl);
    const curDir = dirname(curFile);
    if (typeof (globalThis as any).__filename === 'undefined') {
      (globalThis as any).__filename = curFile;
    }
    if (typeof (globalThis as any).__dirname === 'undefined') {
      (globalThis as any).__dirname = curDir;
    }
  }
} catch {
  // Ignore in CommonJS
}

const mainDir = dirname(fileURLToPath(import.meta.url));

process.on('unhandledRejection', (reason) => {
  console.error('[Spawnea Fatal Unhandled Rejection]:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Spawnea Fatal Uncaught Exception]:', err);
});

// Setup real-time file logging to log.txt at the workspace root
function resolveRootLogPath(): string {
  if (process.env.SPAWNEA_LOG_FILE) {
    return process.env.SPAWNEA_LOG_FILE;
  }
  if (process.cwd().endsWith('apps/desktop')) {
    return resolve(process.cwd(), '../../log.txt');
  }
  return resolve(process.cwd(), 'log.txt');
}

const logFilePath = resolveRootLogPath();
const fileLogHandler = createFileLogHandler(logFilePath, true);
const minLogLevel: LogLevel = (
  process.env.SPAWNEA_LOG_LEVEL || 'debug'
) as LogLevel;

const logger = createLogger('DesktopMain', {
  minLevel: minLogLevel,
  handlers: [DefaultLogger.defaultConsoleHandler, fileLogHandler],
});

let repositories: Repositories | null = null;
let dbConnection: ReturnType<typeof createDatabase> | null = null;
let catalogManager: CatalogManager | null = null;
let contextStore: SessionContextStore | null = null;
let ptyBroker: PtyBroker | null = null;
let sessionManager: SessionManager | null = null;
let artifactManager: ArtifactManager | null = null;
let sessionSupervisor: SessionSupervisor | null = null;
let notificationBroker: NotificationBroker | null = null;
let localDiscoveryService: LocalDiscoveryService | null = null;
let agentControlService: AgentControlService | null = null;
let controlMcpGateway: ControlMcpGateway | null = null;
let mainWindowRef: BrowserWindow | null = null;
let shutdownPromise: Promise<void> | null = null;
let terminationSignal: 'SIGINT' | 'SIGTERM' | null = null;

function getLiveWebContents(): WebContents | null {
  const window = mainWindowRef;
  if (!window || window.isDestroyed()) return null;
  try {
    const webContents = window.webContents;
    return webContents.isDestroyed() ? null : webContents;
  } catch {
    // Electron can destroy the window between the checks above and access to
    // its webContents while the application is shutting down.
    return null;
  }
}

async function shutdownApplication(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;

  // Stop delivering background updates before asynchronous cleanup begins.
  mainWindowRef = null;
  shutdownPromise = (async () => {
    if (controlMcpGateway) {
      await controlMcpGateway.close().catch((err) => {
        logger.error('Error closing Spawnea MCP control gateway', { error: err });
      });
      controlMcpGateway = null;
    }
    if (sessionSupervisor) {
      sessionSupervisor.stopPolling();
    }
    if (sessionManager) {
      try {
        await sessionManager.dispose();
      } catch (err) {
        logger.error('Error disposing session manager', { error: err });
      }
    }
    if (dbConnection) {
      try {
        dbConnection.close();
      } catch (err) {
        logger.error('Error closing database connection', { error: err });
      }
    }
  })();

  return shutdownPromise;
}

async function handleTerminationSignal(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  if (terminationSignal) return;
  terminationSignal = signal;
  logger.info('Received termination signal; cleaning up application resources', { signal });
  await shutdownApplication();
  app.exit(signal === 'SIGINT' ? 130 : 143);
}

// Best-effort graceful signal cleanup. The MCP gateway also starts a detached
// watchdog because Chromium may terminate before these async handlers complete.
process.on('SIGINT', () => {
  void handleTerminationSignal('SIGINT');
});

process.on('SIGTERM', () => {
  void handleTerminationSignal('SIGTERM');
});

async function seedInitialDataIfEmpty(repos: Repositories): Promise<void> {
  const existingServers = await repos.servers.findAll();
  if (existingServers.length === 0) {
    logger.info('Seeding initial server entity');
    await repos.servers.save({
      id: 'srv-local',
      name: 'Local Workstation',
      host: 'localhost',
      sshPort: 22,
      enabled: true,
    });
  }

  const existingAgents = await repos.agents.findAll();
  if (existingAgents.length === 0) {
    logger.info('Seeding standard agent entities');
    await repos.agents.save({
      id: 'agent-claude',
      name: 'Claude Code',
      harness: 'claude',
      command: 'claude',
    });
    await repos.agents.save({
      id: 'agent-codex',
      name: 'Codex CLI',
      harness: 'codex',
      command: 'codex',
    });
    await repos.agents.save({
      id: 'agent-shell',
      name: 'Interactive Shell',
      harness: 'shell',
      command: 'bash',
    });
  }
}

async function syncCatalogToRepositories(catalog: import('@spawnea/domain').OperationalCatalog, repos: Repositories): Promise<void> {
  const activeHostIds = new Set(Object.keys(catalog.hosts));
  const activeProjectIds = new Set<string>();
  const activeAgentIds = new Set<string>();

  for (const host of Object.values(catalog.hosts)) {
    const credentialBackedTarget = Boolean(host.ssh && isOnePasswordReference(host.ssh.target));
    const credentialBackedUser = Boolean(host.ssh?.user && isOnePasswordReference(host.ssh.user));
    const credentialBackedPort = Boolean(host.ssh && typeof host.ssh.port === 'string');
    await repos.servers.save({
      id: host.id,
      name: host.name,
      host: host.ssh ? (credentialBackedTarget ? 'credential-backed' : host.ssh.target) : 'localhost',
      sshUser: credentialBackedUser ? undefined : host.ssh?.user,
      sshPort: host.ssh && !credentialBackedPort && typeof host.ssh.port === 'number' ? host.ssh.port : 22,
      sshConfigAlias: credentialBackedTarget ? undefined : host.ssh?.target,
      enabled: host.enabled,
    });

    for (const proj of Object.values(host.projects)) {
      const projId = `${host.id}:${proj.id}`;
      activeProjectIds.add(projId);
      await repos.projects.save({
        id: projId,
        serverId: host.id,
        name: proj.name,
        rootPath: isOnePasswordReference(proj.path)
          ? createCatalogProjectPathLocator(host.id, proj.id)
          : proj.path,
        repoUrl: proj.git_url,
        baseBranch: proj.base_branch,
      });
    }

    for (const harness of Object.values(host.harnesses)) {
      const agentId = `${host.id}:${harness.id}`;
      activeAgentIds.add(agentId);
      await repos.agents.save({
        id: agentId,
        name: `${harness.name} (${host.name})`,
        harness: harness.command,
        command: harness.command,
        argsTemplate: harness.args,
      });
    }
  }

  // Remove stale servers, projects, and agents that no longer exist in the catalog
  // (unless referenced by saved sessions)
  const sessions = await repos.sessions.findAll();
  const referencedServerIds = new Set(sessions.map((s) => s.serverId));
  const referencedProjectIds = new Set(sessions.map((s) => s.projectId));
  const referencedAgentIds = new Set(sessions.map((s) => s.agentId));

  const existingProjects = await repos.projects.findAll();
  for (const p of existingProjects) {
    if (!activeProjectIds.has(p.id) && !referencedProjectIds.has(p.id)) {
      await repos.projects.delete(p.id);
    }
  }

  const existingAgents = await repos.agents.findAll();
  for (const a of existingAgents) {
    if (!activeAgentIds.has(a.id) && !referencedAgentIds.has(a.id)) {
      await repos.agents.delete(a.id);
    }
  }

  const existingServers = await repos.servers.findAll();
  for (const s of existingServers) {
    if (!activeHostIds.has(s.id) && !referencedServerIds.has(s.id)) {
      await repos.servers.delete(s.id);
    }
  }
}

function registerIpcHandlers(
  repos: Repositories,
  catManager: CatalogManager,
  sessManager: SessionManager,
  broker: PtyBroker,
  supervisor: SessionSupervisor,
  notifications: NotificationBroker,
  artManager: ArtifactManager,
  discoveryService: LocalDiscoveryService,
  controlService: AgentControlService
): void {
  // Operational Catalog Handlers
  ipcMain.handle('catalog:get', async () => sanitizeCatalogStateForRenderer(catManager.getState()));
  ipcMain.handle('catalog:reload', async () => {
    const result = catManager.reload();
    if (result.success && result.catalog) {
      await syncCatalogToRepositories(result.catalog, repos);
      sessManager.checkAllHostsHealth().catch((err) => {
        logger.warn('Failed to check host health on catalog reload', { error: err });
      });
    }
    return sanitizeCatalogResultForRenderer(result);
  });
  ipcMain.handle('catalog:addProject', async (_event, input: import('@spawnea/domain').AddProjectToCatalogInput) => {
    const result = await catManager.addProject(input);
    if (result.success && result.catalog) {
      await syncCatalogToRepositories(result.catalog, repos);
    }
    return sanitizeCatalogResultForRenderer(result);
  });
  ipcMain.handle('localDiscovery:scan', async () => discoveryService.scan());
  ipcMain.handle('localDiscovery:preview', async (_event, input: import('@spawnea/domain').LocalDiscoverySelection) => (
    maskSensitiveData(await discoveryService.preview(input))
  ));
  ipcMain.handle('localDiscovery:apply', async (_event, previewId: string) => {
    const result = await discoveryService.apply(previewId);
    if (result.success && result.catalog) {
      await syncCatalogToRepositories(result.catalog, repos);
    }
    return sanitizeCatalogResultForRenderer(result);
  });

  // Server & Host Handlers
  ipcMain.handle('servers:list', async () => repos.servers.findAll());
  ipcMain.handle('servers:save', async (_event, server) => repos.servers.save(server));
  ipcMain.handle('servers:delete', async (_event, id: string) => repos.servers.delete(id));
  ipcMain.handle('servers:test', async (_event, id: string) => sessManager.testHost(id));
  ipcMain.handle('hosts:getHealth', async (_event, id?: string) => {
    if (id) {
      const cached = sessManager.getCachedHostHealth(id);
      return cached ? { [id]: cached } : {};
    }
    return sessManager.getAllCachedHostHealth();
  });
  ipcMain.handle('hosts:checkHealth', async (_event, id?: string) => {
    if (id) {
      const res = await sessManager.checkHostHealth(id);
      return { [id]: res };
    }
    return sessManager.checkAllHostsHealth({ includeCredentialBacked: true });
  });
  ipcMain.handle('hosts:getSystemInfo', async (_event, id: string) => sessManager.getHostSystemInfo(id));
  ipcMain.handle('hosts:getConnectionState', async (_event, serverId: string) => sessManager.getHostConnectionState(serverId));
  ipcMain.handle('hosts:retryConnection', async (_event, serverId: string) => sessManager.retryHostConnection(serverId));
  ipcMain.handle('hosts:discoverExternalSessions', async (_event, serverId: string) =>
    sessManager.discoverExternalSessions(serverId)
  );

  // Project Handlers
  ipcMain.handle('projects:list', async (_event, serverId?: string) =>
    serverId ? repos.projects.findByServerId(serverId) : repos.projects.findAll()
  );
  ipcMain.handle('projects:save', async (_event, project) => repos.projects.save(project));
  ipcMain.handle('projects:delete', async (_event, id: string) => repos.projects.delete(id));
  ipcMain.handle(
    'projects:discoverBranches',
    async (_event, serverId: string, projectPath: string, preferredBranch?: string) =>
      sessManager.discoverProjectBranches(serverId, projectPath, preferredBranch)
  );
  ipcMain.handle('projects:choosePath', async (_event, serverId: string, currentPath?: string) => {
    const server = await repos.servers.findById(serverId);
    const isLocalHost = server?.host === 'localhost' || server?.host === '127.0.0.1';
    if (!server || !isLocalHost) {
      return {
        canceled: false,
        error: 'Folder selection is available for local hosts only. Enter the remote path manually.',
      };
    }

    const result = await dialog.showOpenDialog(mainWindowRef!, {
      title: `Select project folder on ${server.name}`,
      defaultPath: currentPath?.trim() || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled
      ? { canceled: true }
      : { canceled: false, path: result.filePaths[0] };
  });

  // Agent Handlers
  ipcMain.handle('agents:list', async () => repos.agents.findAll());
  ipcMain.handle('agents:save', async (_event, agent) => repos.agents.save(agent));
  ipcMain.handle('agents:delete', async (_event, id: string) => repos.agents.delete(id));

  ipcMain.handle('shell:openConfig', async () => {
    const configPath = catManager.getCatalogPath();
    if (!existsSync(configPath)) {
      return { success: false, error: `Configuration file not found: ${configPath}` };
    }
    const error = await shell.openPath(configPath);
    return error ? { success: false, error: `Could not open configuration file: ${error}` } : { success: true };
  });

  // Session Lifecycle & Status Supervision
  ipcMain.handle('sessions:list', async () => repos.sessions.findAll());
  ipcMain.handle('sessions:reconcile', async () => sessManager.reconcileSessions());
  ipcMain.handle('sessions:checkStatus', async (_event, sessionId: string) => supervisor.checkSession(sessionId));
  ipcMain.handle('sessions:checkAllStatuses', async () => supervisor.checkAllSessions());
  ipcMain.handle('session:getStateSnapshot', async (_event, sessionId: string) => supervisor.captureFeedbackSnapshot(sessionId));
  ipcMain.handle('session:submitStateFeedback', async (_event, report: import('@spawnea/domain').StateFeedbackReport) => supervisor.saveFeedbackReport(report));
  ipcMain.on('session:setActive', (_event, sessionId: string | null) => {
    notifications.setActiveSessionId(sessionId);
  });
  ipcMain.on('control:setUiState', (_event, state: import('@spawnea/domain').ControlUiState) => {
    controlService.setUiState(state);
  });
  ipcMain.handle('control:listFinalizationRequests', async (_event, includeResolved?: boolean) =>
    controlService.listFinalizationRequests(includeResolved)
  );
  ipcMain.handle('control:resolveFinalizationRequest', async (
    _event,
    requestId: string,
    decision: 'approve' | 'reject'
  ) => controlService.resolveFinalizationRequest(requestId, decision));

  ipcMain.handle('sessions:create', async (_event, input: CreateSessionInput): Promise<Session> => {
    return sessManager.createSession(input);
  });

  ipcMain.handle('sessions:rename', async (_event, sessionId: string, name: string): Promise<Session> => {
    return sessManager.renameSession(sessionId, name);
  });

  ipcMain.handle('sessions:adopt', async (_event, input: import('@spawnea/domain').AdoptSessionInput): Promise<Session> => {
    return sessManager.adoptSession(input);
  });

  ipcMain.handle('sessions:unadopt', async (_event, sessionId: string): Promise<boolean> => {
    return sessManager.unadoptSession(sessionId);
  });

  ipcMain.handle('sessions:attach', async (event, sessionId: string, cols?: number, rows?: number) => {
    return sessManager.attachSession(sessionId, event.sender, cols, rows);
  });

  ipcMain.handle('sessions:detach', async (_event, sessionId: string) => {
    await sessManager.detachSession(sessionId);
  });

  ipcMain.handle('sessions:stop', async (_event, sessionId: string) => {
    await sessManager.stopSession(sessionId);
  });

  ipcMain.handle('sessions:finish', async (
    _event,
    sessionId: string,
    action: import('@spawnea/domain').FinishSessionAction,
    options?: import('@spawnea/domain').FinishSessionOptions
  ) => {
    return sessManager.finishSession(sessionId, action, options);
  });

  ipcMain.handle('sessions:inspectWorktree', async (_event, sessionId: string) => {
    return sessManager.inspectManagedWorktree(sessionId);
  });

  ipcMain.handle('sessions:delete', async (_event, sessionId: string) => {
    return sessManager.deleteSession(sessionId);
  });

  ipcMain.handle('shell:openExternalUrl', async (_event, rawUrl: string) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error('Only valid HTTP(S) URLs can be opened externally');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Only HTTP(S) URLs can be opened externally');
    }
    await shell.openExternal(url.toString());
    return true;
  });

  // PTY Streaming Events
  ipcMain.on('pty:write', (_event, channelId: string, data: string) => {
    broker.write(channelId, data);
  });

  ipcMain.on('pty:resize', (_event, channelId: string, cols: number, rows: number) => {
    broker.resize(channelId, cols, rows);
  });

  // Session Context Data Handlers (Files & Git)
  ipcMain.handle('session:getFiles', async (_event, sessionId: string, subPath?: string) => {
    return sessManager.listFiles(sessionId, subPath);
  });

  ipcMain.handle('session:listFiles', async (_event, sessionId: string, subPath?: string) => {
    return sessManager.listFiles(sessionId, subPath);
  });

  ipcMain.handle(
    'session:readFile',
    async (_event, sessionId: string, relativePath: string, maxBytes?: number) => {
      return sessManager.readFile(sessionId, relativePath, maxBytes);
    }
  );

  ipcMain.handle('session:getDiff', async (_event, sessionId: string) => {
    const res = await sessManager.getGitDiff(sessionId);
    return res.rawDiff;
  });

  ipcMain.handle('session:getGitStatus', async (_event, sessionId: string) => {
    return sessManager.getGitStatus(sessionId);
  });

  ipcMain.handle(
    'session:getGitDiff',
    async (_event, sessionId: string, options?: import('@spawnea/domain').GitDiffOptions) => {
      return sessManager.getGitDiff(sessionId, options);
    }
  );

  // Session Artifacts Handlers (Pilot 4)
  ipcMain.handle('session:getArtifacts', async (_event, sessionId: string) => {
    try {
      return await repos.artifacts.findBySessionId(sessionId);
    } catch (err) {
      logger.error('Failed to list session artifacts', err, { sessionId });
      return [];
    }
  });

  ipcMain.handle(
    'session:uploadArtifactFile',
    async (
      event,
      sessionId: string,
      localFilePath: string,
      direction?: ArtifactDirection,
      customFilename?: string
    ) => {
      try {
        logger.info('Handling session:uploadArtifactFile', { sessionId, localFilePath, direction, customFilename });
        const created = await artManager.uploadArtifactFile(sessionId, localFilePath, direction, customFilename);
        const win = BrowserWindow.fromWebContents(event.sender) || mainWindowRef;
        if (win && !win.isDestroyed()) {
          win.webContents.send('session:artifactCreated', sessionId, created);
        }
        return created;
      } catch (err) {
        logger.error('Failed to handle session:uploadArtifactFile', err, { sessionId, localFilePath });
        throw err;
      }
    }
  );

  ipcMain.handle(
    'session:uploadArtifactData',
    async (
      event,
      sessionId: string,
      buffer: Uint8Array,
      filename: string,
      mimeType: string,
      direction?: ArtifactDirection
    ) => {
      try {
        logger.info('Handling session:uploadArtifactData', {
          sessionId,
          filename,
          mimeType,
          direction,
          sizeBytes: buffer ? (buffer.byteLength || buffer.length) : 0,
        });

        let buf: Buffer;
        if (Buffer.isBuffer(buffer)) {
          buf = buffer;
        } else if (buffer instanceof Uint8Array) {
          buf = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        } else if (buffer && typeof (buffer as any) === 'object') {
          // In case structured clone passed object
          buf = Buffer.from(buffer as any);
        } else {
          buf = Buffer.from([]);
        }

        const created = await artManager.uploadArtifactBuffer(sessionId, buf, filename, mimeType, direction);
        const win = BrowserWindow.fromWebContents(event.sender) || mainWindowRef;
        if (win && !win.isDestroyed()) {
          win.webContents.send('session:artifactCreated', sessionId, created);
        }
        return created;
      } catch (err) {
        logger.error('Failed to handle session:uploadArtifactData', err, { sessionId, filename });
        throw err;
      }
    }
  );

  ipcMain.handle('session:promoteToArtifact', async (event, sessionId: string, filePath: string) => {
    try {
      logger.info('Handling session:promoteToArtifact', { sessionId, filePath });
      const created = await artManager.promoteFile(sessionId, filePath);
      const win = BrowserWindow.fromWebContents(event.sender) || mainWindowRef;
      if (win && !win.isDestroyed()) {
        win.webContents.send('session:artifactCreated', sessionId, created);
      }
      return created;
    } catch (err) {
      logger.error('Failed to handle session:promoteToArtifact', err, { sessionId, filePath });
      throw err;
    }
  });

  ipcMain.handle(
    'session:getArtifactContent',
    async (_event, sessionId: string, artifactId: string, maxBytes?: number) => {
      try {
        return await artManager.getArtifactContent(sessionId, artifactId, maxBytes);
      } catch (err) {
        logger.error('Failed to handle session:getArtifactContent', err, { sessionId, artifactId });
        throw err;
      }
    }
  );

  ipcMain.handle('session:deleteArtifact', async (_event, sessionId: string, artifactId: string) => {
    try {
      logger.info('Handling session:deleteArtifact', { sessionId, artifactId });
      return await artManager.deleteArtifact(sessionId, artifactId);
    } catch (err) {
      logger.error('Failed to handle session:deleteArtifact', err, { sessionId, artifactId });
      throw err;
    }
  });

  ipcMain.handle('session:saveArtifactAs', async (event, sessionId: string, artifactId: string) => {
    try {
      const artifact = await repos.artifacts.findById(artifactId);
      if (!artifact) throw new Error(`Artifact '${artifactId}' not found`);
      const win = BrowserWindow.fromWebContents(event.sender);
      const { canceled, filePath } = await dialog.showSaveDialog(win || mainWindowRef!, {
        defaultPath: artifact.filename,
      });
      if (canceled || !filePath) return false;
      const contentRes = await artManager.getArtifactContent(sessionId, artifactId);
      const fs = await import('node:fs/promises');
      if (contentRes.isBinary) {
        const raw = contentRes.content.includes('base64,')
          ? contentRes.content.split('base64,')[1]
          : contentRes.content;
        await fs.writeFile(filePath, Buffer.from(raw, 'base64'));
      } else {
        await fs.writeFile(filePath, contentRes.content, 'utf8');
      }
      return true;
    } catch (err) {
      logger.error('Failed to handle session:saveArtifactAs', err, { sessionId, artifactId });
      throw err;
    }
  });

  ipcMain.handle('session:openArtifactInOs', async (_event, sessionId: string, artifactId: string) => {
    try {
      const artifact = await repos.artifacts.findById(artifactId);
      if (!artifact) return false;
      if (!artifact.cachedLocalPath || !existsSync(artifact.cachedLocalPath)) {
        await artManager.getArtifactContent(sessionId, artifactId);
      }
      const updated = await repos.artifacts.findById(artifactId);
      if (updated?.cachedLocalPath && existsSync(updated.cachedLocalPath)) {
        await shell.openPath(updated.cachedLocalPath);
        return true;
      }
      return false;
    } catch (err) {
      logger.error('Failed to handle session:openArtifactInOs', err, { sessionId, artifactId });
      throw err;
    }
  });

  // Terminal Snippet & Text Artifact Handlers
  ipcMain.handle('terminal:openSnippetInEditor', async (_event, text: string) => {
    try {
      const snippetsDir = join(homedir(), '.config', 'spawnea', 'snippets');
      await mkdir(snippetsDir, { recursive: true });
      const snippetPath = join(snippetsDir, `snippet-${Date.now()}.txt`);
      await writeFile(snippetPath, text, 'utf8');
      const err = await shell.openPath(snippetPath);
      if (err) {
        logger.warn('Failed to open snippet in default editor', { error: err });
        return false;
      }
      return true;
    } catch (err) {
      logger.error('Failed to handle terminal:openSnippetInEditor', err);
      return false;
    }
  });

  ipcMain.handle(
    'session:createArtifactFromText',
    async (event, sessionId: string, filename: string, content: string) => {
      try {
        const created = await artManager.createTextArtifact(sessionId, filename, content);
        const win = BrowserWindow.fromWebContents(event.sender) || mainWindowRef;
        if (win && !win.isDestroyed()) {
          win.webContents.send('session:artifactCreated', sessionId, created);
        }
        return created;
      } catch (err) {
        logger.error('Failed to create artifact from text', err, { sessionId, filename });
        throw err;
      }
    }
  );

  ipcMain.handle('artifacts:getBlacklist', async () => {
    try {
      return await artManager.getBlacklist();
    } catch (err) {
      logger.error('Failed to get artifact blacklist', err);
      return [];
    }
  });

  ipcMain.handle('artifacts:addToBlacklist', async (_event, pattern: string) => {
    try {
      logger.info('Handling artifacts:addToBlacklist', { pattern });
      return await artManager.addToBlacklist(pattern);
    } catch (err) {
      logger.error('Failed to add to artifact blacklist', err, { pattern });
      throw err;
    }
  });

  ipcMain.handle('artifacts:removeFromBlacklist', async (_event, pattern: string) => {
    try {
      logger.info('Handling artifacts:removeFromBlacklist', { pattern });
      return await artManager.removeFromBlacklist(pattern);
    } catch (err) {
      logger.error('Failed to remove from artifact blacklist', err, { pattern });
      throw err;
    }
  });
}



function getPreloadPath(): string {
  const candidates = [
    join(mainDir, '../preload/index.mjs'),
    join(mainDir, '../preload/index.js'),
    join(mainDir, '../preload/index.cjs'),
    resolve(process.cwd(), 'apps/desktop/out/preload/index.mjs'),
    resolve(process.cwd(), 'apps/desktop/out/preload/index.js'),
    resolve(process.cwd(), 'out/preload/index.mjs'),
    resolve(process.cwd(), 'out/preload/index.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      logger.info('Preload script resolved at path', { path: candidate });
      return candidate;
    }
  }
  logger.warn('Preload candidate not found on disk, using default fallback', { path: candidates[0] });
  return candidates[0];
}

function createWindow(): void {
  const preloadPath = getPreloadPath();
  const mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1024,
    minHeight: 640,
    show: true,
    autoHideMenuBar: true,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Spawnea has its own renderer UI; prevent Electron's hidden menu from reappearing on Alt.
  mainWindow.setMenu(null);

  mainWindowRef = mainWindow;
  mainWindow.once('closed', () => {
    if (mainWindowRef === mainWindow) mainWindowRef = null;
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('http://localhost') || details.url.startsWith('http://127.0.0.1')) {
      return { action: 'allow' };
    }
    if (details.url.startsWith('https://') || details.url.startsWith('http://')) {
      shell.openExternal(details.url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });



  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logger.error('Renderer failed to load', { errorCode, errorDescription, validatedURL });
  });

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    logger.error('Preload script failed to load', {
      preloadPath,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      logger.warn('Renderer console message', { level, message, line, sourceId });
    }
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error('Renderer process gone', { reason: details.reason, exitCode: details.exitCode });
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(mainDir, '../renderer/index.html'));
  }

  mainWindow.show();
  mainWindow.focus();
}


app.whenReady().then(async () => {
  try {
    const dbPath = join(app.getPath('userData'), 'spawnea.sqlite');
    logger.info('Initializing SQLite database at path', { dbPath });
    dbConnection = createDatabase({ path: dbPath, migrate: true });
    repositories = createRepositories(dbConnection.db, { logger });

    catalogManager = new CatalogManager({
      catalogPath: join(app.getPath('userData'), 'config.yaml'),
      logger,
    });
    const catalogState = catalogManager.load();
    localDiscoveryService = new LocalDiscoveryService(catalogManager, logger.child('local-discovery'));
    if (catalogState.catalog) {
      const flat = catalogManager.getFlatLists();
      logger.info('Operational catalog loaded at startup', {
        filePath: catalogState.filePath,
        hostsCount: Object.keys(catalogState.catalog.hosts).length,
        projectsCount: flat.projects.length,
        harnessesCount: flat.agents.length,
      });

      console.log(
        `\n[Spawnea] Loaded operational config: ${catalogState.filePath}\n` +
        `           - Hosts: ${Object.keys(catalogState.catalog.hosts).length}\n` +
        `           - Projects: ${flat.projects.length}\n` +
        `           - Harnesses: ${flat.agents.length}\n`
      );

      await syncCatalogToRepositories(catalogState.catalog, repositories);
    } else {
      logger.warn('No valid operational catalog found on startup, using fallback', {
        filePath: catalogState.filePath,
        errors: catalogState.errors,
      });
      console.warn(`\n[Spawnea] Warning: operational config at ${catalogState.filePath} not found or invalid.\n`);
      await seedInitialDataIfEmpty(repositories);
    }

    const sessionsDir = join(app.getPath('userData'), 'sessions');
    contextStore = new SessionContextStore({ storeDir: sessionsDir, logger });
    ptyBroker = new PtyBroker(logger.child('pty'));
    sessionManager = new SessionManager({
      repositories,
      catalogManager,
      contextStore,
      ptyBroker,
      logger,
    });
    agentControlService = new AgentControlService({
      repositories,
      sessionManager,
      logger: logger.child('control'),
      notifyNavigate: (state) => {
        if (!mainWindowRef || mainWindowRef.isDestroyed()) return false;
        mainWindowRef.webContents.send('control:navigate', state);
        return true;
      },
      notifyFinalizationRequested: (request) => {
        if (!mainWindowRef || mainWindowRef.isDestroyed()) return false;
        mainWindowRef.webContents.send('control:finalizationRequested', request);
        return true;
      },
      notifyDataChanged: () => {
        if (!mainWindowRef || mainWindowRef.isDestroyed()) return false;
        mainWindowRef.webContents.send('control:dataChanged');
        return true;
      },
    });

    const artifactsCacheDir = join(app.getPath('userData'), 'artifacts');
    artifactManager = new ArtifactManager({
      repositories,
      sessionManager,
      cacheDir: artifactsCacheDir,
      logger: logger.child('artifacts'),
    });

    notificationBroker = new NotificationBroker({
      repositories,
      logger: logger.child('notifications'),
    });

    const statusCheckIntervalMs = (() => {
      const intervalMs = process.env.SPAWNEA_CHECK_INTERVAL_MS;
      if (intervalMs) {
        const ms = parseInt(intervalMs, 10);
        if (!isNaN(ms) && ms > 0) return ms;
      }
      const intervalSeconds = process.env.SPAWNEA_CHECK_INTERVAL_SECONDS
        || process.env.SPAWNEA_CHECK_INTERVAL
        || process.env.SPAWNEA_CHECK_INTERVAL_SECONDS
        || process.env.SPAWNEA_CHECK_INTERVAL;
      if (intervalSeconds) {
        const sec = parseInt(
          intervalSeconds,
          10
        );
        if (!isNaN(sec) && sec > 0) return sec * 1000;
      }
      return 10000; // 10s default
    })();

    sessionSupervisor = new SessionSupervisor({
      repositories,
      sessionManager,
      contextStore,
      ptyBroker,
      artifactManager,
      logger: logger.child('supervisor'),
      pollIntervalMs: statusCheckIntervalMs,
    });

    sessionSupervisor.setWebContentsGetter(getLiveWebContents);
    sessionManager.setWebContentsGetter(getLiveWebContents);
    sessionSupervisor.onStatusChange(async (sessionId, result) => {
      if (notificationBroker) {
        await notificationBroker.notifyStatusAlert(sessionId, result);
      }
    });

    const restoredSessions = await sessionManager.restoreSessions();
    logger.info('Restored active sessions on startup', { count: restoredSessions.length });

    registerIpcHandlers(
      repositories,
      catalogManager,
      sessionManager,
      ptyBroker,
      sessionSupervisor,
      notificationBroker,
      artifactManager,
      localDiscoveryService,
      agentControlService
    );

    // Start background supervision polling (configurable via SPAWNEA_CHECK_INTERVAL_MS / SPAWNEA_CHECK_INTERVAL_SECONDS, default 10s)
    sessionSupervisor.startPolling(statusCheckIntervalMs);
    // Start background parallel host health monitoring (default 30s)
    sessionManager.startHostHealthMonitoring();

    if (process.env.SPAWNEA_SMOKE_TEST === '1' || process.argv.includes('--smoke-test')) {
      console.log('[Spawnea Smoke Test] Bootstrap and service initialization verified successfully.');
      logger.info('Smoke test completed successfully, exiting process');
      setTimeout(async () => {
        await shutdownApplication();
        app.exit(0);
      }, 200);
      return;
    }

    createWindow();
    if (isControlMcpEnabled()) {
      controlMcpGateway = new ControlMcpGateway({
        control: agentControlService,
        logger: logger.child('control-mcp'),
      });
      await controlMcpGateway.start();
    } else {
      logger.info('Spawnea MCP control gateway is disabled by SPAWNEA_CONTROL_ENABLED');
    }
  } catch (error) {
    console.error('[Spawnea Bootstrap Error]:', error);
    logger.error('Failed to initialize main process application services', { error });
    if (process.env.SPAWNEA_SMOKE_TEST === '1' || process.argv.includes('--smoke-test')) {
      process.exit(1);
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  await shutdownApplication();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
