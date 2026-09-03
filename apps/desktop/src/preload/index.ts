import { contextBridge, ipcRenderer } from 'electron';
import type {
  Server,
  Project,
  Agent,
  Session,
  Artifact,
  FileEntry,
  SessionStatus,
  CreateSessionInput,
  AdoptSessionInput,
  DiscoveredTmuxSession,
  CatalogState,
  CatalogReloadResult,
  AddProjectToCatalogInput,
  HostTestResult,
  HostHealthResult,

  HostSystemInfo,
  HostConnectionState,
  HostConnectionEndpoint,

  GitBranchDiscoveryResult,
  StateFeedbackSnapshot,
  StateFeedbackReport,
  StateFeedbackResult,
  FinishSessionAction,
  FinishSessionOptions,
  FinishSessionResult,
  ManagedWorktreeInspection,
  CreateChildSessionInput,
  ParentCloseAction,
  LocalDiscoveryScanResult,
  LocalDiscoverySelection,
  LocalDiscoveryPreviewResult,
  LocalDiscoveryApplyResult,
  ControlUiState,
  ControlNavigateEvent,
  ControlFinalizationRequest,
} from '@spawnea/domain';

export const api = {
  // Operational Catalog
  getCatalog: (): Promise<CatalogState> => ipcRenderer.invoke('catalog:get'),
  reloadCatalog: (): Promise<CatalogReloadResult> => ipcRenderer.invoke('catalog:reload'),
  addProjectToCatalog: (input: AddProjectToCatalogInput): Promise<CatalogReloadResult> =>
    ipcRenderer.invoke('catalog:addProject', input),
  scanLocalSetup: (): Promise<LocalDiscoveryScanResult> => ipcRenderer.invoke('localDiscovery:scan'),
  previewLocalDiscovery: (input: LocalDiscoverySelection): Promise<LocalDiscoveryPreviewResult> =>
    ipcRenderer.invoke('localDiscovery:preview', input),
  applyLocalDiscovery: (previewId: string): Promise<LocalDiscoveryApplyResult> =>
    ipcRenderer.invoke('localDiscovery:apply', previewId),

  // Server & Host Management
  listServers: (): Promise<Server[]> => ipcRenderer.invoke('servers:list'),
  saveServer: (server: Omit<Server, 'createdAt'>): Promise<Server> => ipcRenderer.invoke('servers:save', server),
  deleteServer: (id: string): Promise<void> => ipcRenderer.invoke('servers:delete', id),
  testServer: (id: string): Promise<HostTestResult> => ipcRenderer.invoke('servers:test', id),
  getHostHealth: (id?: string): Promise<Record<string, HostHealthResult>> => ipcRenderer.invoke('hosts:getHealth', id),
  checkHostHealth: (id?: string): Promise<Record<string, HostHealthResult>> => ipcRenderer.invoke('hosts:checkHealth', id),
  getHostSystemInfo: (id: string): Promise<HostSystemInfo | null> => ipcRenderer.invoke('hosts:getSystemInfo', id),
  getHostConnectionState: (id: string): Promise<HostConnectionState> => ipcRenderer.invoke('hosts:getConnectionState', id),
  getHostConnectionEndpoint: (id: string): Promise<HostConnectionEndpoint | null> =>
    ipcRenderer.invoke('hosts:getConnectionEndpoint', id),
  retryHostConnection: (id: string): Promise<HostConnectionState> => ipcRenderer.invoke('hosts:retryConnection', id),
  discoverExternalSessions: (serverId: string): Promise<DiscoveredTmuxSession[]> =>
    ipcRenderer.invoke('hosts:discoverExternalSessions', serverId),

  // Project Management
  listProjects: (serverId?: string): Promise<Project[]> => ipcRenderer.invoke('projects:list', serverId),
  saveProject: (project: Omit<Project, 'createdAt'>): Promise<Project> => ipcRenderer.invoke('projects:save', project),
  deleteProject: (id: string): Promise<void> => ipcRenderer.invoke('projects:delete', id),
  discoverProjectBranches: (
    serverId: string,
    projectPath: string,
    preferredBranch?: string
  ): Promise<GitBranchDiscoveryResult> => ipcRenderer.invoke('projects:discoverBranches', serverId, projectPath, preferredBranch),
  chooseProjectPath: (serverId: string, currentPath?: string): Promise<{ path?: string; canceled: boolean; error?: string }> =>
    ipcRenderer.invoke('projects:choosePath', serverId, currentPath),

  // Agent Launch Configs
  listAgents: (): Promise<Agent[]> => ipcRenderer.invoke('agents:list'),
  saveAgent: (agent: Omit<Agent, 'createdAt'>): Promise<Agent> => ipcRenderer.invoke('agents:save', agent),
  deleteAgent: (id: string): Promise<void> => ipcRenderer.invoke('agents:delete', id),

  // Session Lifecycle
  listSessions: (): Promise<Session[]> => ipcRenderer.invoke('sessions:list'),
  reconcileSessions: (): Promise<Session[]> => ipcRenderer.invoke('sessions:reconcile'),
  createSession: (input: CreateSessionInput): Promise<Session> => ipcRenderer.invoke('sessions:create', input),
  createChildSession: (input: CreateChildSessionInput): Promise<Session> =>
    ipcRenderer.invoke('sessions:createChild', input),
  renameSession: (sessionId: string, name: string): Promise<Session> =>
    ipcRenderer.invoke('sessions:rename', sessionId, name),
  adoptSession: (input: AdoptSessionInput): Promise<Session> => ipcRenderer.invoke('sessions:adopt', input),
  unadoptSession: (sessionId: string): Promise<boolean> => ipcRenderer.invoke('sessions:unadopt', sessionId),
  attachSession: (sessionId: string, cols?: number, rows?: number): Promise<{ ptyChannelId: string }> =>
    ipcRenderer.invoke('sessions:attach', sessionId, cols, rows),
  detachSession: (sessionId: string): Promise<void> => ipcRenderer.invoke('sessions:detach', sessionId),
  stopSession: (sessionId: string): Promise<void> => ipcRenderer.invoke('sessions:stop', sessionId),
  finishSession: (
    sessionId: string,
    action: FinishSessionAction,
    options?: FinishSessionOptions
  ): Promise<FinishSessionResult> => ipcRenderer.invoke('sessions:finish', sessionId, action, options),
  inspectWorktree: (sessionId: string): Promise<ManagedWorktreeInspection> =>
    ipcRenderer.invoke('sessions:inspectWorktree', sessionId),
  deleteSession: (sessionId: string, childAction?: ParentCloseAction): Promise<boolean> =>
    ipcRenderer.invoke('sessions:delete', sessionId, childAction),
  sendPrompt: (sessionId: string, prompt: string): Promise<{ delivered: boolean; deliveryMethod: 'pty' | 'tmux' }> =>
    ipcRenderer.invoke('sessions:sendPrompt', sessionId, prompt),

  // Explicit local MCP control. The bridge never exposes an approval method to
  // MCP; only this trusted renderer preload can resolve pending requests.
  syncControlUiState: (state: ControlUiState): void => {
    ipcRenderer.send('control:setUiState', state);
  },
  listControlFinalizationRequests: (includeResolved = false): Promise<ControlFinalizationRequest[]> =>
    ipcRenderer.invoke('control:listFinalizationRequests', includeResolved),
  resolveControlFinalizationRequest: (
    requestId: string,
    decision: 'approve' | 'reject'
  ): Promise<ControlFinalizationRequest> =>
    ipcRenderer.invoke('control:resolveFinalizationRequest', requestId, decision),
  onControlNavigate: (callback: (state: ControlNavigateEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ControlNavigateEvent) => callback(state);
    ipcRenderer.on('control:navigate', handler);
    return () => ipcRenderer.removeListener('control:navigate', handler);
  },
  onControlFinalizationRequested: (
    callback: (request: ControlFinalizationRequest) => void
  ): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, request: ControlFinalizationRequest) => callback(request);
    ipcRenderer.on('control:finalizationRequested', handler);
    return () => ipcRenderer.removeListener('control:finalizationRequested', handler);
  },
  onControlDataChanged: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('control:dataChanged', handler);
    return () => ipcRenderer.removeListener('control:dataChanged', handler);
  },

  openExternalUrl: (url: string): Promise<boolean> => ipcRenderer.invoke('shell:openExternalUrl', url),
  openConfig: (): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('shell:openConfig'),
  writeClipboardText: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:writeText', text),

  // Session Context Data (Files & Git)
  getFiles: (sessionId: string, subPath?: string): Promise<FileEntry[]> =>
    ipcRenderer.invoke('session:listFiles', sessionId, subPath),
  listFiles: (sessionId: string, subPath?: string): Promise<FileEntry[]> =>
    ipcRenderer.invoke('session:listFiles', sessionId, subPath),
  readFile: (
    sessionId: string,
    relativePath: string,
    maxBytes?: number
  ): Promise<import('@spawnea/domain').FileContentResult> =>
    ipcRenderer.invoke('session:readFile', sessionId, relativePath, maxBytes),
  getDiff: (sessionId: string): Promise<string> => ipcRenderer.invoke('session:getDiff', sessionId),
  getGitStatus: (sessionId: string): Promise<import('@spawnea/domain').GitStatusResult> =>
    ipcRenderer.invoke('session:getGitStatus', sessionId),
  getGitDiff: (
    sessionId: string,
    options?: import('@spawnea/domain').GitDiffOptions
  ): Promise<import('@spawnea/domain').GitDiffResult> =>
    ipcRenderer.invoke('session:getGitDiff', sessionId, options),
  getArtifacts: (sessionId: string): Promise<Artifact[]> =>
    ipcRenderer.invoke('session:getArtifacts', sessionId),
  uploadArtifact: (sessionId: string, localFilePath: string): Promise<Artifact> =>
    ipcRenderer.invoke('session:uploadArtifactFile', sessionId, localFilePath),
  uploadArtifactFile: (
    sessionId: string,
    localFilePath: string,
    direction?: import('@spawnea/domain').ArtifactDirection,
    customFilename?: string
  ): Promise<Artifact> =>
    ipcRenderer.invoke('session:uploadArtifactFile', sessionId, localFilePath, direction, customFilename),
  uploadArtifactData: (
    sessionId: string,
    buffer: Uint8Array,
    filename: string,
    mimeType: string,
    direction?: import('@spawnea/domain').ArtifactDirection
  ): Promise<Artifact> =>
    ipcRenderer.invoke('session:uploadArtifactData', sessionId, buffer, filename, mimeType, direction),
  pasteImage: (sessionId: string, imageBuffer: Uint8Array): Promise<Artifact> =>
    ipcRenderer.invoke('session:uploadArtifactData', sessionId, imageBuffer, `screenshot-${Date.now()}.png`, 'image/png', 'input'),
  promoteToArtifact: (sessionId: string, filePath: string): Promise<Artifact> =>
    ipcRenderer.invoke('session:promoteToArtifact', sessionId, filePath),
  getArtifactContent: (
    sessionId: string,
    artifactId: string,
    maxBytes?: number
  ): Promise<import('@spawnea/domain').FileContentResult> =>
    ipcRenderer.invoke('session:getArtifactContent', sessionId, artifactId, maxBytes),
  deleteArtifact: (sessionId: string, artifactId: string): Promise<boolean> =>
    ipcRenderer.invoke('session:deleteArtifact', sessionId, artifactId),
  clearArtifacts: (sessionId: string): Promise<number> =>
    ipcRenderer.invoke('session:clearArtifacts', sessionId),
  saveArtifactAs: (sessionId: string, artifactId: string): Promise<boolean> =>
    ipcRenderer.invoke('session:saveArtifactAs', sessionId, artifactId),
  openArtifactInOs: (sessionId: string, artifactId: string): Promise<boolean> =>
    ipcRenderer.invoke('session:openArtifactInOs', sessionId, artifactId),
  openSnippetInEditor: (text: string): Promise<boolean> =>
    ipcRenderer.invoke('terminal:openSnippetInEditor', text),
  createArtifactFromText: (
    sessionId: string,
    filename: string,
    content: string
  ): Promise<Artifact> =>
    ipcRenderer.invoke('session:createArtifactFromText', sessionId, filename, content),
  getArtifactBlacklist: (): Promise<string[]> =>
    ipcRenderer.invoke('artifacts:getBlacklist'),
  addArtifactToBlacklist: (pattern: string): Promise<string[]> =>
    ipcRenderer.invoke('artifacts:addToBlacklist', pattern),
  removeArtifactFromBlacklist: (pattern: string): Promise<string[]> =>
    ipcRenderer.invoke('artifacts:removeFromBlacklist', pattern),
  onArtifactCreated: (callback: (sessionId: string, artifact: Artifact) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sId: string, art: Artifact) => {
      callback(sId, art);
    };
    ipcRenderer.on('session:artifactCreated', handler);
    return () => ipcRenderer.removeListener('session:artifactCreated', handler);
  },


  // PTY Streaming Events
  writePty: (channelId: string, data: string): void => {
    ipcRenderer.send('pty:write', channelId, data);
  },
  resizePty: (channelId: string, cols: number, rows: number): void => {
    ipcRenderer.send('pty:resize', channelId, cols, rows);
  },
  onPtyData: (callback: (channelId: string, data: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, channelId: string, data: string) => {
      callback(channelId, data);
    };
    ipcRenderer.on('pty:data', handler);
    return () => ipcRenderer.removeListener('pty:data', handler);
  },
  onPtyExit: (callback: (channelId: string, exitCode: number) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, channelId: string, exitCode: number) => {
      callback(channelId, exitCode);
    };
    ipcRenderer.on('pty:exit', handler);
    return () => ipcRenderer.removeListener('pty:exit', handler);
  },

  // Attention & Status Supervision Events
  setActiveSession: (sessionId: string | null): void => {
    ipcRenderer.send('session:setActive', sessionId);
  },
  checkSessionStatus: (sessionId: string): Promise<import('@spawnea/domain').SessionStatusResult> =>
    ipcRenderer.invoke('sessions:checkStatus', sessionId),
  checkAllStatuses: (): Promise<Record<string, import('@spawnea/domain').SessionStatusResult>> =>
    ipcRenderer.invoke('sessions:checkAllStatuses'),
  getStateSnapshot: (sessionId: string): Promise<StateFeedbackSnapshot> =>
    ipcRenderer.invoke('session:getStateSnapshot', sessionId),
  submitStateFeedback: (report: StateFeedbackReport): Promise<StateFeedbackResult> =>
    ipcRenderer.invoke('session:submitStateFeedback', report),
  onStatusChanged: (
    callback: (
      sessionId: string,
      status: SessionStatus,
      result?: import('@spawnea/domain').SessionStatusResult
    ) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      sessionId: string,
      status: SessionStatus,
      result?: import('@spawnea/domain').SessionStatusResult
    ) => {
      callback(sessionId, status, result);
    };
    ipcRenderer.on('session:statusChanged', handler);
    return () => ipcRenderer.removeListener('session:statusChanged', handler);
  },
  onHostConnectionStateChanged: (callback: (state: HostConnectionState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: HostConnectionState) => {
      callback(state);
    };
    ipcRenderer.on('host:connectionStateChanged', handler);
    return () => ipcRenderer.removeListener('host:connectionStateChanged', handler);
  },
  onSessionReconnected: (callback: (data: { sessionId: string; ptyChannelId: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; ptyChannelId: string }) => {
      callback(data);
    };
    ipcRenderer.on('session:reconnected', handler);
    return () => ipcRenderer.removeListener('session:reconnected', handler);
  },
  onSessionActivate: (callback: (sessionId: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string) => {
      callback(sessionId);
    };
    ipcRenderer.on('session:activate', handler);
    return () => ipcRenderer.removeListener('session:activate', handler);
  },
  onHostHealthUpdated: (callback: (health: HostHealthResult) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, health: HostHealthResult) => {
      callback(health);
    };
    ipcRenderer.on('host:healthUpdated', handler);
    return () => ipcRenderer.removeListener('host:healthUpdated', handler);
  },
  onHostsHealthChanged: (callback: (healthMap: Record<string, HostHealthResult>) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, healthMap: Record<string, HostHealthResult>) => {
      callback(healthMap);
    };
    ipcRenderer.on('hosts:healthChanged', handler);
    return () => ipcRenderer.removeListener('hosts:healthChanged', handler);
  },
};

export type SpawneaApi = typeof api;

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('spawneaApi', api);
  } catch (error) {
    console.error('Failed to expose spawneaApi in main world:', error);
  }
} else {
  const target = globalThis as unknown as { spawneaApi: SpawneaApi };
  target.spawneaApi = api;
}
