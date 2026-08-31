import { describe, it, expect } from 'vitest';
import {
  parseSessionContextFile,
  serializeSessionContextFile,
  validateSessionContext,
  type SessionContextFile,
} from '../src/session-context.js';

describe('SessionContextFile', () => {
  const validContext: SessionContextFile = {
    version: 1,
    sessionId: 'sess-test-123',
    sessionName: 'Test Session',
    task: 'Implement authentication',
    host: {
      id: 'dev-workstation',
      name: 'Development Workstation',
      ssh: {
        target: 'example-host',
        user: 'developer',
        port: 22,
      },
    },
    project: {
      id: 'spawnea',
      name: 'Spawnea',
      path: '/workspace/spawnea',
      git_url: 'https://github.com/example/Spawnea.git',
    },
    worktree: {
      managed: true,
      path: '/workspace/spawnea-worktrees/auth-flow',
      branch: 'spawnea/auth-flow',
      baseBranch: 'main',
      baseCommit: '0123456789abcdef0123456789abcdef01234567',
    },
    harness: {
      id: 'claude',
      name: 'Claude Code',
      command: 'claude',
      args: ['--dangerously-skip-permissions'],
    },
    persistentSession: {
      type: 'tmux',
      name: 'spawnea-auth-flow',
      window: 'spawnea-auth-flow:0',
    },
    reconnectTarget: {
      type: 'tmux',
      name: 'spawnea-auth-flow',
      hostId: 'dev-workstation',
    },
    status: 'working',
    creationSource: 'mcp',
    createdAt: '2026-08-23T10:00:00.000Z',
    updatedAt: '2026-08-23T10:00:00.000Z',
  };

  it('validates a correct session context object', () => {
    const result = validateSessionContext(validContext);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.context.sessionId).toBe('sess-test-123');
      expect(result.context.host.id).toBe('dev-workstation');
      expect(result.context.project.path).toBe('/workspace/spawnea');
      expect(result.context.worktree?.baseBranch).toBe('main');
      expect(result.context.worktree?.baseCommit).toBe('0123456789abcdef0123456789abcdef01234567');
      expect(result.context.persistentSession.name).toBe('spawnea-auth-flow');
      expect(result.context.creationSource).toBe('mcp');
    }
  });

  it('accepts legacy managed-worktree contexts without a base commit', () => {
    const legacyContext = structuredClone(validContext);
    delete legacyContext.worktree?.baseCommit;

    expect(validateSessionContext(legacyContext).success).toBe(true);
  });

  it('accepts legacy contexts without a creation source', () => {
    const legacyContext = structuredClone(validContext);
    delete legacyContext.creationSource;

    expect(validateSessionContext(legacyContext).success).toBe(true);
  });

  it('serializes and parses back to identical object', () => {
    const json = serializeSessionContextFile(validContext);
    const parseResult = parseSessionContextFile(json);
    expect(parseResult.success).toBe(true);
    if (parseResult.success) {
      expect(parseResult.context).toEqual(validContext);
    }
  });

  it('rejects invalid context with missing required fields', () => {
    const invalid = {
      version: 1,
      sessionId: 'sess-123',
      // missing host, project, harness, etc.
    };
    const result = validateSessionContext(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects invalid JSON string', () => {
    const result = parseSessionContextFile('{ invalid json');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0].path).toBe('json');
    }
  });

  it('rejects empty string', () => {
    const result = parseSessionContextFile('');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0].path).toBe('root');
    }
  });
});
