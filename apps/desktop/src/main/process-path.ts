import { homedir } from 'node:os';
import { delimiter } from 'node:path';

const UNIX_EXECUTABLE_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/opt/local/bin',
  `${homedir()}/.local/bin`,
  `${homedir()}/bin`,
];

export function initializeProcessPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === 'win32') return env.PATH;

  const currentPath = env.PATH ?? '';
  const entries = currentPath.split(delimiter).filter(Boolean);
  for (const executablePath of UNIX_EXECUTABLE_PATHS) {
    if (!entries.includes(executablePath)) entries.push(executablePath);
  }

  const normalizedPath = entries.join(delimiter);
  env.PATH = normalizedPath;
  return normalizedPath;
}