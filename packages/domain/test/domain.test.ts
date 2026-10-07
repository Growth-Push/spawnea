import { describe, it, expect } from 'vitest';
import {
  ServerSchema,

  SessionSchema,
  ArtifactSchema,
  SessionStatusSchema,
} from '../src/schemas.js';
import { isLoopbackHost } from '../src/hosts.js';
import { getAgentSkillPrompt } from '../src/skill-prompt.js';

describe('Domain Schemas', () => {
  it('validates a valid Server', () => {
    const validServer = {
      id: 'srv-123',
      name: 'Dev Server',
      host: '198.51.100.100',
      sshUser: 'developer',
      sshPort: 22,
      sshConfigAlias: 'gpu-box',
      enabled: true,
      createdAt: new Date(),
    };

    const parsed = ServerSchema.parse(validServer);
    expect(parsed.id).toBe('srv-123');
    expect(parsed.sshPort).toBe(22);
  });

  it('applies default port and enabled status on Server', () => {
    const serverMinimal = {
      id: 'srv-min',
      name: 'Minimal Server',
      host: 'remote.example.com',
    };

    const parsed = ServerSchema.parse(serverMinimal);
    expect(parsed.sshPort).toBe(22);
    expect(parsed.enabled).toBe(true);
    expect(parsed.createdAt).toBeInstanceOf(Date);
  });

  it('normalizes only complete bracketed IPv6 loopback hostnames', () => {
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost(' [::1] ')).toBe(true);
    expect(isLoopbackHost('[::1')).toBe(false);
    expect(isLoopbackHost('::1]')).toBe(false);
  });

  it('validates Session statuses', () => {
    const validStatuses = [
      'starting',
      'working',
      'needs_input',
      'idle',
      'done',
      'error',
      'disconnected',
    ];

    for (const status of validStatuses) {
      expect(SessionStatusSchema.parse(status)).toBe(status);
    }

    expect(() => SessionStatusSchema.parse('invalid_status')).toThrow();
  });

  it('validates a valid Session entity', () => {
    const session = {
      id: 'sess-001',
      name: 'Task 1.1 Bootstrap',
      serverId: 'srv-123',
      projectId: 'proj-456',
      agentId: 'agent-789',
      task: 'Bootstrap workspace',
      worktreePath: '/workspace/spawnea',
      branch: 'task-1.1-bootstrap',
      tmuxSessionName: 'spawnea-sess-001',
      status: 'working',
    };

    const parsed = SessionSchema.parse(session);
    expect(parsed.status).toBe('working');
    expect(parsed.creationSource).toBe('ui');
    expect(parsed.tmuxSessionName).toBe('spawnea-sess-001');
    expect(parsed.parentSessionId).toBeUndefined();
    expect(parsed.childAlias).toBeUndefined();
  });

  it('validates a child Session entity with parent reference and alias', () => {
    const childSession = {
      id: 'sess-child-001',
      name: 'Child task',
      parentSessionId: 'sess-001',
      childAlias: 'child-1',
      serverId: 'srv-123',
      projectId: 'proj-456',
      agentId: 'agent-789',
      task: 'Subtask execution',
      worktreePath: '/workspace/spawnea',
      branch: 'task-1.1-bootstrap',
      tmuxSessionName: 'spawnea-child-001',
      status: 'starting',
    };

    const parsed = SessionSchema.parse(childSession);
    expect(parsed.parentSessionId).toBe('sess-001');
    expect(parsed.childAlias).toBe('child-1');
    expect(parsed.status).toBe('starting');
  });

  it('validates Artifact entity with direction', () => {
    const artifact = {
      id: 'art-001',
      sessionId: 'sess-001',
      direction: 'output',
      remotePath: '/tmp/spawnea/screenshot.png',
      filename: 'screenshot.png',
      mimeType: 'image/png',
      sizeBytes: 102400,
    };

    const parsed = ArtifactSchema.parse(artifact);
    expect(parsed.direction).toBe('output');
    expect(parsed.sizeBytes).toBe(102400);
  });

  describe('getAgentSkillPrompt', () => {
    it('generates agent orchestration prompt without profile by default', () => {
      const prompt = getAgentSkillPrompt();
      expect(prompt).toContain('spawnea list\n');
      expect(prompt).not.toContain('--profile');
      expect(prompt).not.toContain('Active profile context');
    });

    it('generates agent orchestration prompt with active profile flags and catalog entry', () => {
      const prompt = getAgentSkillPrompt({
        profile: 'custom-profile',
        projects: [
          { id: 'local:spawnea', name: 'Spawnea', hostId: 'local', rootPath: '/code/spawnea' },
        ],
      });
      expect(prompt).toContain('spawnea list --profile custom-profile');
      expect(prompt).toContain('spawnea status <session-id> --profile custom-profile');
      expect(prompt).toContain('--profile custom-profile');
      expect(prompt).toContain('export SPAWNEA_PROFILE="custom-profile"');
      expect(prompt).toContain('### Active Profile\n- `custom-profile`');
      expect(prompt).toContain('- `local:spawnea` (Spawnea) [host: local] - /code/spawnea');
    });
  });
});
