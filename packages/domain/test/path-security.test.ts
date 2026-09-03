import { describe, expect, it } from 'vitest';
import {
  assertSafeFilename,
  canonicalizePath,
  isPathContained,
  relativeContainedPath,
  resolveContainedPath,
} from '../src/path-security.js';

describe('path security helpers', () => {
  it('canonicalizes traversal and preserves path boundaries', () => {
    expect(canonicalizePath('/workspace/spawnea/docs/../README.md')).toBe('/workspace/spawnea/README.md');
    expect(isPathContained('/workspace/spawnea', '/workspace/spawnea-extra/file.txt')).toBe(false);
    expect(isPathContained('/', '/tmp/file.txt')).toBe(true);
    expect(isPathContained('/workspace/spawnea', '/workspace/spawnea/docs/../README.md')).toBe(true);
    expect(resolveContainedPath('/workspace/spawnea', './docs/../README.md')).toBe('/workspace/spawnea/README.md');
  });

  it('rejects absolute and relative paths outside the root', () => {
    expect(() => resolveContainedPath('/workspace/spawnea', '../../etc/passwd')).toThrow();
    expect(() => resolveContainedPath('/workspace/spawnea', '/workspace/spawnea-other/file.txt')).toThrow();
    expect(() => relativeContainedPath('/workspace/spawnea', '/tmp/file.txt')).toThrow();
  });

  it('normalizes and contains Windows paths', () => {
    const windowsRoot = ['C:', 'Users', 'demo', 'demo-proj'].join('\\');
    expect(resolveContainedPath(windowsRoot, '.\\artifact-demo.md')).toBe(
      ['C:', 'Users', 'demo', 'demo-proj', 'artifact-demo.md'].join('/')
    );
    expect(
      relativeContainedPath(windowsRoot, `${windowsRoot}\\artifact-demo.md`)
    ).toBe('artifact-demo.md');
    expect(() =>
      resolveContainedPath(windowsRoot, ['C:', 'Users', 'other', 'file.md'].join('\\'))
    ).toThrow();
    const differentlyCasedRoot = ['C:', 'Users', 'Demo', 'Demo-Proj'].join('\\');
    const differentlyCasedCandidate = ['c:', 'users', 'demo', 'demo-proj', 'artifact.md'].join('\\');
    expect(
      resolveContainedPath(differentlyCasedRoot, differentlyCasedCandidate)
    ).toBe(differentlyCasedCandidate.replace(/\\/g, '/'));
  });

  it('accepts only a single safe artifact filename', () => {
    expect(assertSafeFilename('report.pdf')).toBe('report.pdf');
    for (const filename of ['', '.', '..', '../report.pdf', 'nested/report.pdf', '/tmp/report.pdf', 'nested\\report.pdf']) {
      expect(() => assertSafeFilename(filename)).toThrow();
    }
  });
});
