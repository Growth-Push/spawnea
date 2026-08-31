import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ResolvedSshConfig {
  host: string;
  hostname: string;
  user?: string;
  port?: number;
  identityFile?: string[];
  identityAgent?: string;
  proxyJump?: string;
}

/**
 * Parses OpenSSH config file syntax line-by-line.
 */
export function parseSshConfigFile(content: string): Record<string, Partial<ResolvedSshConfig>> {
  const hosts: Record<string, Partial<ResolvedSshConfig>> = {};
  let currentHostPatterns: string[] = [];

  const lines = content.split(/\r?\n/);

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    // Match Key Value or Key = Value
    const match = line.match(/^(\w+)(?:\s*=\s*|\s+)(.+)$/);
    if (!match) continue;

    const key = match[1].toLowerCase();
    const value = match[2].trim().replace(/^["']|["']$/g, '');

    if (key === 'host') {
      currentHostPatterns = value.split(/\s+/);
      for (const pattern of currentHostPatterns) {
        if (!hosts[pattern]) {
          hosts[pattern] = { host: pattern };
        }
      }
      continue;
    }

    if (currentHostPatterns.length === 0) {
      // Global parameters before first Host block
      if (!hosts['*']) hosts['*'] = { host: '*' };
      applyConfigKey(hosts['*'], key, value);
    } else {
      for (const pattern of currentHostPatterns) {
        applyConfigKey(hosts[pattern], key, value);
      }
    }
  }

  return hosts;
}

function applyConfigKey(config: Partial<ResolvedSshConfig>, key: string, value: string): void {
  switch (key) {
    case 'hostname':
      config.hostname = value;
      break;
    case 'user':
      config.user = value;
      break;
    case 'port': {
      const p = parseInt(value, 10);
      if (!isNaN(p) && p > 0) config.port = p;
      break;
    }
    case 'identityfile': {
      let resolved = value;
      if (resolved.startsWith('~/')) {
        resolved = join(homedir(), resolved.substring(2));
      }
      if (!config.identityFile) config.identityFile = [];
      config.identityFile.push(resolved);
      break;
    }
    case 'identityagent': {
      if (value.toLowerCase() === 'none') {
        config.identityAgent = 'none';
      } else {
        let resolved = value;
        if (resolved.startsWith('~/')) {
          resolved = join(homedir(), resolved.substring(2));
        }
        config.identityAgent = resolved;
      }
      break;
    }
    case 'proxyjump':
      config.proxyJump = value;
      break;
  }
}

/**
 * Resolves SSH connection details for a target host alias using ~/.ssh/config.
 */
export function resolveSshTarget(
  target: string,
  explicitUser?: string,
  explicitPort?: number,
  configPath?: string
): ResolvedSshConfig {
  const filePath = configPath || join(homedir(), '.ssh', 'config');
  let parsedConfigs: Record<string, Partial<ResolvedSshConfig>> = {};

  if (existsSync(filePath)) {
    try {
      const content = readFileSync(filePath, 'utf8');
      parsedConfigs = parseSshConfigFile(content);
    } catch {
      // Ignore read errors, proceed with direct target
    }
  }

  const matched = parsedConfigs[target] || {};
  const global = parsedConfigs['*'] || {};

  const hostname = matched.hostname || (target !== '*' ? target : 'localhost');
  const user = explicitUser || matched.user || global.user || process.env.USER || 'root';
  const port = explicitPort || matched.port || global.port || 22;
  const identityFile = matched.identityFile || global.identityFile;
  const identityAgent = matched.identityAgent || global.identityAgent;

  return {
    host: target,
    hostname,
    user,
    port,
    identityFile,
    identityAgent,
    proxyJump: matched.proxyJump,
  };
}
