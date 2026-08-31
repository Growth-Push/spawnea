import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, createRepositories, type Repositories } from '@spawnea/db';
import { MockHostAdapter } from '@spawnea/hosts';
import type { StateFeedbackReport } from '@spawnea/domain';
import { CatalogManager } from './catalog-manager.js';
import { SessionContextStore } from './session-context-store.js';
import { PtyBroker } from './pty-broker.js';
import { SessionManager } from './session-manager.js';
import { SessionSupervisor } from './session-supervisor.js';

describe('SessionSupervisor - State Feedback & Misclassification Reporting', () => {
  let tempDir: string;
  let feedbackDir: string;
  let repos: Repositories;
  let dbConn: ReturnType<typeof createDatabase>;
  let catManager: CatalogManager;
  let contextStore: SessionContextStore;
  let ptyBroker: PtyBroker;
  let sessionManager: SessionManager;
  let supervisor: SessionSupervisor;
  let mockHost: MockHostAdapter;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'spawnea-feedback-test-'));
    feedbackDir = join(tempDir, 'feedback');
    dbConn = createDatabase({ path: ':memory:', migrate: true });
    repos = createRepositories(dbConn.db);
    catManager = new CatalogManager();
    contextStore = new SessionContextStore({ storeDir: join(tempDir, 'sessions') });
    ptyBroker = new PtyBroker();
    mockHost = new MockHostAdapter('dev-workstation', ['/workspace/spawnea']);

    await repos.servers.save({
      id: 'dev-workstation',
      name: 'Development Workstation',
      host: 'example-host',
      sshPort: 22,
      enabled: true,
    });

    await repos.projects.save({
      id: 'dev-workstation:spawnea',
      serverId: 'dev-workstation',
      name: 'Spawnea',
      rootPath: '/workspace/spawnea',
    });

    await repos.agents.save({
      id: 'dev-workstation:claude',
      name: 'Claude Code',
      harness: 'claude',
      command: 'claude',
    });

    sessionManager = new SessionManager({
      repositories: repos,
      catalogManager: catManager,
      contextStore,
      ptyBroker,
      hostAdapterFactory: async (_serverId) => mockHost,
    });

    supervisor = new SessionSupervisor({
      repositories: repos,
      sessionManager,
      contextStore,
      ptyBroker,
    });
  });

  afterEach(async () => {
    supervisor.stopPolling();
    dbConn.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('captures a full feedback snapshot with tail lines and detected state', async () => {
    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Test feedback snapshot',
    });

    mockHost.customRules.push(
      {
        pattern: 'tmux list-panes -t',
        response: {
          stdout: '%0:1234:0:claude\n',
          stderr: '',
          exitCode: 0,
        },
      },
      {
        pattern: 'tmux capture-pane -p -t',
        response: {
          stdout: 'Reading project structure...\nGenerating solution...\nConfirm changes? [y/N] \n',
          stderr: '',
          exitCode: 0,
        },
      }
    );

    const snapshot = await supervisor.captureFeedbackSnapshot(session.id);

    expect(snapshot.sessionId).toBe(session.id);
    expect(snapshot.sessionName).toBe(session.name);
    expect(snapshot.harness).toBe('claude');
    expect(snapshot.worktreePath).toBe(session.worktreePath);
    expect(snapshot.branch).toBe(session.branch);
    expect(snapshot.detectedStatus).toBe('needs_input');
    expect(snapshot.detectedPrompt).toBeDefined();
    expect(snapshot.tailLines.length).toBeGreaterThan(0);
    expect(snapshot.capturedAt).toBeDefined();
  });

  it('throws error when capturing feedback snapshot for non-existent session', async () => {
    await expect(supervisor.captureFeedbackSnapshot('non-existent-id')).rejects.toThrow(
      "Session 'non-existent-id' not found"
    );
  });

  it('saves feedback report as JSON test fixture under feedback directory', async () => {
    const report: StateFeedbackReport = {
      sessionId: 'sess-test-123',
      sessionName: 'Fix parser bug',
      harness: 'claude',
      worktreePath: '/workspace/spawnea',
      branch: 'fix/parser',
      detectedStatus: 'idle',
      detectedSource: 'terminal_prompt',
      detectedConfidence: 0.75,
      detectionReason: 'Prompt ready',
      expectedStatus: 'needs_input',
      userNotes: 'Claude was waiting for user confirmation but was classified as idle.',
      tailLines: ['Review changes:', 'Option 1: Apply', 'Option 2: Discard', 'Choice [1-2]: '],
      timestamp: new Date().toISOString(),
    };

    const result = await supervisor.saveFeedbackReport(report, feedbackDir);

    expect(result.success).toBe(true);
    expect(result.filePath).toContain('state-feedback-sess-test-123-');
    expect(result.filePath.endsWith('.json')).toBe(true);
    expect(existsSync(result.filePath)).toBe(true);

    const savedContent = JSON.parse(readFileSync(result.filePath, 'utf-8'));
    expect(savedContent.sessionId).toBe(report.sessionId);
    expect(savedContent.detectedStatus).toBe('idle');
    expect(savedContent.expectedStatus).toBe('needs_input');
    expect(savedContent.userNotes).toBe(report.userNotes);
    expect(savedContent.tailLines).toEqual(report.tailLines);

    // Fixture JSON matches formatted payload
    expect(JSON.parse(result.fixtureJson)).toEqual(savedContent);
  });
});
