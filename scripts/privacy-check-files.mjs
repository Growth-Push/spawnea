import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function normalizeRepositoryPath(filePath) {
  return filePath.replaceAll('\\', '/');
}

export async function collectRepositoryFiles(root) {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
  const paths = stdout.split('\0').filter(Boolean);
  const files = await Promise.all(paths.map(async (rawFilePath) => {
    const filePath = normalizeRepositoryPath(rawFilePath);
    const absolutePath = resolve(root, rawFilePath);
    try {
      const stat = await lstat(absolutePath);
      return { absolutePath, filePath, isSymbolicLink: stat.isSymbolicLink() };
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    }
  }));
  return files.filter((file) => file !== undefined);
}
