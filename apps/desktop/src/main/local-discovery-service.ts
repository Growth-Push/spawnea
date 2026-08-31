import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { delimiter, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  IDENTIFIER_REGEX,
  type CatalogDiscoveryMutation,
  type LocalDiscoveryApplyResult,
  type LocalDiscoveryPreviewResult,
  type LocalDiscoveryScanResult,
  type LocalDiscoverySelection,
  type LocalHarnessCandidateId,
  type LocalHarnessDiscoverySuggestion,
  type LocalHostDiscoverySuggestion,
  type Logger,
} from '@spawnea/domain';
import { CatalogManager, type CatalogDiscoveryPreview } from './catalog-manager.js';

const SENSITIVE_MARKERS = new Set(['pass', 'password', 'passwd', 'pwd', 'token', 'secret', 'key', 'credential', 'credentials']);
const RESERVED_ALIASES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'ip6-allnodes',
  'ip6-allrouters',
  'broadcasthost',
]);
const HOST_ALIAS_REGEX = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
const CONTROL_CHARACTER_REGEX = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

const HARNESS_CANDIDATES: ReadonlyArray<{
  candidateId: LocalHarnessCandidateId;
  name: string;
  commands: readonly string[];
}> = [
  { candidateId: 'claude', name: 'Claude Code', commands: ['claude'] },
  { candidateId: 'codex', name: 'Codex CLI', commands: ['codex'] },
  { candidateId: 'hermes', name: 'Hermes', commands: ['hermes'] },
  { candidateId: 'opencode', name: 'OpenCode', commands: ['opencode'] },
  { candidateId: 'shell', name: 'Interactive Shell', commands: ['zsh', 'bash', 'sh'] },
];

export interface ParsedHostsSuggestion {
  alias: string;
  address: string;
}

/** Strict parser: one suspicious field rejects its entire /etc/hosts line. */
export function parseHostsSuggestions(source: string): ParsedHostsSuggestion[] {
  const results: ParsedHostsSuggestion[] = [];
  const seen = new Set<string>();

  for (const rawLine of source.split(/\r?\n/)) {
    if (CONTROL_CHARACTER_REGEX.test(rawLine)) continue;
    const content = rawLine.split('#', 1)[0].trim();
    if (!content) continue;
    const fields = content.split(/\s+/);
    if (fields.length < 2 || isIP(fields[0]) === 0) continue;

    const aliases = fields.slice(1);
    const suspicious = aliases.some((alias) => {
      const lowered = alias.toLowerCase();
      const segments = lowered.split(/[._-]+/);
      return !HOST_ALIAS_REGEX.test(alias)
        || alias.includes('=')
        || alias.includes('/')
        || alias.includes('://')
        || segments.some((segment) => SENSITIVE_MARKERS.has(segment));
    });
    if (suspicious) continue;

    for (const alias of aliases) {
      const normalized = alias.toLowerCase();
      if (RESERVED_ALIASES.has(normalized) || seen.has(normalized)) continue;
      seen.add(normalized);
      results.push({ alias, address: fields[0] });
    }
  }

  return results;
}

async function resolveExecutable(commands: readonly string[], pathValue: string): Promise<{ command: string; path: string } | null> {
  const directories = pathValue.split(delimiter).filter((entry) => entry && isAbsolute(entry));
  for (const command of commands) {
    for (const directory of directories) {
      const candidatePath = join(directory, command);
      try {
        const info = await stat(candidatePath);
        if (!info.isFile()) continue;
        await access(candidatePath, constants.X_OK);
        return { command, path: candidatePath };
      } catch {
        // A missing or non-executable allowlisted candidate is simply unavailable.
      }
    }
  }
  return null;
}

function suggestedIdentifier(alias: string): string {
  const normalized = alias.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return IDENTIFIER_REGEX.test(normalized) ? normalized : `host-${normalized || 'local'}`;
}

interface ScanSnapshot {
  result: LocalDiscoveryScanResult;
  hostsByKey: Map<string, LocalHostDiscoverySuggestion>;
  harnessesById: Map<LocalHarnessCandidateId, LocalHarnessDiscoverySuggestion>;
}

export interface LocalDiscoveryServiceOptions {
  hostsPath?: string;
  pathValue?: string;
  readHosts?: (path: string) => Promise<string>;
  resolveHarness?: (commands: readonly string[], pathValue: string) => Promise<{ command: string; path: string } | null>;
}

export class LocalDiscoveryService {
  private readonly hostsPath: string;
  private readonly pathValue: string;
  private readonly readHosts: (path: string) => Promise<string>;
  private readonly resolveHarness: typeof resolveExecutable;
  private readonly scans = new Map<string, ScanSnapshot>();
  private readonly previews = new Map<string, CatalogDiscoveryPreview>();

  constructor(
    private readonly catalogManager: CatalogManager,
    private readonly logger: Logger,
    options: LocalDiscoveryServiceOptions = {}
  ) {
    this.hostsPath = options.hostsPath ?? '/etc/hosts';
    this.pathValue = options.pathValue ?? process.env.PATH ?? '';
    this.readHosts = options.readHosts ?? ((path) => readFile(path, 'utf8'));
    this.resolveHarness = options.resolveHarness ?? resolveExecutable;
  }

  public async scan(): Promise<LocalDiscoveryScanResult> {
    const warnings: string[] = [];
    let parsedHosts: ParsedHostsSuggestion[] = [];
    try {
      parsedHosts = parseHostsSuggestions(await this.readHosts(this.hostsPath));
    } catch {
      warnings.push('Could not read the local hosts file. No host suggestions are shown.');
    }

    const hosts = parsedHosts.map((entry) => ({
      key: randomUUID(),
      alias: entry.alias,
      address: entry.address,
      suggestedHostId: suggestedIdentifier(entry.alias),
      suggestedName: entry.alias,
    }));
    const harnesses = await Promise.all(HARNESS_CANDIDATES.map(async (candidate) => {
      const resolved = await this.resolveHarness(candidate.commands, this.pathValue);
      return {
        candidateId: candidate.candidateId,
        name: candidate.name,
        command: resolved?.command ?? candidate.commands[0],
        found: Boolean(resolved),
        ...(resolved ? { resolvedPath: resolved.path } : {}),
      } satisfies LocalHarnessDiscoverySuggestion;
    }));
    const catalog = this.catalogManager.getActiveCatalog();
    const localHosts = catalog
      ? Object.values(catalog.hosts).filter((host) => !host.ssh).map((host) => ({ id: host.id, name: host.name }))
      : [];
    if (localHosts.length === 0) {
      warnings.push('No local catalog host exists. Harness suggestions cannot be selected until a host without ssh configuration is added.');
    }

    const scanId = randomUUID();
    const result = { scanId, hosts, harnesses, localHosts, warnings };
    this.scans.clear();
    this.scans.set(scanId, {
      result,
      hostsByKey: new Map(hosts.map((host) => [host.key, host])),
      harnessesById: new Map(harnesses.map((harness) => [harness.candidateId, harness])),
    });
    this.previews.clear();
    this.logger.info('Explicit local discovery scan completed', {
      hostSuggestionCount: hosts.length,
      harnessFoundCount: harnesses.filter((harness) => harness.found).length,
      warningCount: warnings.length,
    });
    return result;
  }

  public async preview(input: LocalDiscoverySelection): Promise<LocalDiscoveryPreviewResult> {
    const snapshot = this.scans.get(input.scanId);
    if (!snapshot) return { success: false, changes: [], errors: ['Discovery results expired. Run the scan again.'] };
    if (input.hosts.length === 0 && input.harnesses.length === 0) {
      return { success: false, changes: [], errors: ['Select at least one suggestion to preview.'] };
    }

    const mutation: CatalogDiscoveryMutation = { hosts: [], harnesses: [] };
    for (const selected of input.hosts) {
      const suggestion = snapshot.hostsByKey.get(selected.suggestionKey);
      if (!suggestion) return { success: false, changes: [], errors: ['A selected host is not part of the latest scan.'] };
      mutation.hosts.push({
        id: selected.hostId.trim(),
        name: selected.name.trim(),
        target: suggestion.alias,
        ...(selected.user?.trim() ? { user: selected.user.trim() } : {}),
        ...(selected.port ? { port: selected.port } : {}),
        mode: selected.mode,
      });
    }
    for (const selected of input.harnesses) {
      const suggestion = snapshot.harnessesById.get(selected.candidateId);
      if (!suggestion?.found || !suggestion.resolvedPath) {
        return { success: false, changes: [], errors: [`${selected.candidateId} was not found by the latest scan.`] };
      }
      if (!snapshot.result.localHosts.some((host) => host.id === selected.hostId)) {
        return { success: false, changes: [], errors: ['A selected harness target is not a local catalog host.'] };
      }
      mutation.harnesses.push({
        hostId: selected.hostId,
        id: selected.harnessId.trim(),
        name: selected.name.trim(),
        command: suggestion.resolvedPath,
        mode: selected.mode,
      });
    }

    const result = await this.catalogManager.previewDiscoveryMutation(mutation);
    if (!result.success) {
      return { success: false, changes: [], errors: result.errors.map((error) => `${error.path}: ${error.message}`) };
    }
    const previewId = randomUUID();
    this.previews.clear();
    this.previews.set(previewId, result.preview);
    return { success: true, previewId, changes: result.preview.changes, errors: [] };
  }

  public async apply(previewId: string): Promise<LocalDiscoveryApplyResult> {
    const preview = this.previews.get(previewId);
    if (!preview) {
      return {
        success: false,
        catalog: this.catalogManager.getActiveCatalog(),
        filePath: this.catalogManager.getCatalogPath(),
        errors: [{ path: 'preview', message: 'Preview expired. Scan and review the changes again.' }],
        conflict: false,
      };
    }
    this.previews.delete(previewId);
    const result = await this.catalogManager.applyDiscoveryPreview(preview);
    this.logger.info('Confirmed local discovery catalog mutation finished', {
      success: result.success,
      conflict: result.conflict ?? false,
      changeCount: preview.changes.length,
    });
    return result;
  }
}
