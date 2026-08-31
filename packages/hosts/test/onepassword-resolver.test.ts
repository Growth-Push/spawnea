import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { SecretResolutionError, type SecretReference } from '@spawnea/domain';
import { OnePasswordResolver } from '../src/index.js';

const tempDirs: string[] = [];

function fakeOp(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'spawnea-fake-op-'));
  tempDirs.push(dir);
  const executable = join(dir, 'op');
  writeFileSync(executable, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(executable, 0o700);
  return executable;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function captureFailure(promise: Promise<unknown>): Promise<SecretResolutionError> {
  try {
    await promise;
  } catch (error) {
    return error as SecretResolutionError;
  }
  throw new Error('Expected secret resolution to fail');
}

describe('OnePasswordResolver', () => {
  it('uses fixed op read arguments without a shell and returns a releasable value', async () => {
    const executable = fakeOp(`
[ "$1" = "read" ] || exit 31
[ "$2" = "--no-newline" ] || exit 32
[ "$3" = "--" ] || exit 33
[ "$4" = "op://example-vault/server/hostname" ] || exit 34
printf %s 'server.example.test'
`);
    const resolver = new OnePasswordResolver({ executablePath: executable });

    const lease = await resolver.resolveString(
      'op://example-vault/server/hostname',
      'hosts.example.ssh.target',
      'ssh_target'
    );

    expect(lease.value).toBe('server.example.test');
    expect(lease.sensitive).toBe(true);
    lease.release();
  });

  it('passes shell metacharacters as literal reference data', async () => {
    const executable = fakeOp("printf %s 'safe.example'");
    const marker = join(dirname(executable), 'must-not-exist');
    const reference = `op://vault/item/field;touch-${marker.replaceAll('/', '-')}`;
    const resolver = new OnePasswordResolver({ executablePath: executable });

    const lease = await resolver.resolveString(reference, 'hosts.safe.ssh.target', 'ssh_target');

    expect(lease.value).toBe('safe.example');
    expect(existsSync(marker)).toBe(false);
    lease.release();
  });

  it.each([
    ["printf %s 'please sign in: leaked-account' >&2; exit 1", 'authentication_required'],
    ["printf %s 'item secret-name was not found' >&2; exit 1", 'reference_not_found'],
  ])('returns a safe typed failure for CLI stderr', async (body, code) => {
    const resolver = new OnePasswordResolver({ executablePath: fakeOp(body) });

    const failure = await captureFailure(resolver.resolveString(
      'op://vault/private-item/hostname',
      'hosts.example.ssh.target',
      'ssh_target'
    ));

    expect(failure).toBeInstanceOf(SecretResolutionError);
    expect(failure.code).toBe(code);
    expect(failure.message).not.toContain('private-item');
    expect(failure.message).not.toContain('leaked-account');
    expect(failure.message).not.toContain('secret-name');
  });

  it('reports a missing CLI without exposing the reference', async () => {
    const resolver = new OnePasswordResolver({ executablePath: '/nonexistent/spawnea-op' });

    const failure = await captureFailure(resolver.resolveString(
      'op://vault/private-item/hostname',
      'hosts.example.ssh.target',
      'ssh_target'
    ));

    expect(failure.code).toBe('cli_missing');
    expect(failure.message).not.toContain('op://');
  });

  it('kills timed-out reads and rejects oversized output', async () => {
    const timedOut = new OnePasswordResolver({
      executablePath: fakeOp("sleep 1; printf %s 'late.example'"),
      timeoutMs: 20,
    });
    const oversized = new OnePasswordResolver({
      executablePath: fakeOp("printf %s '1234567890'"),
      maxOutputBytes: 4,
    });

    const timeoutFailure = await captureFailure(timedOut.resolveString(
      'op://vault/item/hostname',
      'hosts.example.ssh.target',
      'ssh_target'
    ));
    const sizeFailure = await captureFailure(oversized.resolveString(
      'op://vault/item/hostname',
      'hosts.example.ssh.target',
      'ssh_target'
    ));

    expect(timeoutFailure.code).toBe('timeout');
    expect(sizeFailure.code).toBe('output_too_large');
  });

  it('validates resolved ports and project paths', async () => {
    const invalidPort = new OnePasswordResolver({ executablePath: fakeOp("printf %s '70000'") });
    const projectPath = new OnePasswordResolver({ executablePath: fakeOp("printf %s '/srv/code/project'") });

    const portFailure = await captureFailure(invalidPort.resolvePort(
      'op://vault/item/port' as SecretReference,
      'hosts.example.ssh.port'
    ));
    const pathLease = await projectPath.resolveString(
      'op://vault/item/project-root',
      'hosts.example.projects.project.path',
      'project_path'
    );

    expect(portFailure.code).toBe('invalid_value');
    expect(pathLease.value).toBe('/srv/code/project');
    pathLease.release();
  });
});
