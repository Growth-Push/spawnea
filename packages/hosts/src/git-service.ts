import type {
  HostAdapter,
  GitStatusResult,
  GitFileStatus,
  GitFileStatusCode,
  GitDiffResult,
  GitDiffOptions,
  GitBranchDiscoveryResult,
  GitDiffFile,
  GitDiffHunk,

  ManagedWorktreeInspection,
  Logger,
} from '@spawnea/domain';
import { createLogger, isExactRepositoryRelativePath } from '@spawnea/domain';

export interface ManagedWorktreeResult {
  repositoryPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
}

export interface CopyFilesResult {
  copied: string[];
  skipped: string[];
}

export interface ManagedWorktreeIdentity {
  repositoryPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseCommit?: string;
}

export class GitService {
  private readonly logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger || createLogger('GitService');
  }

  /** Lists local branches and returns conservative base-branch suggestions. */
  async discoverBranches(
    host: HostAdapter,
    cwd: string,
    preferredBranch?: string
  ): Promise<GitBranchDiscoveryResult> {
    try {
      const repo = await host.execute('git rev-parse --is-inside-work-tree', { cwd });
      if (repo.exitCode !== 0 || !repo.stdout.trim().includes('true')) {
        return { isGitRepo: false, branches: [], suggestedBranches: [], error: 'Path is not a Git repository.' };
      }

      const [currentResult, branchesResult] = await Promise.all([
        host.execute('git branch --show-current', { cwd }),
        host.execute("git for-each-ref --format='%(refname:short)' refs/heads", { cwd }),
      ]);
      const branches = Array.from(
        new Set(branchesResult.stdout.split(/\r?\n/).map((branch) => branch.trim()).filter(Boolean))
      ).sort();
      const currentBranch = currentResult.stdout.trim() || undefined;
      const preferred = preferredBranch?.trim() || currentBranch;
      const common = ['main', 'master', 'trunk', 'develop'];
      const suggestedBranches = Array.from(
        new Set([preferred, ...common].filter((branch): branch is string => Boolean(branch && branches.includes(branch))))
      );

      return { isGitRepo: true, currentBranch, branches, suggestedBranches };
    } catch (err) {
      this.logger.warn('Failed to discover Git branches', { serverId: host.serverId, cwd, error: err });
      return {
        isGitRepo: false,
        branches: [],
        suggestedBranches: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Creates and verifies a Spawnea-owned branch and sibling worktree. */
  async createManagedWorktree(options: {
    host: HostAdapter;
    repositoryPath: string;
    taskSlug: string;
    sessionSuffix: string;
    baseBranch?: string;
  }): Promise<ManagedWorktreeResult> {
    const { host, repositoryPath, taskSlug, sessionSuffix } = options;
    const rootResult = await host.execute('git rev-parse --show-toplevel', { cwd: repositoryPath });
    if (rootResult.exitCode !== 0 || !rootResult.stdout.trim()) {
      throw new Error(`Project path '${repositoryPath}' is not a Git repository`);
    }

    const repositoryRoot = rootResult.stdout.trim().replace(/\/+$/, '');
    const currentBranchResult = await host.execute('git branch --show-current', { cwd: repositoryRoot });
    const baseBranch = options.baseBranch?.trim() || currentBranchResult.stdout.trim();
    if (!baseBranch) {
      throw new Error('A local base branch is required when the repository has a detached HEAD');
    }

    const leaf = `${taskSlug}-${sessionSuffix}`;
    const branch = `spawnea/${leaf}`;
    const worktreesRoot = `${repositoryRoot}__worktrees`;
    const worktreePath = `${worktreesRoot}/${leaf}`;

    await this.assertValidLocalBranch(host, repositoryRoot, baseBranch, 'base');
    await this.assertValidLocalBranchName(host, repositoryRoot, branch, 'generated task');

    const baseCommitResult = await host.execute(
      `git rev-parse ${escapeShellPath(`${baseBranch}^{commit}`)}`,
      { cwd: repositoryRoot }
    );
    const baseCommit = baseCommitResult.stdout.trim();
    if (baseCommitResult.exitCode !== 0 || !/^[0-9a-f]{40,64}$/i.test(baseCommit)) {
      throw new Error(`Could not resolve the creation commit for base branch '${baseBranch}'`);
    }

    const branchCollision = await host.execute(
      `git show-ref --verify --quiet ${escapeShellPath(`refs/heads/${branch}`)}`,
      { cwd: repositoryRoot }
    );
    if (branchCollision.exitCode === 0) {
      throw new Error(`Generated branch '${branch}' already exists`);
    }

    const pathCollision = await host.execute(
      `test ! -e ${escapeShellPath(worktreePath)} && test ! -L ${escapeShellPath(worktreePath)}`
    );
    if (pathCollision.exitCode !== 0) {
      throw new Error(`Generated worktree path '${worktreePath}' already exists`);
    }

    const mkdirResult = await host.execute(`mkdir -p ${escapeShellPath(worktreesRoot)}`);
    if (mkdirResult.exitCode !== 0) {
      throw new Error(`Failed to prepare worktree directory '${worktreesRoot}'`);
    }

    const addResult = await host.execute(
      `git worktree add -b ${escapeShellPath(branch)} ${escapeShellPath(worktreePath)} ${escapeShellPath(baseBranch)}`,
      { cwd: repositoryRoot }
    );
    if (addResult.exitCode !== 0) {
      const details = addResult.stderr.trim() || addResult.stdout.trim() || `exit code ${addResult.exitCode}`;
      throw new Error(`Failed to create worktree: ${details}`);
    }

    try {
      const [verifiedRoot, verifiedBranch] = await Promise.all([
        host.execute('git rev-parse --show-toplevel', { cwd: worktreePath }),
        host.execute('git branch --show-current', { cwd: worktreePath }),
      ]);
      if (verifiedRoot.exitCode !== 0 || verifiedRoot.stdout.trim().replace(/\/+$/, '') !== worktreePath) {
        throw new Error(`Git did not report '${worktreePath}' as the created worktree root`);
      }
      if (verifiedBranch.exitCode !== 0 || verifiedBranch.stdout.trim() !== branch) {
        throw new Error(`Created worktree is not checked out on '${branch}'`);
      }
    } catch (error) {
      await this.removeManagedWorktree(host, repositoryRoot, worktreePath).catch(() => false);
      throw error;
    }

    this.logger.info('Managed worktree created and verified', {
      serverId: host.serverId,
      repositoryPath: repositoryRoot,
      worktreePath,
      branch,
      baseBranch,
      baseCommit,
    });
    return { repositoryPath: repositoryRoot, worktreePath, branch, baseBranch, baseCommit };
  }

  /** Copies exact repository-relative regular files without replacing destinations. */
  async copyFilesToWorktree(
    host: HostAdapter,
    sourceRoot: string,
    destinationRoot: string,
    relativePaths: string[]
  ): Promise<CopyFilesResult> {
    const uniquePaths = new Set<string>();
    for (const relativePath of relativePaths) {
      validateCopyFilePath(relativePath);
      if (uniquePaths.has(relativePath)) {
        throw new Error(`Duplicate copy_files entry '${relativePath}'`);
      }
      uniquePaths.add(relativePath);
    }

    const safePaths: string[] = [];
    const skipped: string[] = [];
    for (const relativePath of uniquePaths) {
      const sourcePath = `${sourceRoot}/${relativePath}`;
      const destinationPath = `${destinationRoot}/${relativePath}`;
      const inspect = await host.execute(buildCopyInspectionCommand(
        sourceRoot,
        sourcePath,
        destinationRoot,
        destinationPath
      ));
      const state = inspect.stdout.trim();
      if (inspect.exitCode !== 0) {
        throw new Error(`Failed to validate configured copy file '${relativePath}'`);
      }
      if (state === 'MISSING') {
        skipped.push(relativePath);
        this.logger.warn('Configured copy file is missing; skipping it', { relativePath });
        continue;
      }
      if (state !== 'SAFE') {
        const reason = state === 'SYMLINK'
          ? 'symlinks are not allowed'
          : state === 'NOT_FILE'
            ? 'directories and non-regular files are not allowed'
            : state === 'DEST_EXISTS'
              ? 'the destination already exists'
              : 'the path resolves outside the repository or worktree';
        throw new Error(`Invalid copy_files entry '${relativePath}': ${reason}`);
      }
      safePaths.push(relativePath);
    }

    const copied: string[] = [];
    for (const relativePath of safePaths) {
      const sourcePath = `${sourceRoot}/${relativePath}`;
      const destinationPath = `${destinationRoot}/${relativePath}`;
      const slashIndex = destinationPath.lastIndexOf('/');
      const destinationParent = slashIndex > 0 ? destinationPath.slice(0, slashIndex) : destinationRoot;
      const copyResult = await host.execute(
        `mkdir -p ${escapeShellPath(destinationParent)} && cp --no-clobber --preserve=mode,timestamps -- ${escapeShellPath(sourcePath)} ${escapeShellPath(destinationPath)}`
      );
      if (copyResult.exitCode !== 0) {
        throw new Error(`Failed to copy configured file '${relativePath}' into the worktree`);
      }
      copied.push(relativePath);
    }

    return { copied, skipped };
  }

  /** Attempts normal worktree removal and never deletes its branch. */
  async removeManagedWorktree(
    host: HostAdapter,
    repositoryPath: string,
    worktreePath: string
  ): Promise<boolean> {
    const result = await host.execute(
      `git worktree remove -- ${escapeShellPath(worktreePath)}`,
      { cwd: repositoryPath }
    );
    if (result.exitCode !== 0) return false;
    const absent = await host.execute(
      `test ! -e ${escapeShellPath(worktreePath)} && test ! -L ${escapeShellPath(worktreePath)}`
    );
    return absent.exitCode === 0;
  }

  /** Saves all local worktree changes, including ignored files, in a named stash. */
  async stashManagedWorktreeChanges(
    host: HostAdapter,
    identity: ManagedWorktreeIdentity
  ): Promise<void> {
    const message = `Spawnea worktree: ${identity.branch}`;
    const result = await host.execute(
      `git stash push --all --message ${escapeShellPath(message)}`,
      { cwd: identity.worktreePath }
    );
    if (result.exitCode !== 0) {
      const details = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
      throw new Error(`Failed to stash changes from managed worktree: ${details}`);
    }

    const status = await host.execute('git status --porcelain=v1 --untracked-files=all', {
      cwd: identity.worktreePath,
    });
    if (status.exitCode !== 0 || status.stdout.length > 0) {
      throw new Error('Git did not verify that managed worktree changes were stashed');
    }
  }

  /** Discards all tracked, untracked, and ignored files in the exact managed worktree. */
  async discardManagedWorktreeChanges(
    host: HostAdapter,
    identity: ManagedWorktreeIdentity
  ): Promise<void> {
    const reset = await host.execute('git reset --hard HEAD', { cwd: identity.worktreePath });
    if (reset.exitCode !== 0) {
      const details = reset.stderr.trim() || reset.stdout.trim() || `exit code ${reset.exitCode}`;
      throw new Error(`Failed to reset managed worktree changes: ${details}`);
    }

    const clean = await host.execute('git clean -fdx -- .', { cwd: identity.worktreePath });
    if (clean.exitCode !== 0) {
      const details = clean.stderr.trim() || clean.stdout.trim() || `exit code ${clean.exitCode}`;
      throw new Error(`Failed to discard untracked managed worktree files: ${details}`);
    }

    const status = await host.execute('git status --porcelain=v1 --untracked-files=all', {
      cwd: identity.worktreePath,
    });
    if (status.exitCode !== 0 || status.stdout.length > 0) {
      throw new Error('Git did not verify that managed worktree changes were discarded');
    }
  }

  /** Inspects whether a recorded worktree was manually switched and its task branch integrated. */
  async inspectManagedWorktree(
    host: HostAdapter,
    identity: ManagedWorktreeIdentity
  ): Promise<ManagedWorktreeInspection> {
    const repositoryPath = identity.repositoryPath.replace(/\/+$/, '');
    const worktreePath = identity.worktreePath.replace(/\/+$/, '');
    const [primaryRoot, worktreeList, taskRoot, currentBranch, taskBranch, baseBranch, integrated, taskStatus] = await Promise.all([
      host.execute('git rev-parse --show-toplevel', { cwd: repositoryPath }),
      host.execute('git worktree list --porcelain', { cwd: repositoryPath }),
      host.execute('git rev-parse --show-toplevel', { cwd: worktreePath }),
      host.execute('git branch --show-current', { cwd: worktreePath }),
      host.execute(`git rev-parse ${escapeShellPath(`${identity.branch}^{commit}`)}`, { cwd: repositoryPath }),
      host.execute(`git rev-parse ${escapeShellPath(`${identity.baseBranch}^{commit}`)}`, { cwd: repositoryPath }),
      host.execute(
        `git merge-base --is-ancestor ${escapeShellPath(identity.branch)} ${escapeShellPath(identity.baseBranch)}`,
        { cwd: repositoryPath }
      ),
      host.execute('git status --porcelain=v1 --untracked-files=all', { cwd: worktreePath }),
    ]);

    const branchName = currentBranch.stdout.trim();
    const isClean = taskStatus.exitCode === 0 ? taskStatus.stdout.length === 0 : undefined;
    if (primaryRoot.exitCode !== 0 || primaryRoot.stdout.trim().replace(/\/+$/, '') !== repositoryPath) {
      return { state: 'unavailable', currentBranch: branchName || undefined, message: 'Primary checkout is unavailable.' };
    }
    if (taskRoot.exitCode !== 0 || taskRoot.stdout.trim().replace(/\/+$/, '') !== worktreePath) {
      return { state: 'missing', currentBranch: branchName || undefined, message: 'The recorded worktree path is missing.' };
    }

    const registered = parseWorktreeList(worktreeList.stdout);
    const managedEntry = registered.find((entry) => entry.path === worktreePath);
    if (!managedEntry) {
      return { state: 'missing', currentBranch: branchName || undefined, message: 'The path is no longer registered as a Git worktree.' };
    }
    if (baseBranch.exitCode !== 0 || taskBranch.exitCode !== 0) {
      return { state: 'unavailable', currentBranch: branchName || undefined, message: 'The recorded Git branches could not be inspected.' };
    }

    let creationCommit = identity.baseCommit;
    if (!creationCommit) {
      const reflog = await host.execute(
        `git reflog show --format=%H ${escapeShellPath(`refs/heads/${identity.branch}`)}`,
        { cwd: repositoryPath }
      );
      if (reflog.exitCode === 0) {
        const reflogCommits = reflog.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
        creationCommit = reflogCommits.at(-1);
      }
    }

    const taskCommit = taskBranch.stdout.trim();
    const branchAdvancedSinceCreation = Boolean(
      creationCommit && /^[0-9a-f]{40,64}$/i.test(creationCommit) && taskCommit !== creationCommit
    );
    const worktreeIsOnBaseBranch =
      managedEntry.branch === identity.baseBranch && branchName === identity.baseBranch;
    if (integrated.exitCode === 0 && (worktreeIsOnBaseBranch || branchAdvancedSinceCreation)) {
      return {
        state: 'integrated',
        currentBranch: branchName || undefined,
        isClean,
        message: `Task branch '${identity.branch}' is already integrated into '${identity.baseBranch}'.`,
      };
    }

    if (managedEntry.branch !== identity.branch || branchName !== identity.branch) {
      return {
        state: 'mismatch',
        currentBranch: branchName || undefined,
        isClean,
        message: `Worktree is on '${branchName || 'detached HEAD'}', not recorded branch '${identity.branch}'.`,
      };
    }

    return { state: 'active', currentBranch: branchName, isClean, message: 'Worktree is on its recorded task branch.' };
  }

  /** Verifies ownership identity and clean state immediately before finalization. */
  async resolvePrimaryWorktreePath(host: HostAdapter, worktreePath: string): Promise<string> {
    const list = await host.execute('git worktree list --porcelain', { cwd: worktreePath });
    if (list.exitCode !== 0) {
      throw new Error(`Could not resolve Git worktree registry from '${worktreePath}'`);
    }
    const registered = parseWorktreeList(list.stdout);
    if (registered.length === 0) {
      throw new Error(`Git reported no primary worktree for '${worktreePath}'`);
    }
    return registered[0].path;
  }

  /** Verifies ownership identity and clean state immediately before finalization. */
  async verifyManagedWorktreeForFinalization(
    host: HostAdapter,
    identity: ManagedWorktreeIdentity,
    requireCleanPrimary: boolean,
    requireCleanWorktree = true,
    allowIntegratedWorktree = false
  ): Promise<void> {
    const repositoryPath = identity.repositoryPath.replace(/\/+$/, '');
    const worktreePath = identity.worktreePath.replace(/\/+$/, '');
    const [primaryRoot, worktreeList, taskRoot, taskBranch, taskStatus] = await Promise.all([
      host.execute('git rev-parse --show-toplevel', { cwd: repositoryPath }),
      host.execute('git worktree list --porcelain', { cwd: repositoryPath }),
      host.execute('git rev-parse --show-toplevel', { cwd: worktreePath }),
      host.execute('git branch --show-current', { cwd: worktreePath }),
      host.execute('git status --porcelain=v1 --untracked-files=all', { cwd: worktreePath }),
    ]);

    if (primaryRoot.exitCode !== 0 || primaryRoot.stdout.trim().replace(/\/+$/, '') !== repositoryPath) {
      throw new Error(`Primary checkout '${repositoryPath}' is missing or no longer identifies its recorded repository`);
    }
    if (taskRoot.exitCode !== 0 || taskRoot.stdout.trim().replace(/\/+$/, '') !== worktreePath) {
      throw new Error(`Managed worktree '${worktreePath}' is missing or no longer identifies its recorded path`);
    }
    const currentBranch = taskBranch.stdout.trim();
    const branchIdentityMatches = taskBranch.exitCode === 0 && currentBranch === identity.branch;
    let integratedWorktreeAllowed = false;
    if (!branchIdentityMatches && allowIntegratedWorktree) {
      const merged = await host.execute(
        `git merge-base --is-ancestor ${escapeShellPath(identity.branch)} ${escapeShellPath(identity.baseBranch)}`,
        { cwd: repositoryPath }
      );
      integratedWorktreeAllowed = merged.exitCode === 0 && currentBranch === identity.baseBranch;
    }
    if (!branchIdentityMatches && !integratedWorktreeAllowed) {
      throw new Error(`Managed worktree '${worktreePath}' is not checked out on recorded branch '${identity.branch}'`);
    }
    if (taskStatus.exitCode !== 0) {
      throw new Error(`Could not inspect managed worktree status for '${worktreePath}'`);
    }
    if (requireCleanWorktree && taskStatus.stdout.length > 0) {
      throw new Error('Managed worktree has tracked, untracked, or conflicted changes; commit or remove them before finishing');
    }

    if (worktreeList.exitCode !== 0) {
      throw new Error(`Could not inspect Git worktree registry for '${repositoryPath}'`);
    }
    const registered = parseWorktreeList(worktreeList.stdout);
    if (registered.length === 0 || registered[0].path !== repositoryPath) {
      throw new Error(`Recorded primary checkout '${repositoryPath}' does not match Git's primary worktree`);
    }
    const managedEntry = registered.find((entry) => entry.path === worktreePath);
    const registryMatches = managedEntry && managedEntry.branch === identity.branch;
    const integratedRegistryMatches = allowIntegratedWorktree && managedEntry && managedEntry.branch === identity.baseBranch;
    if (!managedEntry || (!registryMatches && !integratedRegistryMatches)) {
      throw new Error('Recorded worktree path and branch do not match Git\'s worktree registry');
    }

    await this.assertValidLocalBranch(host, repositoryPath, identity.baseBranch, 'base');
    await this.assertValidLocalBranch(host, repositoryPath, identity.branch, 'task');

    if (requireCleanPrimary) {
      const [primaryBranch, primaryStatus] = await Promise.all([
        host.execute('git branch --show-current', { cwd: repositoryPath }),
        host.execute('git status --porcelain=v1 --untracked-files=all', { cwd: repositoryPath }),
      ]);
      if (primaryBranch.exitCode !== 0 || primaryBranch.stdout.trim() !== identity.baseBranch) {
        throw new Error(`Primary checkout must be on recorded base branch '${identity.baseBranch}'`);
      }
      if (primaryStatus.exitCode !== 0) {
        throw new Error(`Could not inspect primary checkout status for '${repositoryPath}'`);
      }
      if (primaryStatus.stdout.length > 0) {
        throw new Error('Primary checkout has tracked, untracked, or conflicted changes; clean it before integrating');
      }
    }
  }

  /** Merges a verified task branch and aborts any failed merge before returning an error. */
  async mergeManagedBranch(host: HostAdapter, identity: ManagedWorktreeIdentity): Promise<void> {
    const merge = await host.execute(`git merge --no-edit ${escapeShellPath(identity.branch)}`, {
      cwd: identity.repositoryPath,
    });
    if (merge.exitCode !== 0) {
      const abort = await host.execute('git merge --abort', { cwd: identity.repositoryPath });
      const [mergeHead, status] = await Promise.all([
        host.execute('git rev-parse -q --verify MERGE_HEAD', { cwd: identity.repositoryPath }),
        host.execute('git status --porcelain=v1 --untracked-files=all', { cwd: identity.repositoryPath }),
      ]);
      if (mergeHead.exitCode === 0 || status.exitCode !== 0 || status.stdout.length > 0) {
        throw new Error('Merge failed and Spawnea could not verify that the primary checkout was restored; inspect it manually');
      }
      const details = merge.stderr.trim() || merge.stdout.trim() || `exit code ${merge.exitCode}`;
      const abortNote = abort.exitCode === 0 ? 'merge was aborted' : 'no active merge remained';
      throw new Error(`Merge failed; ${abortNote}. ${details}`);
    }

    const merged = await host.execute(
      `git merge-base --is-ancestor ${escapeShellPath(identity.branch)} ${escapeShellPath(identity.baseBranch)}`,
      { cwd: identity.repositoryPath }
    );
    if (merged.exitCode !== 0) {
      throw new Error(`Git did not verify '${identity.branch}' as integrated into '${identity.baseBranch}'`);
    }
  }

  /** Safely deletes a branch only after Git confirms it is integrated. */
  async deleteIntegratedBranch(host: HostAdapter, identity: ManagedWorktreeIdentity): Promise<void> {
    const merged = await host.execute(
      `git merge-base --is-ancestor ${escapeShellPath(identity.branch)} ${escapeShellPath(identity.baseBranch)}`,
      { cwd: identity.repositoryPath }
    );
    if (merged.exitCode !== 0) {
      throw new Error(`Task branch '${identity.branch}' is not integrated into '${identity.baseBranch}'`);
    }
    const deletion = await host.execute(`git branch -d -- ${escapeShellPath(identity.branch)}`, {
      cwd: identity.repositoryPath,
    });
    if (deletion.exitCode !== 0) {
      throw new Error(`Failed to safely delete integrated task branch '${identity.branch}'`);
    }
    const remaining = await host.execute(
      `git show-ref --verify --quiet ${escapeShellPath(`refs/heads/${identity.branch}`)}`,
      { cwd: identity.repositoryPath }
    );
    if (remaining.exitCode === 0) {
      throw new Error(`Task branch '${identity.branch}' still exists after Git reported deletion`);
    }
  }

  private async assertValidLocalBranch(
    host: HostAdapter,
    cwd: string,
    branch: string,
    label: string
  ): Promise<void> {
    await this.assertValidLocalBranchName(host, cwd, branch, label);
    const exists = await host.execute(
      `git show-ref --verify --quiet ${escapeShellPath(`refs/heads/${branch}`)}`,
      { cwd }
    );
    if (exists.exitCode !== 0) {
      throw new Error(`Selected ${label} branch '${branch}' does not exist locally`);
    }
  }

  private async assertValidLocalBranchName(
    host: HostAdapter,
    cwd: string,
    branch: string,
    label: string
  ): Promise<void> {
    const valid = await host.execute(`git check-ref-format --branch ${escapeShellPath(branch)}`, { cwd });
    if (valid.exitCode !== 0) {
      throw new Error(`Invalid ${label} branch name '${branch}'`);
    }
  }

  /**
   * Evaluates live Git status on the target host for a repository path.
   */
  async getGitStatus(host: HostAdapter, cwd: string): Promise<GitStatusResult> {
    this.logger.debug('Querying Git status', { serverId: host.serverId, cwd });

    try {
      // 1. Verify that the directory is a Git repository
      const checkRepo = await host.execute('git rev-parse --is-inside-work-tree', { cwd });
      if (checkRepo.exitCode !== 0 || !checkRepo.stdout.trim().includes('true')) {
        return {
          isGitRepo: false,
          branch: '',
          ahead: 0,
          behind: 0,
          isClean: true,
          staged: [],
          unstaged: [],
          untracked: [],
          totalChanges: 0,
        };
      }

      // 2. Query current branch name
      const branchExec = await host.execute('git branch --show-current', { cwd });
      let branch = branchExec.stdout.trim();
      if (!branch) {
        // Fallback for detached HEAD or older git versions
        const headExec = await host.execute('git rev-parse --short HEAD', { cwd });
        branch = headExec.stdout.trim() ? `HEAD (${headExec.stdout.trim()})` : 'HEAD';
      }

      // 3. Query upstream tracking branch and ahead/behind counts
      let trackingBranch: string | undefined;
      let ahead = 0;
      let behind = 0;

      const upstreamExec = await host.execute(
        'git rev-parse --abbrev-ref --symbolic-full-name @{upstream}',
        { cwd }
      );
      if (upstreamExec.exitCode === 0 && upstreamExec.stdout.trim()) {
        trackingBranch = upstreamExec.stdout.trim();

        const countExec = await host.execute(
          'git rev-list --left-right --count HEAD...@{upstream}',
          { cwd }
        );
        if (countExec.exitCode === 0) {
          const parts = countExec.stdout.trim().split(/\s+/);
          if (parts.length >= 2) {
            ahead = parseInt(parts[0], 10) || 0;
            behind = parseInt(parts[1], 10) || 0;
          }
        }
      }

      // 4. Query porcelain v1 status
      const statusExec = await host.execute('git status --porcelain=v1 -uall', { cwd });
      const rawStatus = statusExec.stdout;

      const staged: GitFileStatus[] = [];
      const unstaged: GitFileStatus[] = [];
      const untracked: GitFileStatus[] = [];

      const lines = rawStatus.split('\n');
      for (const line of lines) {
        if (!line || line.length < 3) continue;

        const x = line[0];
        const y = line[1];
        const rest = line.substring(3).trim();

        let path = rest;
        let oldPath: string | undefined;

        if (rest.includes(' -> ')) {
          const arrowParts = rest.split(' -> ');
          oldPath = arrowParts[0].replace(/^["']|["']$/g, '');
          path = arrowParts[1].replace(/^["']|["']$/g, '');
        } else {
          path = rest.replace(/^["']|["']$/g, '');
        }

        // Untracked
        if (x === '?' && y === '?') {
          untracked.push({
            path,
            status: 'untracked',
            staged: false,
            statusCode: '??',
          });
          continue;
        }

        // Staged (Index)
        if (x !== ' ' && x !== '?' && x !== '!') {
          staged.push({
            path,
            oldPath,
            status: mapGitStatusCode(x),
            staged: true,
            statusCode: x,
          });
        }

        // Unstaged (Worktree)
        if (y !== ' ' && y !== '?' && y !== '!') {
          unstaged.push({
            path,
            status: mapGitStatusCode(y),
            staged: false,
            statusCode: y,
          });
        }
      }

      const totalChanges = staged.length + unstaged.length + untracked.length;
      const isClean = totalChanges === 0;

      return {
        isGitRepo: true,
        branch,
        trackingBranch,
        ahead,
        behind,
        isClean,
        staged,
        unstaged,
        untracked,
        totalChanges,
        rawStatus,
      };
    } catch (err: any) {
      this.logger.error('Failed to inspect Git status', err, { serverId: host.serverId, cwd });
      return {
        isGitRepo: false,
        branch: '',
        ahead: 0,
        behind: 0,
        isClean: true,
        staged: [],
        unstaged: [],
        untracked: [],
        totalChanges: 0,
      };
    }
  }

  /**
   * Retrieves and parses Git diff on the target host.
   */
  async getGitDiff(
    host: HostAdapter,
    cwd: string,
    options?: GitDiffOptions
  ): Promise<GitDiffResult> {
    this.logger.debug('Executing Git diff', { serverId: host.serverId, cwd, options });

    try {
      let cmd = 'git diff';
      if (options?.staged || options?.cached) {
        cmd = 'git diff --staged';
      } else {
        cmd = 'git diff HEAD';
      }

      if (options?.filePath) {
        cmd += ` -- ${escapeShellPath(options.filePath)}`;
      }

      const result = await host.execute(cmd, { cwd });
      let rawDiff = result.stdout;

      // If diff is empty and options.filePath is specified, check if it's an untracked file
      if (!rawDiff.trim() && options?.filePath) {
        try {
          const fileRead = await host.readFile(`${cwd}/${options.filePath}`);
          if (fileRead && !fileRead.isBinary) {
            const lines = fileRead.content.split('\n');
            rawDiff = [
              `diff --git a/${options.filePath} b/${options.filePath}`,
              'new file mode 100644',
              '--- /dev/null',
              `+++ b/${options.filePath}`,
              `@@ -0,0 +1,${lines.length} @@`,
              ...lines.map((l) => `+${l}`),
            ].join('\n');
          }
        } catch {
          // If read fails, keep empty diff
        }
      }

      return parseGitDiff(rawDiff);
    } catch (err: any) {
      this.logger.error('Failed to execute Git diff', err, { serverId: host.serverId, cwd });
      return {
        rawDiff: '',
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
        totalFilesChanged: 0,
      };
    }
  }
}

function mapGitStatusCode(char: string): GitFileStatusCode {
  switch (char) {
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'M': return 'modified';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case 'T': return 'typechanged';
    default: return 'modified';
  }
}

function escapeShellPath(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

export function validateCopyFilePath(relativePath: string): void {
  if (!isExactRepositoryRelativePath(relativePath)) {
    throw new Error(`copy_files entry '${relativePath}' must be an exact repository-relative path`);
  }
}

function buildCopyInspectionCommand(
  sourceRoot: string,
  sourcePath: string,
  destinationRoot: string,
  destinationPath: string
): string {
  const sourceRootArg = escapeShellPath(sourceRoot);
  const sourceArg = escapeShellPath(sourcePath);
  const destinationRootArg = escapeShellPath(destinationRoot);
  const destinationArg = escapeShellPath(destinationPath);
  return `
    if test ! -e ${sourceArg} && test ! -L ${sourceArg}; then
      printf MISSING
    elif test -L ${sourceArg}; then
      printf SYMLINK
    elif test ! -f ${sourceArg}; then
      printf NOT_FILE
    elif test -e ${destinationArg} || test -L ${destinationArg}; then
      printf DEST_EXISTS
    else
      source_root=$(realpath -- ${sourceRootArg}) || exit 2
      source_file=$(realpath -- ${sourceArg}) || exit 2
      destination_root=$(realpath -- ${destinationRootArg}) || exit 2
      destination_file=$(realpath -m -- ${destinationArg}) || exit 2
      case "$source_file" in "$source_root"/*) ;; *) printf OUTSIDE; exit 0 ;; esac
      case "$destination_file" in "$destination_root"/*) printf SAFE ;; *) printf OUTSIDE ;; esac
    fi
  `;
}

export function parseWorktreeList(output: string): Array<{ path: string; branch?: string }> {
  return output
    .trim()
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length) ?? '';
      const branchRef = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length);
      return {
        path: path.replace(/\/+$/, ''),
        branch: branchRef?.startsWith('refs/heads/') ? branchRef.slice('refs/heads/'.length) : undefined,
      };
    })
    .filter((entry) => entry.path.length > 0);
}

/**
 * Parses raw unified git diff output into structured GitDiffResult.
 */
export function parseGitDiff(rawDiff: string): GitDiffResult {
  if (!rawDiff || !rawDiff.trim()) {
    return {
      rawDiff: '',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      totalFilesChanged: 0,
    };
  }

  const files: GitDiffFile[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  const fileDiffBlocks = rawDiff.split(/^diff --git /m).filter(Boolean);

  for (const block of fileDiffBlocks) {
    const lines = block.split('\n');
    const headerLine = lines[0] || '';
    const match = headerLine.match(/a\/(.*?)\s+b\/(.*)/);

    const oldPath = match ? match[1] : undefined;
    const path = match ? match[2] : (headerLine.split(' ').pop() || 'unknown');

    let isBinary = false;
    let isNew = false;
    let isDeleted = false;
    let isRenamed = false;
    let additions = 0;
    let deletions = 0;

    const hunks: GitDiffHunk[] = [];
    let currentHunk: GitDiffHunk | null = null;
    let oldLine = 0;
    let newLine = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('new file mode')) {
        isNew = true;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        isDeleted = true;
        continue;
      }
      if (line.startsWith('similarity index') || line.startsWith('rename from')) {
        isRenamed = true;
        continue;
      }
      if (line.startsWith('Binary files ') && line.includes(' differ')) {
        isBinary = true;
        continue;
      }

      // Hunk Header: @@ -oldStart,oldLines +newStart,newLines @@ optional header
      const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/);
      if (hunkMatch) {
        const oldStart = parseInt(hunkMatch[1], 10);
        const oldLines = hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1;
        const newStart = parseInt(hunkMatch[3], 10);
        const newLines = hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1;

        oldLine = oldStart;
        newLine = newStart;

        currentHunk = {
          header: line,
          oldStart,
          oldLines,
          newStart,
          newLines,
          lines: [],
        };
        hunks.push(currentHunk);
        continue;
      }

      if (!currentHunk) continue;

      if (line.startsWith('+') && !line.startsWith('+++')) {
        additions++;
        totalAdditions++;
        currentHunk.lines.push({
          type: 'add',
          content: line.substring(1),
          newLineNumber: newLine++,
        });
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletions++;
        totalDeletions++;
        currentHunk.lines.push({
          type: 'delete',
          content: line.substring(1),
          oldLineNumber: oldLine++,
        });
      } else if (line.startsWith(' ')) {
        currentHunk.lines.push({
          type: 'context',
          content: line.substring(1),
          oldLineNumber: oldLine++,
          newLineNumber: newLine++,
        });
      } else if (line.startsWith('\\ No newline at end of file')) {
        currentHunk.lines.push({
          type: 'context',
          content: line,
        });
      }
    }

    files.push({
      path,
      oldPath: oldPath !== path ? oldPath : undefined,
      additions,
      deletions,
      isBinary,
      isNew,
      isDeleted,
      isRenamed,
      hunks,
    });
  }

  return {
    rawDiff,
    files,
    totalAdditions,
    totalDeletions,
    totalFilesChanged: files.length,
  };
}
