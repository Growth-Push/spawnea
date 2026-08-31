import type { HostAdapter, ProjectPrepResult, Logger } from '@spawnea/domain';
import { createLogger, maskSensitiveString } from '@spawnea/domain';

export interface PrepareProjectOptions {
  host: HostAdapter;
  path: string;
  gitUrl?: string;
  logger?: Logger;
}

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Prepares the remote project directory according to the Pilot 1 specification:
 * 1. If path exists, reuse it.
 * 2. If path is missing and git_url is present, clone the repository into path.
 * 3. If path is missing and git_url is absent, create the folder.
 * 4. Permission or clone failures must be caught and reported truthfully.
 */
export async function prepareProjectFolder(options: PrepareProjectOptions): Promise<ProjectPrepResult> {
  const { host, path, gitUrl } = options;
  const logger = options.logger || createLogger('ProjectPrep');

  logger.info('Checking if project path exists on target host', {
    serverId: host.serverId,
    path,
    gitUrl: gitUrl ? '[PRESENT]' : '[NONE]',
  });

  // Check if directory exists
  const checkResult = await host.execute(`test -d ${escapeShellArg(path)}`);
  if (checkResult.exitCode === 0) {
    logger.info('Project folder already exists, reusing existing directory', { path });
    return {
      success: true,
      path,
      action: 'reused',
    };
  }

  // Folder is missing. If git_url is present, clone it.
  if (gitUrl && gitUrl.trim() !== '') {
    logger.info('Project folder is missing, cloning from repository URL', { path, gitUrl });
    const cloneResult = await host.execute(`git clone ${escapeShellArg(gitUrl)} ${escapeShellArg(path)}`);

    if (cloneResult.exitCode !== 0) {
      const errorMsg = cloneResult.stderr.trim() || cloneResult.stdout.trim() || `Exit code ${cloneResult.exitCode}`;
      logger.error('Failed to clone repository into project path', new Error(errorMsg), {
        path,
        gitUrl,
        exitCode: cloneResult.exitCode,
      });

      return {
        success: false,
        path,
        action: 'cloned',
        error: `Git clone failed: ${maskSensitiveString(errorMsg)}`,
      };
    }

    logger.info('Repository successfully cloned into project path', { path });
    return {
      success: true,
      path,
      action: 'cloned',
    };
  }

  // Folder is missing and no git_url is configured. Create the directory.
  logger.info('Project folder is missing without Git URL, creating empty directory', { path });
  const mkdirResult = await host.execute(`mkdir -p ${escapeShellArg(path)}`);

  if (mkdirResult.exitCode !== 0) {
    const errorMsg = mkdirResult.stderr.trim() || mkdirResult.stdout.trim() || `Exit code ${mkdirResult.exitCode}`;
    logger.error('Failed to create project directory', new Error(errorMsg), {
      path,
      exitCode: mkdirResult.exitCode,
    });

    return {
      success: false,
      path,
      action: 'created',
      error: `Failed to create folder '${path}': ${maskSensitiveString(errorMsg)}`,
    };
  }

  logger.info('Project directory created successfully', { path });
  return {
    success: true,
    path,
    action: 'created',
  };
}
