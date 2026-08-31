import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHostAdapter } from '../src/local-host.js';
import { MockHostAdapter } from '../src/mock-host.js';

describe('LocalHostAdapter Filesystem Operations', () => {
  let testDir: string;
  let adapter: LocalHostAdapter;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'spawnea-file-test-'));
    adapter = new LocalHostAdapter({ serverId: 'test-local' });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('lists directory contents with correct file types, sizes, and sorting', async () => {
    await mkdir(join(testDir, 'src'));
    await mkdir(join(testDir, 'docs'));
    await writeFile(join(testDir, 'package.json'), JSON.stringify({ name: 'test' }));
    await writeFile(join(testDir, 'README.md'), '# Test Project');

    const files = await adapter.listFiles(testDir);

    expect(files.length).toBe(4);
    // Directories sorted first
    expect(files[0].name).toBe('docs');
    expect(files[0].isDirectory).toBe(true);
    expect(files[1].name).toBe('src');
    expect(files[1].isDirectory).toBe(true);
    // Files sorted alphabetically after directories
    expect(files[2].name).toBe('package.json');
    expect(files[2].isFile).toBe(true);
    expect(files[3].name).toBe('README.md');
    expect(files[3].isFile).toBe(true);
    expect(files[3].size).toBeGreaterThan(0);
  });

  it('reads UTF-8 text file with correct mimeType and content', async () => {
    const filePath = join(testDir, 'hello.ts');
    await writeFile(filePath, 'export const greeting = "hello world";\n');

    const result = await adapter.readFile(filePath);

    expect(result.path).toBe(filePath);
    expect(result.content).toBe('export const greeting = "hello world";\n');
    expect(result.isBinary).toBe(false);
    expect(result.isTruncated).toBe(false);
    expect(result.mimeType).toBe('text/typescript');
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it('truncates files that exceed maxBytes limit', async () => {
    const filePath = join(testDir, 'large.txt');
    const largeContent = 'A'.repeat(5000);
    await writeFile(filePath, largeContent);

    const result = await adapter.readFile(filePath, 1000);

    expect(result.isTruncated).toBe(true);
    expect(result.sizeBytes).toBe(5000);
    expect(result.content.length).toBe(1000);
    expect(result.content).toBe('A'.repeat(1000));
  });

  it('reads binary image files as base64 data URI', async () => {
    const filePath = join(testDir, 'icon.png');
    // Synthetic PNG header bytes
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    await writeFile(filePath, pngBytes);

    const result = await adapter.readFile(filePath);

    expect(result.isBinary).toBe(true);
    expect(result.mimeType).toBe('image/png');
    expect(result.content.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('retrieves accurate file and directory stats', async () => {
    const dirPath = join(testDir, 'subdir');
    const filePath = join(testDir, 'test.json');
    await mkdir(dirPath);
    await writeFile(filePath, '{"a": 1}');

    const dirStat = await adapter.stat(dirPath);
    expect(dirStat.isDirectory).toBe(true);
    expect(dirStat.isFile).toBe(false);

    const fileStat = await adapter.stat(filePath);
    expect(fileStat.isFile).toBe(true);
    expect(fileStat.isDirectory).toBe(false);
    expect(fileStat.size).toBe(8);
  });

  it('throws error when listing or reading non-existent paths', async () => {
    await expect(adapter.listFiles(join(testDir, 'does-not-exist'))).rejects.toThrow();
    await expect(adapter.readFile(join(testDir, 'missing.txt'))).rejects.toThrow();
    await expect(adapter.stat(join(testDir, 'missing.txt'))).rejects.toThrow();
  });

  it('uploads, downloads, writes, and creates directories locally', async () => {
    const srcFile = join(testDir, 'source.txt');
    await writeFile(srcFile, 'Hello transfer source');

    const destFile = join(testDir, '.spawnea/artifacts/dest.txt');
    await adapter.uploadFile(srcFile, destFile);

    const uploaded = await adapter.readFile(destFile);
    expect(uploaded.content).toBe('Hello transfer source');

    const downloadedFile = join(testDir, 'downloaded.txt');
    await adapter.downloadFile(destFile, downloadedFile);

    const downloadedStat = await adapter.stat(downloadedFile);
    expect(downloadedStat.isFile).toBe(true);

    const directWriteFile = join(testDir, '.spawnea/artifacts/direct.png');
    const directBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await adapter.writeFile(directWriteFile, directBuf);

    const writeStat = await adapter.stat(directWriteFile);
    expect(writeStat.size).toBe(4);

    await adapter.mkdir(join(testDir, 'deep/nested/folder'));
    const dirStat = await adapter.stat(join(testDir, 'deep/nested/folder'));
    expect(dirStat.isDirectory).toBe(true);
  });
});

describe('MockHostAdapter Filesystem Operations', () => {
  let mock: MockHostAdapter;

  beforeEach(() => {
    mock = new MockHostAdapter('mock-1', ['/workspace', '/workspace/src', '/workspace/docs']);
    mock.mockFiles.set('/workspace/package.json', {
      content: '{"name": "mock-app"}',
      mimeType: 'application/json',
      size: 21,
    });
    mock.mockFiles.set('/workspace/src/index.ts', {
      content: 'console.log("hello");',
      mimeType: 'text/typescript',
      size: 21,
    });
  });

  it('lists mock directories and files correctly', async () => {
    const files = await mock.listFiles('/workspace');

    expect(files.some((f) => f.name === 'docs' && f.isDirectory)).toBe(true);
    expect(files.some((f) => f.name === 'src' && f.isDirectory)).toBe(true);
    expect(files.some((f) => f.name === 'package.json' && f.isFile)).toBe(true);
  });

  it('reads mock file content and metadata', async () => {
    const res = await mock.readFile('/workspace/package.json');
    expect(res.content).toBe('{"name": "mock-app"}');
    expect(res.mimeType).toBe('application/json');
    expect(res.isTruncated).toBe(false);
  });

  it('retrieves mock stats accurately', async () => {
    const dirStat = await mock.stat('/workspace/src');
    expect(dirStat.isDirectory).toBe(true);

    const fileStat = await mock.stat('/workspace/package.json');
    expect(fileStat.isFile).toBe(true);
    expect(fileStat.size).toBe(21);
  });

  it('supports mock upload, download, write, and mkdir', async () => {
    await mock.mkdir('/workspace/.spawnea/artifacts');
    const dirStat = await mock.stat('/workspace/.spawnea/artifacts');
    expect(dirStat.isDirectory).toBe(true);

    await mock.writeFile('/workspace/.spawnea/artifacts/image.png', Buffer.from('mock-png-data'));
    const fileStat = await mock.stat('/workspace/.spawnea/artifacts/image.png');
    expect(fileStat.size).toBe(13);

    await mock.uploadFile('/local/file.txt', '/workspace/.spawnea/artifacts/uploaded.txt');
    const uploadedStat = await mock.stat('/workspace/.spawnea/artifacts/uploaded.txt');
    expect(uploadedStat.isFile).toBe(true);
  });
});

