import { describe, it, expect } from 'vitest';
import { MockHostAdapter } from '../src/mock-host.js';
import { prepareProjectFolder } from '../src/project-prep.js';

describe('prepareProjectFolder', () => {
  it('reuses existing folder when directory is present (FG-2.2.2)', async () => {
    const host = new MockHostAdapter('host-1', ['/existing/code/Spawnea']);
    const result = await prepareProjectFolder({
      host,
      path: '/existing/code/Spawnea',
      gitUrl: 'https://github.com/example/repo.git',
    });

    expect(result.success).toBe(true);
    expect(result.action).toBe('reused');
    expect(result.path).toBe('/existing/code/Spawnea');

    // Ensure git clone was NOT called
    const gitCloneCalled = host.executedCommands.some((c) => c.command.includes('git clone'));
    expect(gitCloneCalled).toBe(false);
  });

  it('clones git repository when folder is missing and gitUrl is provided (FG-2.2.4)', async () => {
    const host = new MockHostAdapter('host-1');
    const result = await prepareProjectFolder({
      host,
      path: '/new/code/Spawnea',
      gitUrl: 'https://github.com/example/repo.git',
    });

    expect(result.success).toBe(true);
    expect(result.action).toBe('cloned');
    expect(host.directories.has('/new/code/Spawnea')).toBe(true);

    const gitCloneCalled = host.executedCommands.some((c) => c.command.includes('git clone'));
    expect(gitCloneCalled).toBe(true);
  });

  it('creates directory when folder is missing and no gitUrl is provided (FG-2.2.3)', async () => {
    const host = new MockHostAdapter('host-1');
    const result = await prepareProjectFolder({
      host,
      path: '/new/scratch/project',
    });

    expect(result.success).toBe(true);
    expect(result.action).toBe('created');
    expect(host.directories.has('/new/scratch/project')).toBe(true);
  });

  it('fails truthfully when git clone returns an error (FG-2.2.5)', async () => {
    const host = new MockHostAdapter('host-1');
    host.customRules.push({
      pattern: 'git clone',
      response: {
        stdout: '',
        stderr: 'fatal: repository not found or authentication required',
        exitCode: 128,
      },
    });

    const result = await prepareProjectFolder({
      host,
      path: '/failed/clone/path',
      gitUrl: 'https://github.com/private/repo.git',
    });

    expect(result.success).toBe(false);
    expect(result.action).toBe('cloned');
    expect(result.error).toContain('fatal: repository not found');
  });

  it('fails truthfully when folder creation fails due to permission error (FG-2.2.5)', async () => {
    const host = new MockHostAdapter('host-1');
    host.customRules.push({
      pattern: 'mkdir -p',
      response: {
        stdout: '',
        stderr: 'mkdir: cannot create directory /root/protected: Permission denied',
        exitCode: 1,
      },
    });

    const result = await prepareProjectFolder({
      host,
      path: '/root/protected',
    });

    expect(result.success).toBe(false);
    expect(result.action).toBe('created');
    expect(result.error).toContain('Permission denied');
  });
});
