import { homedir } from 'node:os';
import { delimiter } from 'node:path';

const UNIX_EXECUTABLE_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/opt/local/bin',
  `${homedir()}/.local/bin`,
  `${homedir()}/bin`,
];

let originalProcessPath: string | undefined = typeof process !== 'undefined' ? process.env.ORIGINAL_PATH : undefined;

export function getOriginalProcessPath(): string | undefined {
  return originalProcessPath;
}

export function setOriginalProcessPath(path: string | undefined): void {
  originalProcessPath = path;
}

export function initializeProcessPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === 'win32') return env.PATH;

  if (originalProcessPath === undefined && env.PATH !== undefined) {
    originalProcessPath = env.PATH;
  }
  if (!env.ORIGINAL_PATH && env.PATH !== undefined) {
    env.ORIGINAL_PATH = env.PATH;
  }

  const currentPath = env.PATH ?? '';
  const entries = currentPath.split(delimiter).filter(Boolean);
  for (const executablePath of UNIX_EXECUTABLE_PATHS) {
    if (!entries.includes(executablePath)) entries.push(executablePath);
  }

  const normalizedPath = entries.join(delimiter);
  env.PATH = normalizedPath;
  return normalizedPath;
}
