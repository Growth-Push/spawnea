import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { App } from './App';
import { StatusBadge } from './components/StatusBadge';
import type { Session, Server, Project, Agent, SessionStatus } from '@spawnea/domain';

// Polyfill window.matchMedia and ResizeObserver for jsdom
if (typeof window !== 'undefined') {
  window.matchMedia =
    window.matchMedia ||
    (() => ({
      matches: false,
      media: '',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

  global.ResizeObserver =
    global.ResizeObserver ||
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };

  HTMLCanvasElement.prototype.getContext =
    HTMLCanvasElement.prototype.getContext ||
    (() => ({
      fillRect: vi.fn(),
      clearRect: vi.fn(),
      getImageData: vi.fn(),
      putImageData: vi.fn(),
      createImageData: vi.fn(),
      setTransform: vi.fn(),
      drawImage: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      measureText: vi.fn().mockReturnValue({ width: 10 }),
    }));
}

const mockServers: Server[] = [
  {
    id: 'srv-1',
    name: 'Dev Server Alpha',
    host: 'dev-alpha.example.test',
    sshPort: 22,
    enabled: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  },
  {
    id: 'srv-2',
    name: 'GPU Box',
    host: 'gpu.example.test',
    sshPort: 2222,
    enabled: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  },
];

const mockProjects: Project[] = [
  {
    id: 'proj-1',
    serverId: 'srv-1',
    name: 'Backend API',
    rootPath: '/srv/code/backend-api',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  },
  {
    id: 'proj-2',
    serverId: 'srv-2',
    name: 'ML Inference Engine',
    rootPath: '/srv/code/ml-engine',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  },
];

const mockAgents: Agent[] = [
  {
    id: 'agent-claude',
    name: 'Claude Code',
    harness: 'claude',
    command: 'claude',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  },
  {
    id: 'agent-codex',
    name: 'Codex CLI',
    harness: 'codex',
    command: 'codex',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  },
];

const mockSessions: Session[] = [
  {
    id: 'sess-1',
    name: 'Feature Auth Session',
    serverId: 'srv-1',
    projectId: 'proj-1',
    agentId: 'agent-claude',
    task: 'Implement JWT authentication',
    worktreePath: '/srv/code/backend-api/worktrees/auth',
    branch: 'feat/jwt-auth',
    tmuxSessionName: 'spawnea-auth',
    status: 'working',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastActivityAt: new Date('2026-01-01T01:00:00Z'),
  },
  {
    id: 'sess-2',
    name: 'Model Optimization',
    serverId: 'srv-2',
    projectId: 'proj-2',
    agentId: 'agent-codex',
    task: 'Optimize quantization pipeline',
    worktreePath: '/srv/code/ml-engine/worktrees/quant',
    branch: 'feat/quantization',
    tmuxSessionName: 'spawnea-quant',
    status: 'needs_input',
    createdAt: new Date('2026-01-02T00:00:00Z'),
    lastActivityAt: new Date('2026-01-02T02:00:00Z'),
  },
];

function createMockSpawneaApi(overrides: Partial<Window['spawneaApi']> = {}): Window['spawneaApi'] {
  return {
    writeClipboardText: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockResolvedValue(mockSessions),
    reconcileSessions: vi.fn().mockResolvedValue(mockSessions),
    listServers: vi.fn().mockResolvedValue(mockServers),
    listProjects: vi.fn().mockResolvedValue(mockProjects),
    listAgents: vi.fn().mockResolvedValue(mockAgents),
    getCatalog: vi.fn().mockResolvedValue({
      catalog: null,
      filePath: '/config/spawnea.yaml',
      errors: null,
    }),
    reloadCatalog: vi.fn().mockResolvedValue({
      success: true,
      catalog: null,
      filePath: '/config/spawnea.yaml',
      errors: null,
    }),
    addProjectToCatalog: vi.fn().mockResolvedValue({
      success: true,
      catalog: null,
      filePath: '/config/spawnea.yaml',
      errors: null,
    }),
    scanLocalSetup: vi.fn().mockResolvedValue({
      scanId: 'scan-1',
      hosts: [],
      harnesses: [],
      localHosts: [],
      warnings: [],
    }),
    previewLocalDiscovery: vi.fn().mockResolvedValue({ success: false, changes: [], errors: [] }),
    applyLocalDiscovery: vi.fn().mockResolvedValue({
      success: false,
      catalog: null,
      filePath: '/config/spawnea.yaml',
      errors: [],
      conflict: false,
    }),
    getFiles: vi.fn().mockResolvedValue([]),
    listFiles: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue({
      path: 'package.json',
      content: '{"name": "test"}',
      isBinary: false,
      isTruncated: false,
      sizeBytes: 16,
      mimeType: 'application/json',
    }),
    getDiff: vi.fn().mockResolvedValue(''),
    getGitStatus: vi.fn().mockResolvedValue({
      isGitRepo: true,
      branch: 'main',
      ahead: 0,
      behind: 0,
      isClean: true,
      staged: [],
      unstaged: [],
      untracked: [],
      totalChanges: 0,
    }),
    getGitDiff: vi.fn().mockResolvedValue({
      rawDiff: '',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      totalFilesChanged: 0,
    }),
    getArtifacts: vi.fn().mockResolvedValue([]),
    saveServer: vi.fn(),
    deleteServer: vi.fn(),
    testServer: vi.fn().mockResolvedValue({ success: true, hostId: 'srv-1', target: 'dev-alpha', latencyMs: 10, details: 'Connected' }),
    getHostSystemInfo: vi.fn().mockResolvedValue({
      serverId: 'srv-1',
      osName: 'Ubuntu 22.04.4 LTS',
      kernel: 'Linux 6.8.0-generic x86_64',
      arch: 'x86_64',
      cpuModel: '13th Gen Intel(R) Core(TM) i5-1340P (16 cores)',
      totalMemory: '15.4 GB',
      uptime: '2 hours, 15 minutes',
      shell: '/bin/bash',
      fetchedAt: new Date().toISOString(),
    }),
    discoverExternalSessions: vi.fn().mockResolvedValue([]),
    discoverProjectBranches: vi.fn().mockResolvedValue({
      isGitRepo: true,
      branches: ['main'],
      suggestedBranches: ['main'],
      currentBranch: 'main',
    }),
    chooseProjectPath: vi.fn().mockResolvedValue({ canceled: true }),
    saveProject: vi.fn(),
    deleteProject: vi.fn(),
    saveAgent: vi.fn(),
    deleteAgent: vi.fn(),
    createSession: vi.fn(),
    renameSession: vi.fn().mockImplementation(async (sessionId: string, name: string) => {
      const session = mockSessions.find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error(`Session '${sessionId}' not found`);
      return { ...session, name };
    }),
    adoptSession: vi.fn(),
    unadoptSession: vi.fn().mockResolvedValue(true),
    attachSession: vi.fn().mockResolvedValue({ ptyChannelId: 'pty-1' }),
    detachSession: vi.fn().mockResolvedValue(undefined),
    stopSession: vi.fn().mockResolvedValue(undefined),
    finishSession: vi.fn().mockResolvedValue({ action: 'integrate', removed: true }),
    inspectWorktree: vi.fn().mockResolvedValue({
      state: 'active',
      currentBranch: 'spawnea/test',
      message: 'Worktree is on its recorded task branch.',
    }),
    openExternalUrl: vi.fn().mockResolvedValue(true),
    openConfig: vi.fn().mockResolvedValue({ success: true }),
    deleteSession: vi.fn().mockResolvedValue(true),
    syncControlUiState: vi.fn(),
    listControlFinalizationRequests: vi.fn().mockResolvedValue([]),
    resolveControlFinalizationRequest: vi.fn(),
    onControlNavigate: vi.fn().mockReturnValue(() => {}),
    onControlFinalizationRequested: vi.fn().mockReturnValue(() => {}),
    onControlDataChanged: vi.fn().mockReturnValue(() => {}),
    uploadArtifact: vi.fn(),
    uploadArtifactFile: vi.fn(),
    uploadArtifactData: vi.fn(),
    pasteImage: vi.fn(),
    promoteToArtifact: vi.fn(),
    getArtifactContent: vi.fn().mockResolvedValue({
      path: 'package.json',
      content: '{"name": "test"}',
      isBinary: false,
      isTruncated: false,
      sizeBytes: 16,
      mimeType: 'application/json',
    }),
    deleteArtifact: vi.fn().mockResolvedValue(true),
    saveArtifactAs: vi.fn().mockResolvedValue(true),
    openArtifactInOs: vi.fn().mockResolvedValue(true),
    openSnippetInEditor: vi.fn().mockResolvedValue(true),
    createArtifactFromText: vi.fn().mockResolvedValue({
      id: 'art-1',
      sessionId: 'sess-1',
      filename: 'snippet-1.txt',
      direction: 'output',
      remotePath: '/workspace/spawnea/.spawnea/artifacts/snippet-1.txt',
      mimeType: 'text/plain',
      sizeBytes: 20,
      createdAt: new Date(),
    }),
    getArtifactBlacklist: vi.fn().mockResolvedValue(['package-lock.json', '*.log']),
    addArtifactToBlacklist: vi.fn().mockResolvedValue(['package-lock.json', '*.log', '*.tmp']),
    removeArtifactFromBlacklist: vi.fn().mockResolvedValue(['package-lock.json']),
    onArtifactCreated: vi.fn().mockReturnValue(() => {}),
    writePty: vi.fn(),
    resizePty: vi.fn(),
    onPtyData: vi.fn().mockReturnValue(() => {}),
    onPtyExit: vi.fn().mockReturnValue(() => {}),
    onStatusChanged: vi.fn().mockReturnValue(() => {}),
    setActiveSession: vi.fn(),
    checkSessionStatus: vi.fn().mockResolvedValue({ status: 'working', confidence: 1.0, source: 'process_tree', updatedAt: new Date() }),
    checkAllStatuses: vi.fn().mockResolvedValue({}),
    getStateSnapshot: vi.fn().mockResolvedValue({
      sessionId: 'sess-1',
      sessionName: 'Session 1',
      harness: 'claude',
      worktreePath: '/workspace/spawnea',
      branch: 'main',
      detectedStatus: 'working',
      confidence: 0.8,
      source: 'process',
      reason: 'Active process',
      tailLines: ['Line 1', 'Line 2'],
      capturedAt: new Date().toISOString(),
    }),
    submitStateFeedback: vi.fn().mockResolvedValue({
      success: true,
      filePath: '/tmp/feedback.json',
      fixtureJson: '{}',
    }),
    getHostConnectionState: vi.fn().mockResolvedValue({
      serverId: 'srv-1',
      status: 'connected',
      attempt: 0,
      maxAttempts: 5,
    }),
    retryHostConnection: vi.fn().mockResolvedValue({
      serverId: 'srv-1',
      status: 'connected',
      attempt: 0,
      maxAttempts: 5,
    }),
    onHostConnectionStateChanged: vi.fn().mockReturnValue(() => {}),
    onSessionReconnected: vi.fn().mockReturnValue(() => {}),
    onSessionActivate: vi.fn().mockReturnValue(() => {}),
    getHostHealth: vi.fn().mockResolvedValue({}),
    checkHostHealth: vi.fn().mockResolvedValue({}),
    onHostHealthUpdated: vi.fn().mockReturnValue(() => {}),
    onHostsHealthChanged: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

describe('StatusBadge component', () => {
  const statuses: SessionStatus[] = [
    'starting',
    'working',
    'needs_input',
    'idle',
    'done',
    'error',
    'disconnected',
  ];

  it.each(statuses)('renders correct text and testid for status: %s', (status) => {
    render(<StatusBadge status={status} />);
    const badge = screen.getByTestId(`status-badge-${status}`);
    expect(badge).toBeDefined();
  });
});

describe('App Desktop Shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    // Keep the preload bridge from leaking between tests.
    // @ts-expect-error test cleanup
    delete window.spawneaApi;
  });

  it('renders a fatal startup error when window.spawneaApi is not present', () => {
    // @ts-expect-error test cleanup
    delete window.spawneaApi;
    render(<App />);
    expect(screen.getByText('The desktop bridge is unavailable')).toBeDefined();
    expect(screen.getByText(/No fallback data was loaded/i)).toBeDefined();
  });

  it('loads sessions, servers, projects, and agents from window.spawneaApi', async () => {
    window.spawneaApi = createMockSpawneaApi({
      getFiles: vi.fn().mockResolvedValue([
        { name: 'src', path: 'src', isDirectory: true, isFile: false, size: 4096, modifiedAt: new Date() },
      ]),
      getDiff: vi.fn().mockResolvedValue('diff --git a/test.ts b/test.ts\n+ console.log("hello");'),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Active Sessions (2)')).toBeDefined();
      expect(screen.getAllByText('Feature Auth Session').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Model Optimization').length).toBeGreaterThan(0);
    });

    // Default first session active in ContextBar & Sidebar
    expect(screen.getAllByText('feat/jwt-auth').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Backend API').length).toBeGreaterThan(0);
  });

  it('switches active session when clicked in the sidebar', async () => {
    window.spawneaApi = createMockSpawneaApi();

    render(<App />);

    await waitFor(() => {
      expect(screen.getAllByText('Feature Auth Session').length).toBeGreaterThan(0);
    });

    // Click second session in sidebar
    const secondSessionItem = screen.getByTestId('session-item-sess-2');
    fireEvent.click(secondSessionItem);

    // Verify context bar switched to second session
    await waitFor(() => {
      expect(screen.getAllByText('feat/quantization').length).toBeGreaterThan(0);
      expect(screen.getAllByText('ML Inference Engine').length).toBeGreaterThan(0);
    });
  });

  it('does not request host telemetry automatically for a credential-backed host', async () => {
    const credentialServer: Server = {
      ...mockServers[0],
      id: 'secure',
      name: 'Secure host',
      host: 'credential-backed',
    };
    const getHostSystemInfo = vi.fn().mockResolvedValue(null);
    const getHostHealth = vi.fn().mockResolvedValue({});
    const checkHostHealth = vi.fn().mockResolvedValue({});
    window.spawneaApi = createMockSpawneaApi({
      listSessions: vi.fn().mockResolvedValue([]),
      listServers: vi.fn().mockResolvedValue([credentialServer]),
      listProjects: vi.fn().mockResolvedValue([]),
      listAgents: vi.fn().mockResolvedValue([]),
      getHostSystemInfo,
      getHostHealth,
      checkHostHealth,
      getCatalog: vi.fn().mockResolvedValue({
        catalog: {
          version: 1,
          hosts: {
            secure: {
              id: 'secure',
              name: 'Secure host',
              enabled: true,
              ssh: { target: '1Password-backed' },
              projects: {},
              harnesses: {},
            },
          },
        },
        filePath: '/config/spawnea.yaml',
        errors: null,
      }),
    });

    render(<App />);

    await waitFor(() => expect(getHostHealth).toHaveBeenCalledTimes(1));
    expect(getHostSystemInfo).not.toHaveBeenCalled();
    expect(checkHostHealth).not.toHaveBeenCalled();
  });

  it('edits a session title inline and updates every renderer surface', async () => {
    const duplicatedTitleSession = {
      ...mockSessions[0],
      name: mockSessions[0].task,
    };
    const renameSession = vi.fn().mockImplementation(async (sessionId: string, name: string) => ({
      ...duplicatedTitleSession,
      id: sessionId,
      name,
    }));
    window.spawneaApi = createMockSpawneaApi({
      listSessions: vi.fn().mockResolvedValue([duplicatedTitleSession]),
      reconcileSessions: vi.fn().mockResolvedValue([duplicatedTitleSession]),
      renameSession,
    });

    render(<App />);

    const editButton = await screen.findByRole('button', { name: 'Edit session title' });
    const contextBar = editButton.closest('header');
    expect(contextBar).not.toBeNull();
    expect(contextBar?.textContent?.split(duplicatedTitleSession.task)).toHaveLength(2);

    fireEvent.click(editButton);
    const input = screen.getByRole('textbox', { name: 'Session title' });
    fireEvent.change(input, { target: { value: 'JWT review' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(renameSession).toHaveBeenCalledWith('sess-1', 'JWT review');
      expect(screen.getAllByText('JWT review').length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.queryByRole('textbox', { name: 'Session title' })).toBeNull();
    expect(contextBar?.textContent).toContain(duplicatedTitleSession.task);
  });

  it('rejects a blank session title and lets Escape cancel inline editing', async () => {
    const renameSession = vi.fn();
    window.spawneaApi = createMockSpawneaApi({ renameSession });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit session title' }));
    const input = screen.getByRole('textbox', { name: 'Session title' });
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect((await screen.findByRole('alert')).textContent).toContain('Title cannot be empty');
    expect(renameSession).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Session title' })).toBeNull();
    expect(screen.getAllByText('Feature Auth Session').length).toBeGreaterThan(0);
  });

  it('navigates workspace tabs (Terminal, Files, Git Diff, Artifacts, Details)', async () => {
    window.spawneaApi = createMockSpawneaApi({
      getFiles: vi.fn().mockResolvedValue([
        { name: 'server.ts', path: 'server.ts', isDirectory: false, isFile: true, size: 2048, modifiedAt: new Date() },
      ]),
      listFiles: vi.fn().mockResolvedValue([
        { name: 'server.ts', path: 'server.ts', isDirectory: false, isFile: true, size: 2048, modifiedAt: new Date() },
      ]),
      getDiff: vi.fn().mockResolvedValue('diff --git a/auth.ts b/auth.ts\n+ token verification'),
      getGitStatus: vi.fn().mockResolvedValue({
        isGitRepo: true,
        branch: 'feat/auth',
        ahead: 0,
        behind: 0,
        isClean: false,
        staged: [],
        unstaged: [{ path: 'auth.ts', status: 'modified', staged: false, statusCode: 'M' }],
        untracked: [],
        totalChanges: 1,
      }),
      getGitDiff: vi.fn().mockResolvedValue({
        rawDiff: 'diff --git a/auth.ts b/auth.ts\n--- a/auth.ts\n+++ b/auth.ts\n@@ -1 +1 @@\n-old\n+ token verification\n',
        files: [
          {
            path: 'auth.ts',
            additions: 1,
            deletions: 1,
            isBinary: false,
            isNew: false,
            isDeleted: false,
            isRenamed: false,
            hunks: [
              {
                header: '@@ -1 +1 @@',
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: [
                  { type: 'delete', content: 'old', oldLineNumber: 1 },
                  { type: 'add', content: ' token verification', newLineNumber: 1 },
                ],
              },
            ],
          },
        ],
        totalAdditions: 1,
        totalDeletions: 1,
        totalFilesChanged: 1,
      }),
      getArtifacts: vi.fn().mockResolvedValue([
        {
          id: 'art-1',
          sessionId: 'sess-1',
          direction: 'output',
          remotePath: '/tmp/art-1.png',
          filename: 'diagram.png',
          mimeType: 'image/png',
          sizeBytes: 10240,
          createdAt: new Date(),
        },
      ]),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getAllByText('Feature Auth Session').length).toBeGreaterThan(0);
    });

    // 1. Files Tab
    fireEvent.click(screen.getByTestId('workspace-tab-files'));
    await waitFor(() => {
      expect(screen.getByText('server.ts')).toBeDefined();
    });

    // 2. Git Diff Tab
    fireEvent.click(screen.getByTestId('workspace-tab-diff'));
    await waitFor(() => {
      expect(screen.getByText(/token verification/)).toBeDefined();
    });

    // 3. Artifacts Tab
    fireEvent.click(screen.getByTestId('workspace-tab-artifacts'));
    await waitFor(() => {
      expect(screen.getByText('diagram.png')).toBeDefined();
    });

    // 4. Session Info Tab
    fireEvent.click(screen.getByTestId('workspace-tab-details'));
    await waitFor(() => {
      expect(screen.getByText('Session Entity Details')).toBeDefined();
      expect(screen.getByText('sess-1')).toBeDefined();
    });

    // 5. Back to Terminal Tab
    fireEvent.click(screen.getByTestId('workspace-tab-terminal'));
    await waitFor(() => {
      expect(screen.getByText('PTY Stream Active')).toBeDefined();
      expect(screen.getByTestId('xterm-container')).toBeDefined();
    });
  });

  it('polls Git status for managed and non-managed sessions and marks only dirty sessions', async () => {
    const managedDirtySession = { ...mockSessions[0], managedWorktree: true };
    const nonManagedDirtySession = {
      ...mockSessions[1],
      id: 'sess-non-managed-dirty',
      name: 'Non-managed dirty session',
      managedWorktree: false,
    };
    const nonManagedCleanSession = {
      ...mockSessions[1],
      id: 'sess-non-managed-clean',
      name: 'Non-managed clean session',
      managedWorktree: false,
    };
    const managedCleanSession = {
      ...mockSessions[0],
      id: 'sess-managed-clean',
      name: 'Managed clean session',
      managedWorktree: true,
    };
    const sessions = [managedDirtySession, nonManagedDirtySession, managedCleanSession, nonManagedCleanSession];
    const statuses = {
      [managedDirtySession.id]: {
        isGitRepo: true,
        branch: managedDirtySession.branch,
        ahead: 0,
        behind: 0,
        isClean: false,
        staged: [],
        unstaged: [{ path: 'src/dirty.ts', status: 'modified', staged: false, statusCode: 'M' as const }],
        untracked: [],
        totalChanges: 1,
      },
      [nonManagedDirtySession.id]: {
        isGitRepo: true,
        branch: nonManagedDirtySession.branch,
        ahead: 0,
        behind: 0,
        isClean: false,
        staged: [],
        unstaged: [{ path: 'src/normal-dirty.ts', status: 'modified', staged: false, statusCode: 'M' as const }],
        untracked: [],
        totalChanges: 1,
      },
      [managedCleanSession.id]: {
        isGitRepo: true,
        branch: managedCleanSession.branch,
        ahead: 0,
        behind: 0,
        isClean: true,
        staged: [],
        unstaged: [],
        untracked: [],
        totalChanges: 0,
      },
      [nonManagedCleanSession.id]: {
        isGitRepo: true,
        branch: nonManagedCleanSession.branch,
        ahead: 0,
        behind: 0,
        isClean: true,
        staged: [],
        unstaged: [],
        untracked: [],
        totalChanges: 0,
      },
    };
    const getGitStatus = vi.fn().mockImplementation((sessionId: string) => Promise.resolve(statuses[sessionId as keyof typeof statuses]));

    window.spawneaApi = createMockSpawneaApi({
      listSessions: vi.fn().mockResolvedValue(sessions),
      getGitStatus,
    });

    render(<App />);

    await waitFor(() => {
      expect(getGitStatus).toHaveBeenCalledWith(managedDirtySession.id);
      expect(getGitStatus).toHaveBeenCalledWith(nonManagedDirtySession.id);
      expect(getGitStatus).toHaveBeenCalledWith(managedCleanSession.id);
      expect(getGitStatus).toHaveBeenCalledWith(nonManagedCleanSession.id);
      expect(screen.getByTestId(`session-worktree-dirty-indicator-${managedDirtySession.id}`)).toBeDefined();
      expect(screen.getByTestId(`session-git-dirty-indicator-${nonManagedDirtySession.id}`)).toBeDefined();
      expect(screen.queryByTestId(`session-worktree-dirty-indicator-${managedCleanSession.id}`)).toBeNull();
      expect(screen.queryByTestId(`session-git-dirty-indicator-${nonManagedCleanSession.id}`)).toBeNull();
      expect(screen.getByTestId('contextbar-worktree-dirty-indicator')).toBeDefined();
      expect(screen.getByTestId('workspace-worktree-dirty-indicator')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId(`session-item-${nonManagedDirtySession.id}`));

    await waitFor(() => {
      expect(screen.getByTestId('contextbar-git-dirty-indicator')).toBeDefined();
      expect(screen.getByTestId('workspace-git-dirty-indicator')).toBeDefined();
      expect(screen.queryByTestId('contextbar-worktree-badge')).toBeNull();
      expect(screen.queryByTestId('workspace-worktree-badge')).toBeNull();
    });
  });

  it('opens CreateSessionModal, fills form, and launches new session', async () => {
    const createdSession: Session = {
      id: 'sess-new-123',
      name: 'Add user settings page',
      serverId: 'srv-1',
      projectId: 'proj-1',
      agentId: 'agent-claude',
      task: 'Add user settings page',
      worktreePath: '/srv/code/backend-api/worktrees/settings',
      branch: 'feat/settings',
      tmuxSessionName: 'spawnea-settings',
      status: 'starting',
      createdAt: new Date(),
      lastActivityAt: new Date(),
    };

    const createSessionMock = vi.fn().mockResolvedValue(createdSession);

    window.spawneaApi = createMockSpawneaApi({
      createSession: createSessionMock,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Active Sessions (2)')).toBeDefined();
    });

    // Click New Session in sidebar
    fireEvent.click(screen.getByTestId('sidebar-new-session-button'));

    // Modal opens
    expect(screen.getByText('Create Agent Session')).toBeDefined();

    // Custom selectors expose the existing provider and host icons in their open lists.
    fireEvent.click(screen.getByTestId('select-agent-trigger'));
    expect(screen.getAllByTestId('provider-icon-claude').length).toBeGreaterThan(1);
    fireEvent.click(screen.getByTestId('select-server-trigger'));
    expect(screen.getAllByTestId('os-icon-linux').length).toBeGreaterThan(1);

    // Fill form
    const taskInput = screen.getByTestId('input-task-name');
    fireEvent.change(taskInput, { target: { value: 'Add user settings page' } });

    // Submit form
    fireEvent.click(screen.getByTestId('submit-create-session'));

    await waitFor(() => {
      expect(createSessionMock).toHaveBeenCalledWith({
        serverId: 'srv-1',
        projectId: 'proj-1',
        agentId: 'agent-claude',
        task: 'Add user settings page',
        baseBranch: undefined,
        useWorktree: false,
      });
    });

    // Newly created session is now displayed and active
    await waitFor(() => {
      expect(screen.getByText('Active Sessions (3)')).toBeDefined();
      expect(screen.getAllByText('feat/settings').length).toBeGreaterThan(0);
    });
  });

  it('enables worktree toggle and provisions worktree when project in catalog has worktree enabled', async () => {
    const createdSession: Session = {
      id: 'sess-new-worktree-1',
      name: 'Worktree feature',
      serverId: 'srv-1',
      projectId: 'proj-1',
      agentId: 'agent-claude',
      task: 'Worktree feature',
      worktreePath: '/srv/code/backend-api__worktrees/worktree-feature',
      branch: 'spawnea/worktree-feature-123',
      baseBranch: 'main',
      managedWorktree: true,
      tmuxSessionName: 'spawnea-worktree-feature',
      status: 'starting',
      createdAt: new Date(),
      lastActivityAt: new Date(),
    };

    const createSessionMock = vi.fn().mockResolvedValue(createdSession);

    window.spawneaApi = createMockSpawneaApi({
      createSession: createSessionMock,
      getCatalog: vi.fn().mockResolvedValue({
        catalog: {
          version: 1,
          hosts: {
            'srv-1': {
              name: 'Dev Server Alpha',
              projects: {
                'proj-1': {
                  name: 'Backend API',
                  path: '/srv/code/backend-api',
                  worktree: {
                    enabled: true,
                    copy_files: ['.envrc'],
                  },
                },
              },
              harnesses: {},
            },
          },
        },
        filePath: '/config/spawnea.yaml',
        errors: null,
      }),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Active Sessions (2)')).toBeDefined();
    });

    // Click New Session in sidebar
    fireEvent.click(screen.getByTestId('sidebar-new-session-button'));

    // Modal opens and shows worktree badge
    expect(screen.getByText('Create Agent Session')).toBeDefined();
    expect(screen.getByText('Worktree')).toBeDefined();

    // Fill form with custom base branch
    const taskInput = screen.getByTestId('input-task-name');
    fireEvent.change(taskInput, { target: { value: 'Worktree feature' } });

    const branchInput = screen.getByTestId('input-branch');
    fireEvent.change(branchInput, { target: { value: 'main' } });

    // Submit form
    fireEvent.click(screen.getByTestId('submit-create-session'));

    await waitFor(() => {
      expect(createSessionMock).toHaveBeenCalledWith({
        serverId: 'srv-1',
        projectId: 'proj-1',
        agentId: 'agent-claude',
        task: 'Worktree feature',
        baseBranch: 'main',
        useWorktree: true,
      });
    });
  });

  it('allows unchecking worktree toggle for a project configured with worktrees and runs on project root', async () => {
    const createdSession: Session = {
      id: 'sess-new-root-1',
      name: 'Root feature',
      serverId: 'srv-1',
      projectId: 'proj-1',
      agentId: 'agent-claude',
      task: 'Root feature',
      worktreePath: '/srv/code/backend-api',
      branch: 'main',
      managedWorktree: false,
      tmuxSessionName: 'spawnea-root-feature',
      status: 'starting',
      createdAt: new Date(),
      lastActivityAt: new Date(),
    };

    const createSessionMock = vi.fn().mockResolvedValue(createdSession);

    window.spawneaApi = createMockSpawneaApi({
      createSession: createSessionMock,
      getCatalog: vi.fn().mockResolvedValue({
        catalog: {
          version: 1,
          hosts: {
            'srv-1': {
              name: 'Dev Server Alpha',
              projects: {
                'proj-1': {
                  name: 'Backend API',
                  path: '/srv/code/backend-api',
                  worktree: {
                    enabled: true,
                    copy_files: ['.envrc'],
                  },
                },
              },
              harnesses: {},
            },
          },
        },
        filePath: '/config/spawnea.yaml',
        errors: null,
      }),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Active Sessions (2)')).toBeDefined();
    });

    // Click New Session in sidebar
    fireEvent.click(screen.getByTestId('sidebar-new-session-button'));
    expect(screen.getByText('Create Agent Session')).toBeDefined();

    // Verify checkbox is present and checked by default
    const checkbox = screen.getByTestId('checkbox-use-worktree') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    // Uncheck worktree
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);

    // Fill form task
    const taskInput = screen.getByTestId('input-task-name');
    fireEvent.change(taskInput, { target: { value: 'Root feature' } });

    // Submit form
    fireEvent.click(screen.getByTestId('submit-create-session'));

    await waitFor(() => {
      expect(createSessionMock).toHaveBeenCalledWith({
        serverId: 'srv-1',
        projectId: 'proj-1',
        agentId: 'agent-claude',
        task: 'Root feature',
        baseBranch: undefined,
        useWorktree: false,
      });
    });
  });

  it('closes CreateSessionModal only with Escape or Cancel, not by clicking the backdrop', async () => {
    window.spawneaApi = createMockSpawneaApi();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Active Sessions (2)')).toBeDefined();
    });

    // 1. Open modal via New Session button
    fireEvent.click(screen.getAllByTestId('sidebar-new-session-button')[0]);
    expect(screen.getByText('Create Agent Session')).toBeDefined();

    // 2. Press Escape -> Modal closes
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByText('Create Agent Session')).toBeNull();
    });

    // 3. Open modal again and click backdrop -> modal stays open
    fireEvent.click(screen.getAllByTestId('sidebar-new-session-button')[0]);
    expect(screen.getByText('Create Agent Session')).toBeDefined();

    const modalDialog = screen.getByRole('dialog', { name: /create agent session/i });
    fireEvent.click(modalDialog);
    expect(screen.getByText('Create Agent Session')).toBeDefined();

    // 4. Cancel is an explicit close action
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByText('Create Agent Session')).toBeNull();
    });
  });

  it('auto-populates task description from selection and preserves manual edits', async () => {
    window.spawneaApi = createMockSpawneaApi();
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Active Sessions (2)')).toBeDefined();
    });

    // Click New Session
    fireEvent.click(screen.getByTestId('sidebar-new-session-button'));
    expect(screen.getByText('Create Agent Session')).toBeDefined();

    const taskInput = screen.getByTestId('input-task-name') as HTMLInputElement;

    // By default, it auto-populates from the initial project and agent: 'Backend API - Claude Code'
    expect(taskInput.value).toBe('Backend API - Claude Code');

    // Switch server selection -> project changes to proj-2 ('ML Inference Engine') -> task updates automatically
    const serverSelect = screen.getByTestId('select-server');
    fireEvent.change(serverSelect, { target: { value: 'srv-2' } });
    expect(taskInput.value).toBe('ML Inference Engine - Claude Code');

    // Manually edit the task description
    fireEvent.change(taskInput, { target: { value: 'My Custom Fix' } });
    expect(taskInput.value).toBe('My Custom Fix');

    // Switch server selection again -> manual edit is NOT overwritten
    fireEvent.change(serverSelect, { target: { value: 'srv-1' } });
    expect(taskInput.value).toBe('My Custom Fix');

    // Click "Use default name" button -> restores auto-generated task description
    const resetBtn = screen.getByText('Use default name');
    fireEvent.click(resetBtn);
    expect(taskInput.value).toBe('Backend API - Claude Code');

    // Clearing the task is an intentional edit and stays blank until restored explicitly.
    fireEvent.change(taskInput, { target: { value: '' } });
    expect(taskInput.value).toBe('');
    fireEvent.change(serverSelect, { target: { value: 'srv-2' } });
    expect(taskInput.value).toBe('');

    // The task remains required at submit time.
    fireEvent.click(screen.getByTestId('submit-create-session'));
    expect(screen.getByText('Please provide a task description.')).toBeDefined();
  });

  it('orders project options alphabetically without changing their IDs', async () => {
    const projects = [
      { ...mockProjects[0], id: 'proj-z', name: 'zeta project' },
      { ...mockProjects[0], id: 'proj-a', name: 'Alpha Project' },
      { ...mockProjects[0], id: 'proj-b', name: 'beta project' },
    ];
    window.spawneaApi = createMockSpawneaApi({ listProjects: vi.fn().mockResolvedValue(projects) });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Active Sessions (2)')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('sidebar-new-session-button'));
    const projectSelect = screen.getByTestId('select-project') as HTMLSelectElement;
    expect(Array.from(projectSelect.options).map((option) => option.textContent)).toEqual([
      'Alpha Project',
      'beta project',
      'zeta project',
    ]);
    expect(Array.from(projectSelect.options).map((option) => option.value)).toEqual([
      'proj-a',
      'proj-b',
      'proj-z',
    ]);
  });

  it('renders friendly empty state when no sessions are returned', async () => {
    window.spawneaApi = createMockSpawneaApi({
      listSessions: vi.fn().mockResolvedValue([]),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('No Active Agent Sessions')).toBeDefined();
      expect(screen.getByTestId('empty-state-new-session-button')).toBeDefined();
    });
  });

  it('triggers detach and stop lifecycle actions via ContextBar', async () => {
    const detachMock = vi.fn().mockResolvedValue(undefined);
    const stopMock = vi.fn().mockResolvedValue(undefined);

    window.spawneaApi = createMockSpawneaApi({
      detachSession: detachMock,
      stopSession: stopMock,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getAllByText('Feature Auth Session').length).toBeGreaterThan(0);
    });

    // Click Detach button
    fireEvent.click(screen.getByTestId('session-detach-button'));
    await waitFor(() => {
      expect(detachMock).toHaveBeenCalledWith('sess-1');
    });

    // Click Stop button -> opens StopSessionModal with active-work warning
    fireEvent.click(screen.getByTestId('session-stop-button'));
    await waitFor(() => {
      expect(screen.getByTestId('stop-session-modal')).toBeDefined();
    });

    // Confirm stop in modal
    fireEvent.click(screen.getByTestId('stop-modal-confirm'));
    await waitFor(() => {
      expect(stopMock).toHaveBeenCalledWith('sess-1');
    });
  });

  it('handles catalog reloading and displays error banner when invalid reload occurs', async () => {
    const reloadCatalogMock = vi.fn().mockResolvedValue({
      success: false,
      catalog: {
        version: 1,
        hosts: {
          'dev-workstation': {
            id: 'dev-workstation',
            name: 'Development Workstation',
            enabled: true,
            ssh: { target: 'example-host' },
            projects: {},
            harnesses: {},
          },
        },
      },
      filePath: '/config/spawnea.yaml',
      errors: [
        { path: 'hosts.dev-workstation.ssh.port', message: 'SSH port must not exceed 65535' },
      ],
    });

    window.spawneaApi = createMockSpawneaApi({
      reloadCatalog: reloadCatalogMock,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getAllByText('Feature Auth Session').length).toBeGreaterThan(0);
    });

    // Open the sidebar actions menu and reload the catalog
    fireEvent.click(screen.getByTestId('sidebar-actions-menu-button'));
    const reloadButton = screen.getByTestId('sidebar-reload-catalog-button');
    fireEvent.click(reloadButton);

    await waitFor(() => {
      expect(reloadCatalogMock).toHaveBeenCalled();
    });

    // Error banner should appear with fallback indicator
    await waitFor(() => {
      expect(screen.getByTestId('catalog-error-banner')).toBeDefined();
      expect(screen.getByText(/Last valid catalog remains active/i)).toBeDefined();
    });
  });

  it('tests the selected host only after the operator presses Test Connection (FG-1.2, FG-2.1)', async () => {
    const testServerMock = vi.fn().mockResolvedValue({
      success: true,
      hostId: 'srv-1',
      target: 'dev-alpha.example.test',
      latencyMs: 25,
      details: 'Connected successfully (25ms)',
    });

    window.spawneaApi = createMockSpawneaApi({
      testServer: testServerMock,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Active Sessions (2)')).toBeDefined();
    });

    // Open Create Session modal
    fireEvent.click(screen.getByTestId('sidebar-new-session-button'));

    // Opening the modal and selecting a host must not probe it automatically.
    expect(testServerMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('test-host-button')).toBeDefined();

    fireEvent.change(screen.getByTestId('select-server'), { target: { value: 'srv-2' } });
    expect(testServerMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('test-host-button'));

    await waitFor(() => {
      expect(testServerMock).toHaveBeenCalledWith('srv-2');
      expect(screen.getByTestId('host-status-connected')).toBeDefined();
    });
  });

  it('truthfully displays folder preparation or launch errors in modal without closing (FG-2.2.5, FG-2.5)', async () => {
    const createSessionMock = vi.fn().mockRejectedValue(new Error('Git clone failed: Authentication required'));

    window.spawneaApi = createMockSpawneaApi({
      createSession: createSessionMock,
      testServer: vi.fn().mockResolvedValue({ success: true, hostId: 'srv-1', target: 'dev-alpha' }),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Active Sessions (2)')).toBeDefined();
    });

    // Open modal
    fireEvent.click(screen.getByTestId('sidebar-new-session-button'));

    // Fill task description
    const taskInput = screen.getByTestId('input-task-name');
    fireEvent.change(taskInput, { target: { value: 'Clone private repo' } });

    // Submit form
    fireEvent.click(screen.getByTestId('submit-create-session'));

    // Error banner should be displayed in the modal
    await waitFor(() => {
      expect(screen.getByTestId('create-session-error-banner')).toBeDefined();
      expect(screen.getByText(/Git clone failed: Authentication required/)).toBeDefined();
    });

    // Modal remains open and task description is preserved
    expect(screen.getByText('Create Agent Session')).toBeDefined();
    expect((taskInput as HTMLInputElement).value).toBe('Clone private repo');
  });

  it('handles session detach and attach cleanly from ContextBar (FG-2.3.1, FG-2.3.3)', async () => {
    const detachMock = vi.fn().mockResolvedValue(undefined);
    const attachMock = vi.fn().mockResolvedValue({ ptyChannelId: 'pty-sess-1' });

    window.spawneaApi = createMockSpawneaApi({
      detachSession: detachMock,
      attachSession: attachMock,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Active Sessions (2)')).toBeDefined();
    });

    // Session 1 is selected by default and in 'working' status
    expect(screen.getByTestId('session-detach-button')).toBeDefined();

    // Click Detach
    fireEvent.click(screen.getByTestId('session-detach-button'));

    await waitFor(() => {
      expect(detachMock).toHaveBeenCalledWith('sess-1');
      expect(screen.getByTestId('session-attach-button')).toBeDefined();
    });

    // Click Attach to re-attach
    fireEvent.click(screen.getByTestId('session-attach-button'));

    await waitFor(() => {
      expect(attachMock).toHaveBeenCalledWith('sess-1', expect.any(Number), expect.any(Number));
      expect(screen.getByTestId('session-detach-button')).toBeDefined();
    });
  });

  it('handles explicit session stop separately from detach with active-work warning (FG-2.7.1, FG-2.7.2)', async () => {
    const stopMock = vi.fn().mockResolvedValue(undefined);
    const detachMock = vi.fn().mockResolvedValue(undefined);

    window.spawneaApi = createMockSpawneaApi({
      stopSession: stopMock,
      detachSession: detachMock,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Active Sessions (2)')).toBeDefined();
    });

    // 1. Click Stop -> opens StopSessionModal with active-work warning
    fireEvent.click(screen.getByTestId('session-stop-button'));

    await waitFor(() => {
      expect(screen.getByTestId('stop-session-modal')).toBeDefined();
      expect(screen.getByText('Terminate Session Execution?')).toBeDefined();
      expect(screen.getByText('Active Work Warning')).toBeDefined();
    });

    // 2. Test Cancel -> closes modal without calling stopSession
    fireEvent.click(screen.getByTestId('stop-modal-cancel'));
    await waitFor(() => {
      expect(screen.queryByTestId('stop-session-modal')).toBeNull();
      expect(stopMock).not.toHaveBeenCalled();
    });

    // 3. Re-open Stop modal and test Detach Instead
    fireEvent.click(screen.getByTestId('session-stop-button'));
    await waitFor(() => {
      expect(screen.getByTestId('stop-session-modal')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('stop-modal-detach'));
    await waitFor(() => {
      expect(detachMock).toHaveBeenCalledWith('sess-1');
      expect(stopMock).not.toHaveBeenCalled();
      expect(screen.queryByTestId('stop-session-modal')).toBeNull();
    });

    // 4. Re-open Stop modal and Confirm Stop
    fireEvent.click(screen.getByTestId('session-stop-button'));
    await waitFor(() => {
      expect(screen.getByTestId('stop-session-modal')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('stop-modal-confirm'));
    await waitFor(() => {
      expect(stopMock).toHaveBeenCalledWith('sess-1');
      expect(screen.queryByTestId('stop-session-modal')).toBeNull();
    });
  });

  it('deletes a concluded session from context bar when stopped/done (FG-2.6.5, FG-2.7.4)', async () => {
    const deleteMock = vi.fn().mockResolvedValue(true);

    const doneSessions: Session[] = [
      { ...mockSessions[0], status: 'done' },
      mockSessions[1],
    ];

    window.spawneaApi = createMockSpawneaApi({
      listSessions: vi.fn().mockResolvedValue(doneSessions),
      deleteSession: deleteMock,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Active Sessions (2)')).toBeDefined();
    });

    // Delete session 1 from ContextBar (since it is 'done')
    fireEvent.click(screen.getByTestId('session-delete-button'));

    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith('sess-1');
      expect(screen.getByText('Active Sessions (1)')).toBeDefined();
    });
  });

  it('shows and hides lifecycle buttons in ContextBar according to state machine (disconnected -> connected -> stopped -> deleted)', async () => {
    const stateSessions: Session[] = [
      { ...mockSessions[0], id: 'sess-disconnected', name: 'Disconnected Sess', status: 'disconnected' },
      { ...mockSessions[1], id: 'sess-connected', name: 'Connected Sess', status: 'working' },
      { ...mockSessions[0], id: 'sess-done', name: 'Done Sess', status: 'done' },
    ];

    window.spawneaApi = createMockSpawneaApi({
      listSessions: vi.fn().mockResolvedValue(stateSessions),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Active Sessions (3)')).toBeDefined();
    });

    // 1. Check Connected (working) session: shows Detach and Stop; hides Attach and Delete
    fireEvent.click(screen.getByTestId('session-item-sess-connected'));
    await waitFor(() => {
      expect(screen.getByTestId('session-detach-button')).toBeDefined();
      expect(screen.getByTestId('session-stop-button')).toBeDefined();
      expect(screen.queryByTestId('session-attach-button')).toBeNull();
      expect(screen.queryByTestId('session-delete-button')).toBeNull();
    });

    // 2. Detach session: shows Attach and Stop; hides Detach and Delete
    fireEvent.click(screen.getByTestId('session-detach-button'));
    await waitFor(() => {
      expect(screen.getByTestId('session-attach-button')).toBeDefined();
      expect(screen.getByTestId('session-stop-button')).toBeDefined();
      expect(screen.queryByTestId('session-detach-button')).toBeNull();
      expect(screen.queryByTestId('session-delete-button')).toBeNull();
    });

    // 3. Check Done session: shows Delete; hides Attach, Detach, and Stop
    fireEvent.click(screen.getByTestId('session-item-sess-done'));
    await waitFor(() => {
      expect(screen.getByTestId('session-delete-button')).toBeDefined();
      expect(screen.queryByTestId('session-attach-button')).toBeNull();
      expect(screen.queryByTestId('session-detach-button')).toBeNull();
      expect(screen.queryByTestId('session-stop-button')).toBeNull();
    });
  });

  it('renders session card with Host icon, Provider icon, branch, and path without duplicate title or trash button', async () => {
    window.spawneaApi = createMockSpawneaApi();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Active Sessions (2)')).toBeDefined();
    });

    // Session 1: host is Linux/Ubuntu, harness is claude -> should render provider-icon-claude and os-icon
    expect(screen.getAllByTestId('provider-icon-claude').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('os-icon-ubuntu').length).toBeGreaterThan(0);

    // Branch and path should be displayed
    expect(screen.getAllByText('feat/jwt-auth').length).toBeGreaterThan(0);
    expect(screen.getAllByText('/srv/code/backend-api/worktrees/auth').length).toBeGreaterThan(0);

    // Trash button should not be present on sidebar cards
    expect(screen.queryByTestId('session-delete-button-sess-1')).toBeNull();
    expect(screen.queryByTestId('session-delete-button-sess-2')).toBeNull();
  });

  it('browses sessions grouped by host, project, and harness (FG-4.1.1, FG-4.1.2, FG-4.1.3)', async () => {
    window.spawneaApi = createMockSpawneaApi();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Active Sessions (2)')).toBeDefined();
    });

    // 1. Group by Host (FG-4.1.1)
    fireEvent.click(screen.getByTestId('grouping-mode-host'));
    await waitFor(() => {
      expect(screen.getByText('HOST Groups (2)')).toBeDefined();
      expect(screen.getByTestId('session-group-host-srv-1')).toBeDefined();
      expect(screen.getByTestId('session-group-host-srv-2')).toBeDefined();
    });

    // Verify session cards exist inside host groups
    expect(screen.getByTestId('session-item-sess-1')).toBeDefined();
    expect(screen.getByTestId('session-item-sess-2')).toBeDefined();

    // 2. Group by Project (FG-4.1.2)
    fireEvent.click(screen.getByTestId('grouping-mode-project'));
    await waitFor(() => {
      expect(screen.getByText('PROJECT Groups (2)')).toBeDefined();
      expect(screen.getByTestId('session-group-project-proj-1')).toBeDefined();
      expect(screen.getByTestId('session-group-project-proj-2')).toBeDefined();
    });

    // 3. Group by Harness (FG-4.1.3)
    fireEvent.click(screen.getByTestId('grouping-mode-harness'));
    await waitFor(() => {
      expect(screen.getByText('HARNESS Groups (2)')).toBeDefined();
      expect(screen.getByTestId('session-group-harness-agent-claude')).toBeDefined();
      expect(screen.getByTestId('session-group-harness-agent-codex')).toBeDefined();
    });

    // 4. Switch back to All
    fireEvent.click(screen.getByTestId('grouping-mode-all'));
    await waitFor(() => {
      expect(screen.getByText('Active Sessions (2)')).toBeDefined();
    });
  });

  it('selects active session when clicked from a grouped view (FG-4.1.4, FG-4.1.5)', async () => {
    window.spawneaApi = createMockSpawneaApi();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Active Sessions (2)')).toBeDefined();
    });

    // Group by Project
    fireEvent.click(screen.getByTestId('grouping-mode-project'));
    await waitFor(() => {
      expect(screen.getByTestId('session-group-project-proj-2')).toBeDefined();
    });

    // Click session 2 inside project group
    const session2Card = screen.getByTestId('session-item-sess-2');
    fireEvent.click(session2Card);

    // Verify ContextBar and tabs reflect session 2
    await waitFor(() => {
      expect(screen.getAllByText('feat/quantization').length).toBeGreaterThan(0);
      expect(screen.getAllByText('ML Inference Engine').length).toBeGreaterThan(0);
    });
  });

  it('triggers session reconciliation when clicking the sidebar refresh button (FG-2.4.2)', async () => {
    const reconcileMock = vi.fn().mockResolvedValue(mockSessions);
    window.spawneaApi = createMockSpawneaApi({
      reconcileSessions: reconcileMock,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Active Sessions (2)')).toBeDefined();
    });

    // Open the sidebar actions menu and refresh sessions
    fireEvent.click(screen.getByTestId('sidebar-actions-menu-button'));
    const refreshButton = screen.getByTestId('sidebar-refresh-sessions-button');
    fireEvent.click(refreshButton);

    await waitFor(() => {
      expect(reconcileMock).toHaveBeenCalled();
    });
  });

  it('renders Ctrl-1..0 watermark badges on the first visible sessions', async () => {
    window.spawneaApi = createMockSpawneaApi();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Active Sessions (2)')).toBeDefined();
    });

    // With default alphabetical sorting:
    // 'Feature Auth Session' (sess-1) -> Ctrl-1
    // 'Model Optimization' (sess-2) -> Ctrl-2
    expect(screen.getByTestId('session-shortcut-badge-sess-1').textContent).toBe('Ctrl-1');
    expect(screen.getByTestId('session-shortcut-badge-sess-2').textContent).toBe('Ctrl-2');
  });

  it('switches active session with Ctrl-1..0 and cycles with Ctrl-Tab / Ctrl-Shift-Tab', async () => {
    window.spawneaApi = createMockSpawneaApi();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Active Sessions (2)')).toBeDefined();
    });

    // Initial active session is sess-1 (feat/jwt-auth)
    expect(screen.getAllByText('feat/jwt-auth').length).toBeGreaterThan(0);

    // 1. Press Ctrl+2 to switch to session 2 (feat/quantization)
    fireEvent.keyDown(window, { key: '2', ctrlKey: true });
    await waitFor(() => {
      expect(screen.getAllByText('feat/quantization').length).toBeGreaterThan(0);
    });

    // 2. Press Ctrl+1 to switch back to session 1 (feat/jwt-auth)
    fireEvent.keyDown(window, { key: '1', ctrlKey: true });
    await waitFor(() => {
      expect(screen.getAllByText('feat/jwt-auth').length).toBeGreaterThan(0);
    });

    // 3. Press Ctrl+Tab to cycle to next session (sess-2)
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true });
    await waitFor(() => {
      expect(screen.getAllByText('feat/quantization').length).toBeGreaterThan(0);
    });

    // 4. Press Ctrl+Shift+Tab to cycle to previous session (sess-1)
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true, shiftKey: true });
    await waitFor(() => {
      expect(screen.getAllByText('feat/jwt-auth').length).toBeGreaterThan(0);
    });
  });

  it('collapses sidebar to icon mode and renders hover popup cards for sessions', async () => {
    window.spawneaApi = createMockSpawneaApi();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Active Sessions (2)')).toBeDefined();
    });

    // 1. Click toggle collapse button to collapse sidebar
    const collapseButton = screen.getByTestId('sidebar-toggle-collapse');
    expect(collapseButton.getAttribute('title')).toBe('Collapse sidebar (Ctrl+Shift+B)');
    fireEvent.click(collapseButton);

    // Sidebar text is collapsed, compact session icon buttons are shown
    await waitFor(() => {
      expect(screen.queryByText('Active Sessions (2)')).toBeNull();
      expect(screen.getByTestId('session-compact-item-sess-1')).toBeDefined();
      expect(screen.getByTestId('session-compact-item-sess-2')).toBeDefined();
    });

    // Verify expand button tooltip
    const expandButton = screen.getByTestId('sidebar-toggle-collapse');
    expect(expandButton.getAttribute('title')).toBe('Expand sidebar (Ctrl+Shift+B)');

    // Verify hover popup card contains session details
    const popup1 = screen.getByTestId('session-popup-sess-1');
    expect(popup1).toBeDefined();
    expect(popup1.textContent).toContain('Feature Auth Session');
    expect(popup1.textContent).toContain('feat/jwt-auth');

    // 2. Click compact session 2 icon to switch active session
    const compactItem2 = screen.getByTestId('session-compact-item-sess-2');
    const button2 = compactItem2.querySelector('button')!;
    fireEvent.click(button2);

    await waitFor(() => {
      expect(screen.getAllByText('feat/quantization').length).toBeGreaterThan(0);
    });

    // 3. Expand sidebar back using Ctrl+Shift+B shortcut
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true, shiftKey: true });

    await waitFor(() => {
      expect(screen.getByText('Active Sessions (2)')).toBeDefined();
    });

    // 4. Collapse sidebar again using Ctrl+Shift+B shortcut
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true, shiftKey: true });

    await waitFor(() => {
      expect(screen.queryByText('Active Sessions (2)')).toBeNull();
      expect(screen.getByTestId('session-compact-item-sess-1')).toBeDefined();
    });
  });

  it('displays Session Entity Details and Host System Environment telemetry with copy-to-clipboard actions', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    const mockApi = createMockSpawneaApi();
    window.spawneaApi = mockApi;

    render(<App />);

    await waitFor(() => {
      expect(screen.getAllByText('Feature Auth Session').length).toBeGreaterThan(0);
      expect(screen.getByTestId('workspace-tab-details')).toBeDefined();
    });

    // Switch to "Session Info" tab
    const sessionInfoTab = screen.getByTestId('workspace-tab-details');
    fireEvent.click(sessionInfoTab);

    // Verify Session Entity Details cards
    await waitFor(() => {
      expect(screen.getByText('Session Entity Details')).toBeDefined();
      expect(screen.getByText('Host System Environment')).toBeDefined();
      expect(screen.getAllByText('Ubuntu 22.04.4 LTS').length).toBeGreaterThan(0);
      expect(screen.getByText('Linux 6.8.0-generic x86_64')).toBeDefined();
      expect(screen.getByText('13th Gen Intel(R) Core(TM) i5-1340P (16 cores)')).toBeDefined();
      expect(screen.getByText('15.4 GB')).toBeDefined();
    });

    // Click copy button on Session ID
    const copySessionIdBtn = screen.getByTestId('copy-session-id-button');
    fireEvent.click(copySessionIdBtn);
    expect(writeTextMock).toHaveBeenCalledWith('sess-1');

    // Click copy button on Operating System
    const copyOsBtn = screen.getByTestId('copy-host-os-button');
    fireEvent.click(copyOsBtn);
    expect(writeTextMock).toHaveBeenCalledWith('Ubuntu 22.04.4 LTS');
  });

  it('filters sessions using attention filter chips (All, Attention, Working, Idle/Done, Offline) (Task 2.3.1, Task 2.3.2)', async () => {
    const multiStateSessions: Session[] = [
      { ...mockSessions[0], id: 'sess-work', name: 'Work Session', status: 'working' },
      { ...mockSessions[1], id: 'sess-input', name: 'Prompt Waiting Session', status: 'needs_input' },
      { ...mockSessions[0], id: 'sess-done', name: 'Finished Session', status: 'done' },
      { ...mockSessions[0], id: 'sess-off', name: 'Offline Session', status: 'disconnected' },
    ];

    window.spawneaApi = createMockSpawneaApi({
      listSessions: vi.fn().mockResolvedValue(multiStateSessions),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('status-filter-all')).toBeDefined();
    });

    // 1. Verify All filter shows all 4 sessions
    expect(screen.getByTestId('session-item-sess-work')).toBeDefined();
    expect(screen.getByTestId('session-item-sess-input')).toBeDefined();
    expect(screen.getByTestId('session-item-sess-done')).toBeDefined();
    expect(screen.getByTestId('session-item-sess-off')).toBeDefined();

    // 2. Click Needs Attention chip -> only Prompt Waiting Session is displayed
    fireEvent.click(screen.getByTestId('status-filter-needs_attention'));
    await waitFor(() => {
      expect(screen.getByTestId('session-item-sess-input')).toBeDefined();
      expect(screen.queryByTestId('session-item-sess-work')).toBeNull();
      expect(screen.queryByTestId('session-item-sess-done')).toBeNull();
      expect(screen.queryByTestId('session-item-sess-off')).toBeNull();
    });

    // 3. Click Working chip -> only Work Session is displayed
    fireEvent.click(screen.getByTestId('status-filter-working'));
    await waitFor(() => {
      expect(screen.getByTestId('session-item-sess-work')).toBeDefined();
      expect(screen.queryByTestId('session-item-sess-input')).toBeNull();
    });

    // 4. Click Idle/Done chip -> only Finished Session is displayed
    fireEvent.click(screen.getByTestId('status-filter-idle_done'));
    await waitFor(() => {
      expect(screen.getByTestId('session-item-sess-done')).toBeDefined();
      expect(screen.queryByTestId('session-item-sess-work')).toBeNull();
    });

    // 5. Click Offline chip -> only Offline Session is displayed
    fireEvent.click(screen.getByTestId('status-filter-disconnected'));
    await waitFor(() => {
      expect(screen.getByTestId('session-item-sess-off')).toBeDefined();
      expect(screen.queryByTestId('session-item-sess-work')).toBeNull();
    });
  });

  it('renders top prioritized Needs Attention section and prompt snippet preview (Task 2.2.1, Task 2.2.2)', async () => {
    let statusCb: (sessionId: string, status: SessionStatus, result?: any) => void = () => {};

    window.spawneaApi = createMockSpawneaApi({
      onStatusChanged: (cb) => {
        statusCb = cb;
        return () => {};
      },
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getAllByText('Model Optimization').length).toBeGreaterThan(0);
    });

    // Session 2 is in needs_input -> Attention filter button shows count 1
    const attentionFilter = screen.getByTestId('status-filter-needs_attention');
    expect(attentionFilter).toBeDefined();
    expect(attentionFilter.textContent).toContain('1');

    // Emit live status update with prompt snippet for sess-2
    statusCb('sess-2', 'needs_input', {
      status: 'needs_input',
      confidence: 0.85,
      source: 'terminal_prompt',
      detectedPrompt: 'Do you want to run `cargo test`? [y/N]',
      reason: 'Interactive terminal prompt',
      updatedAt: new Date(),
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('session-prompt-snippet-sess-2').length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Do you want to run `cargo test`\? \[y\/N\]/).length).toBeGreaterThan(0);
    });
  });

  it('sorts sessions alphabetically by default (A-Z)', async () => {
    const sortTestSessions: Session[] = [
      { ...mockSessions[0], id: 'sess-c', name: 'C Done', status: 'done', lastActivityAt: new Date('2026-01-01') },
      { ...mockSessions[0], id: 'sess-a', name: 'A Input', status: 'needs_input', lastActivityAt: new Date('2026-01-02') },
      { ...mockSessions[0], id: 'sess-b', name: 'B Work', status: 'working', lastActivityAt: new Date('2026-01-03') },
    ];

    window.spawneaApi = createMockSpawneaApi({
      listSessions: vi.fn().mockResolvedValue(sortTestSessions),
      reconcileSessions: vi.fn().mockResolvedValue(sortTestSessions),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getAllByText('A Input').length).toBeGreaterThan(0);
      expect(screen.getAllByText('B Work').length).toBeGreaterThan(0);
      expect(screen.getAllByText('C Done').length).toBeGreaterThan(0);
    });

    // Check that session items are rendered in alphabetical order
    const sessionCards = screen.getAllByTestId(/session-item-sess-/);
    expect(sessionCards[0].getAttribute('data-testid')).toBe('session-item-sess-a');
    expect(sessionCards[1].getAttribute('data-testid')).toBe('session-item-sess-b');
    expect(sessionCards[2].getAttribute('data-testid')).toBe('session-item-sess-c');
  });

  it('opens state feedback modal when feedback button in ContextBar is clicked (FG-4.2.5)', async () => {
    window.spawneaApi = createMockSpawneaApi();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('session-feedback-button')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('session-feedback-button'));

    await waitFor(() => {
      expect(screen.getByTestId('state-feedback-modal')).toBeDefined();
      expect(screen.getByText('Report State Detection Feedback')).toBeDefined();
    });
  });

  it('opens Quick Switcher with Ctrl+P / Cmd+P / header button and navigates with keyboard (Task 3.1)', async () => {
    window.spawneaApi = createMockSpawneaApi();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Active Sessions (2)')).toBeDefined();
      expect(screen.getByTestId('header-quick-switcher-button')).toBeDefined();
    });

    // 1. Initial state: quick switcher is closed
    expect(screen.queryByTestId('quick-switcher-modal')).toBeNull();

    // 2. Press Ctrl+P to open Quick Switcher
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true });
    await waitFor(() => {
      expect(screen.getByTestId('quick-switcher-modal')).toBeDefined();
      expect(screen.getByTestId('quick-switcher-input')).toBeDefined();
    });
    expect(screen.queryByText('Report State Feedback')).toBeNull();

    // 3. Type query in quick switcher to filter sessions
    const input = screen.getByTestId('quick-switcher-input');
    fireEvent.change(input, { target: { value: 'Model' } });
    expect(screen.getByTestId('quick-switcher-item-session-sess-2')).toBeDefined();
    expect(screen.queryByTestId('quick-switcher-item-session-sess-1')).toBeNull();

    // 4. Press Enter to select the filtered session
    fireEvent.keyDown(input, { key: 'Enter' });

    // Modal closes and active session switches to sess-2 (Model Optimization / feat/quantization)
    await waitFor(() => {
      expect(screen.queryByTestId('quick-switcher-modal')).toBeNull();
      expect(screen.getAllByText('feat/quantization').length).toBeGreaterThan(0);
    });

    // 5. Open again via header button
    fireEvent.click(screen.getByTestId('header-quick-switcher-button'));
    await waitFor(() => {
      expect(screen.getByTestId('quick-switcher-modal')).toBeDefined();
    });

    // 6. Close via Escape
    const input2 = screen.getByTestId('quick-switcher-input');
    fireEvent.keyDown(input2, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('quick-switcher-modal')).toBeNull();
    });
  });

  it('navigates workspace tabs using Alt+1 through Alt+5 keyboard shortcuts (Task 3.2)', async () => {
    window.spawneaApi = createMockSpawneaApi({
      listFiles: vi.fn().mockResolvedValue([
        { name: 'main.py', path: 'main.py', isDirectory: false, isFile: true, size: 1024, modifiedAt: new Date() },
      ]),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Active Sessions (2)')).toBeDefined();
    });

    // Default tab is terminal
    expect(screen.getByTestId('workspace-tab-terminal')).toBeDefined();

    // 1. Press Alt+2 -> Switch to Files tab
    fireEvent.keyDown(window, { key: '2', altKey: true });
    await waitFor(() => {
      expect(screen.getByTestId('file-browser')).toBeDefined();
    });

    // 2. Press Alt+3 -> Switch to Git Diff tab
    fireEvent.keyDown(window, { key: '3', altKey: true });
    await waitFor(() => {
      expect(screen.getByTestId('workspace-tab-diff')).toBeDefined();
    });

    // 3. Press Alt+4 -> Switch to Artifacts tab
    fireEvent.keyDown(window, { key: '4', altKey: true });
    await waitFor(() => {
      expect(screen.getByTestId('filter-artifacts-all')).toBeDefined();
    });

    // 4. Press Alt+5 -> Switch to Session Info tab
    fireEvent.keyDown(window, { key: '5', altKey: true });
    await waitFor(() => {
      expect(screen.getByText('Session Entity Details')).toBeDefined();
    });

    // 5. Press Alt+1 -> Switch back to Terminal tab
    fireEvent.keyDown(window, { key: '1', altKey: true });
    await waitFor(() => {
      expect(screen.getByTestId('xterm-container')).toBeDefined();
    });
  });

  it('persists active tab per session and restores when switching sessions (Task 3.3)', async () => {
    window.spawneaApi = createMockSpawneaApi();

    render(<App />);

    await waitFor(() => {
      expect(screen.getAllByText('Feature Auth Session').length).toBeGreaterThan(0);
    });

    // Active session is sess-1. Switch sess-1 to Files tab
    fireEvent.click(screen.getByTestId('workspace-tab-files'));
    await waitFor(() => {
      expect(screen.getByTestId('file-browser')).toBeDefined();
    });

    // Verify localStorage has saved tab for sess-1
    expect(localStorage.getItem('spawnea:sessionTab:sess-1')).toBe('files');

    // Switch active session to sess-2 (Model Optimization)
    fireEvent.click(screen.getByTestId('session-item-sess-2'));

    // sess-2 should default to terminal tab (or its own saved tab)
    await waitFor(() => {
      expect(screen.getAllByText('feat/quantization').length).toBeGreaterThan(0);
      expect(screen.getByTestId('xterm-container')).toBeDefined();
    });

    // Switch sess-2 to Artifacts tab
    fireEvent.click(screen.getByTestId('workspace-tab-artifacts'));
    await waitFor(() => {
      expect(screen.getByTestId('filter-artifacts-all')).toBeDefined();
    });
    expect(localStorage.getItem('spawnea:sessionTab:sess-2')).toBe('artifacts');

    // Switch back to sess-1 -> should restore Files tab!
    fireEvent.click(screen.getByTestId('session-item-sess-1'));
    await waitFor(() => {
      expect(screen.getAllByText('feat/jwt-auth').length).toBeGreaterThan(0);
      expect(screen.getByTestId('file-browser')).toBeDefined();
    });
  });

  it('persists sidebar collapsed state in localStorage across restarts (Task 3.3)', async () => {
    // Pre-populate localStorage with collapsed = true
    localStorage.setItem('spawnea:sidebar:collapsed', 'true');

    window.spawneaApi = createMockSpawneaApi();

    render(<App />);

    // App should start in collapsed mode
    await waitFor(() => {
      expect(screen.queryByText('Active Sessions (2)')).toBeNull();
      expect(screen.getByTestId('session-compact-item-sess-1')).toBeDefined();
    });

    // Expand sidebar with Ctrl+Shift+B
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true, shiftKey: true });

    await waitFor(() => {
      expect(screen.getByText('Active Sessions (2)')).toBeDefined();
    });

    // Verify localStorage was updated to 'false'
    expect(localStorage.getItem('spawnea:sidebar:collapsed')).toBe('false');
  });

  it('opens Adopt Session modal, discovers sessions, and adopts an external tmux session (FG-7.2.1, FG-7.2.2)', async () => {
    const mockAdopt = vi.fn().mockResolvedValue({
      id: 'sess-adopted-123',
      name: 'external-cli-agent',
      serverId: 'srv-1',
      projectId: 'proj-1',
      agentId: 'agent-claude',
      task: 'external-cli-agent',
      worktreePath: '/srv/code/backend-api',
      branch: 'main',
      tmuxSessionName: 'external-cli-agent',
      status: 'working',
      isExternal: true,
      createdAt: new Date(),
      lastActivityAt: new Date(),
    });

    const mockDiscover = vi.fn().mockResolvedValue([
      {
        sessionName: 'external-cli-agent',
        windowsCount: 1,
        createdAt: new Date(),
        panePid: 4200,
        currentCommand: 'claude',
        currentPath: '/srv/code/backend-api',
      },
    ]);

    window.spawneaApi = createMockSpawneaApi({
      adoptSession: mockAdopt,
      discoverExternalSessions: mockDiscover,
    });

    render(<App />);

    fireEvent.click(screen.getByTestId('sidebar-actions-menu-button'));
    expect(screen.getByTestId('sidebar-adopt-session-button')).toBeDefined();

    // Click Adopt button in Sidebar
    fireEvent.click(screen.getByTestId('sidebar-adopt-session-button'));

    // Verify modal is open and shows discovered session
    await waitFor(() => {
      expect(screen.getByText('Discover & Adopt External tmux Sessions')).toBeDefined();
      expect(screen.getByText('external-cli-agent')).toBeDefined();
    });

    // Select discovered session and submit
    fireEvent.click(screen.getByTestId('discovered-session-external-cli-agent'));
    fireEvent.click(screen.getByTestId('submit-adopt-session'));

    await waitFor(() => {
      expect(mockAdopt).toHaveBeenCalledWith(
        expect.objectContaining({
          serverId: 'srv-1',
          tmuxSessionName: 'external-cli-agent',
        })
      );
      // New adopted session is active and displays EXT badge
      expect(screen.getByTestId('session-external-badge-sess-adopted-123')).toBeDefined();
      expect(screen.getByTestId('contextbar-external-badge')).toBeDefined();
    });
  });

  it('releases an adopted session non-destructively via ContextBar Release button (FG-7.2.3)', async () => {
    const mockUnadopt = vi.fn().mockResolvedValue(true);

    const externalSession: Session = {
      id: 'sess-ext-1',
      name: 'External Terminal Session',
      serverId: 'srv-1',
      projectId: 'proj-1',
      agentId: 'agent-terminal',
      task: 'External Terminal Session',
      worktreePath: '/srv/code/backend-api',
      branch: 'main',
      tmuxSessionName: 'custom-terminal',
      status: 'working',
      isExternal: true,
      createdAt: new Date(),
      lastActivityAt: new Date(),
    };

    window.spawneaApi = createMockSpawneaApi({
      listSessions: vi.fn().mockResolvedValue([externalSession]),
      unadoptSession: mockUnadopt,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('session-external-badge-sess-ext-1')).toBeDefined();
      expect(screen.getByTestId('session-unadopt-button')).toBeDefined();
    });

    // Click Release button in ContextBar
    fireEvent.click(screen.getByTestId('session-unadopt-button'));

    // Verify unadopt confirmation modal opens
    await waitFor(() => {
      expect(screen.getByText('Release / Un-adopt Session')).toBeDefined();
      expect(screen.getByText('Non-Destructive Release')).toBeDefined();
    });

    // Confirm release
    fireEvent.click(screen.getByTestId('unadopt-modal-confirm'));

    await waitFor(() => {
      expect(mockUnadopt).toHaveBeenCalledWith('sess-ext-1');
    });
  });
});
