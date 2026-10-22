import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  statSync,
  mkdirSync,
  chmodSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, createRepositories, type Repositories } from '@spawnea/db';
import { MockHostAdapter } from '@spawnea/hosts';
import { loadStateRules, StateDetector } from '@spawnea/state';
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
    vi.restoreAllMocks();
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
    expect(snapshot.capture).toEqual({ status: 'captured' });
    expect(snapshot.detectedStatus).toBe('needs_input');
    expect(snapshot.detectedPrompt).toBeDefined();
    expect(snapshot.decision).toMatchObject({ kind: 'rule', rule: { file: 'factory', harness: 'claude' } });
    expect(snapshot.rulesConfig).toEqual({ source: 'factory' });
    expect(snapshot.tailLines.length).toBeGreaterThan(0);
    expect(snapshot.capturedAt).toBeDefined();
  });

  it('throws error when capturing feedback snapshot for non-existent session', async () => {
    await expect(supervisor.captureFeedbackSnapshot('non-existent-id')).rejects.toThrow(
      "Session 'non-existent-id' not found"
    );
  });

  it('saves feedback report as JSON test fixture under feedback directory', async () => {
    mkdirSync(feedbackDir, { recursive: true, mode: 0o755 });
    chmodSync(feedbackDir, 0o755);
    const report: StateFeedbackReport = {
      sessionId: 'sess-test-123',
      sessionName: 'Fix parser bug',
      harness: 'claude',
      worktreePath: '/workspace/spawnea',
      branch: 'fix/parser',
      observedStatus: 'idle',
      capture: { status: 'captured' },
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
    if (process.platform !== 'win32') {
      expect(statSync(result.filePath).mode & 0o777).toBe(0o600);
      expect(statSync(feedbackDir).mode & 0o777).toBe(0o700);
    }
    expect(result.filePath.endsWith('.json')).toBe(true);
    expect(existsSync(result.filePath)).toBe(true);

    const savedContent = JSON.parse(readFileSync(result.filePath, 'utf-8'));
    expect(savedContent.sessionId).toBe(report.sessionId);
    expect(savedContent.schemaVersion).toBe('2.0.0');
    expect(savedContent.observedStatus).toBe('idle');
    expect(savedContent.detectedStatus).toBe('idle');
    expect(savedContent.rulesConfig).toEqual({ source: 'factory' });
    expect(savedContent.expectedStatus).toBe('needs_input');
    expect(savedContent.userNotes).toBe(report.userNotes);
    expect(savedContent.tailLines).toEqual(report.tailLines);

    // Fixture JSON matches formatted payload
    expect(JSON.parse(result.fixtureJson)).toEqual(savedContent);
  });

  it('does not overwrite an existing feedback report with the same generated name', async () => {
    mkdirSync(feedbackDir, { recursive: true, mode: 0o700 });
    const timestamp = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(timestamp);
    const existingPath = join(feedbackDir, `state-feedback-sess-test-123-${timestamp}.json`);
    writeFileSync(existingPath, 'existing report', { mode: 0o644 });

    await expect(supervisor.saveFeedbackReport({
      sessionId: 'sess-test-123',
      sessionName: 'Existing report collision',
      harness: 'claude',
      worktreePath: '/workspace/spawnea',
      branch: 'fix/parser',
      observedStatus: 'idle',
      capture: { status: 'captured' },
      detectedStatus: 'idle',
      detectedSource: 'terminal_prompt',
      detectedConfidence: 0.75,
      detectionReason: 'Prompt ready',
      expectedStatus: 'needs_input',
      tailLines: ['sensitive terminal content'],
      timestamp: new Date().toISOString(),
    }, feedbackDir)).rejects.toMatchObject({ code: 'EEXIST' });

    expect(readFileSync(existingPath, 'utf8')).toBe('existing report');
  });
  describe('decision and rules configuration', () => {
    const userDir = () => join(tempDir, 'user-data');

    function useStateRules(yaml: string): void {
      const { ruleSet } = loadStateRules({
        userFilePath: join(userDir(), 'state-rules.yaml'),
        readFile: () => yaml,
      });
      supervisor = new SessionSupervisor({
        repositories: repos,
        sessionManager,
        contextStore,
        ptyBroker,
        stateDetector: new StateDetector({ rules: ruleSet }),
      });
    }

    async function createClaudeSession() {
      return sessionManager.createSession({
        serverId: 'dev-workstation',
        projectId: 'dev-workstation:spawnea',
        agentId: 'dev-workstation:claude',
        task: 'Decision snapshot',
      });
    }

    function mockPane(tail: string): void {
      mockHost.customRules.push(
        { pattern: 'tmux list-panes -t', response: { stdout: '%0:1234:0:claude\n', stderr: '', exitCode: 0 } },
        { pattern: 'tmux capture-pane -p -t', response: { stdout: tail, stderr: '', exitCode: 0 } }
      );
    }

    it('reports the activity fallback when no rule matches', async () => {
      const session = await createClaudeSession();
      mockPane('Reading project structure...\nPlanning the change\n');

      const snapshot = await supervisor.captureFeedbackSnapshot(session.id);

      expect(snapshot.decision).toEqual({ kind: 'fallback' });
      expect(snapshot.detectedStatus).toBe('idle');
    });

    it('reports the connection step when the tmux session has ended', async () => {
      const session = await createClaudeSession();
      mockHost.customRules.push({
        pattern: 'tmux has-session -t',
        response: { stdout: '', stderr: 'no server', exitCode: 1 },
      });

      const snapshot = await supervisor.captureFeedbackSnapshot(session.id);

      expect(snapshot.capture).toEqual({ status: 'captured' });
      expect(snapshot.detectedStatus).toBe('done');
      expect(snapshot.decision).toEqual({ kind: 'connection' });
    });

    it('reports a winning user rule and the merged configuration', async () => {
      useStateRules([
        'harnesses:',
        '  claude:',
        '    rules:',
        '      - state: working',
        '        patterns:',
        "          - 'Confirm changes\\?'",
      ].join('\n'));
      const session = await createClaudeSession();
      mockPane('Generating solution...\nConfirm changes? [y/N] \n');

      const snapshot = await supervisor.captureFeedbackSnapshot(session.id);

      expect(snapshot.detectedStatus).toBe('working');
      expect(snapshot.decision).toEqual({ kind: 'rule', rule: { file: 'user', harness: 'claude', position: 1 } });
      expect(snapshot.rulesConfig).toEqual({ source: 'merged' });
    });

    it('does not invent a status, source, confidence, or decision when the capture fails', async () => {
      const session = await createClaudeSession();
      vi.spyOn(sessionManager, 'getHostAdapter').mockRejectedValue(new Error('ssh: connect to host example-host port 22: refused'));

      const snapshot = await supervisor.captureFeedbackSnapshot(session.id);

      expect(snapshot.capture).toEqual({ status: 'failed', reason: 'Host or tmux communication failed during capture' });
      expect(snapshot.detectedStatus).toBeUndefined();
      expect(snapshot.source).toBeUndefined();
      expect(snapshot.confidence).toBeUndefined();
      expect(snapshot.reason).toBeUndefined();
      expect(snapshot.decision).toBeUndefined();
      expect(snapshot.tailLines).toEqual([]);
      expect(snapshot.rulesConfig).toEqual({ source: 'factory' });
      expect(JSON.stringify(snapshot)).not.toContain('example-host');
    });

    it('saves a failed capture without detection fields, even if the renderer sent some', async () => {
      const result = await supervisor.saveFeedbackReport({
        sessionId: 'sess-failed',
        sessionName: 'Failed capture',
        harness: 'claude',
        observedStatus: 'working',
        capture: { status: 'failed', reason: 'Host or tmux communication failed during capture' },
        detectedStatus: 'idle',
        detectedSource: 'tmux',
        detectedConfidence: 0.7,
        detectionReason: 'guessed',
        decision: { kind: 'fallback' },
        expectedStatus: 'needs_input',
        tailLines: ['stale terminal text'],
        timestamp: new Date().toISOString(),
      }, feedbackDir);

      const saved = JSON.parse(readFileSync(result.filePath, 'utf-8'));
      expect(saved.capture).toEqual({ status: 'failed', reason: 'Host or tmux communication failed during capture' });
      expect(saved.observedStatus).toBe('working');
      expect(saved.expectedStatus).toBe('needs_input');
      for (const key of ['detectedStatus', 'detectedSource', 'detectedConfidence', 'detectionReason', 'decision']) {
        expect(saved).not.toHaveProperty(key);
      }
      expect(saved.tailLines).toEqual([]);
    });

    it('stamps its own rules configuration and keeps only the invalid file location', async () => {
      useStateRules([
        'harnesses:',
        '  claude:',
        '    rules:',
        '      - state: working',
        '        patterns: [\'secret-pattern-(\']',
      ].join('\n'));

      const report = {
        sessionId: 'sess-invalid',
        sessionName: 'Invalid user rules',
        harness: 'claude',
        observedStatus: 'idle',
        capture: { status: 'captured' },
        detectedStatus: 'idle',
        detectedSource: 'terminal_prompt',
        detectedConfidence: 0.9,
        detectionReason: 'Claude: idle by factory rule claude #6: >',
        decision: { kind: 'rule', rule: { file: 'factory', harness: 'claude', position: 6, pattern: 'leak' } },
        rulesConfig: { source: 'merged' },
        userFilePath: join(userDir(), 'state-rules.yaml'),
        expectedStatus: 'needs_input',
        tailLines: ['>'],
        timestamp: new Date().toISOString(),
      } as unknown as StateFeedbackReport;

      const result = await supervisor.saveFeedbackReport(report, feedbackDir);
      const saved = JSON.parse(readFileSync(result.filePath, 'utf-8'));

      expect(saved.rulesConfig).toEqual({
        source: 'user_invalid',
        error: { file: 'state-rules.yaml', harness: 'claude', position: 1, line: expect.any(Number) },
      });
      expect(saved.decision).toEqual({ kind: 'rule', rule: { file: 'factory', harness: 'claude', position: 6 } });
      expect(saved).not.toHaveProperty('userFilePath');
      expect(result.fixtureJson).not.toContain('secret-pattern');
      expect(result.fixtureJson).not.toContain(userDir());
      expect(result.fixtureJson).not.toContain('leak');
    });
  });
});
