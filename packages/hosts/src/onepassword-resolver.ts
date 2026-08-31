import { spawn, type SpawnOptions } from 'node:child_process';
import {
  SecretResolutionError,
  isOnePasswordReference,
  registerSensitiveValue,
  type SecretBackedPort,
  type SecretReference,
} from '@spawnea/domain';

export type SecretFieldKind = 'ssh_target' | 'ssh_user' | 'ssh_port' | 'project_path';

export interface ResolvedValueLease<T> {
  value: T;
  sensitive: boolean;
  release: () => void;
}

export interface OnePasswordResolverOptions {
  executablePath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  spawnProcess?: typeof spawn;
}

// Control characters are intentionally rejected from secret references.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_REGEX = /[\x00-\x1f\x7f]/;

export class OnePasswordResolver {
  private readonly executablePath: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly spawnProcess: typeof spawn;

  constructor(options: OnePasswordResolverOptions = {}) {
    this.executablePath = options.executablePath ?? 'op';
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  public async resolveString(
    value: string,
    fieldPath: string,
    kind: Exclude<SecretFieldKind, 'ssh_port'>
  ): Promise<ResolvedValueLease<string>> {
    if (!isOnePasswordReference(value)) {
      return { value, sensitive: false, release: () => undefined };
    }
    const resolved = await this.readReference(value, fieldPath);
    const validated = this.validateString(resolved, fieldPath, kind);
    return { value: validated, sensitive: true, release: registerSensitiveValue(validated) };
  }

  public async resolvePort(
    value: SecretBackedPort | undefined,
    fieldPath: string
  ): Promise<ResolvedValueLease<number | undefined>> {
    if (value === undefined || typeof value === 'number') {
      return { value, sensitive: false, release: () => undefined };
    }
    if (!isOnePasswordReference(value)) throw new SecretResolutionError('invalid_value', fieldPath);
    const resolved = await this.readReference(value, fieldPath);
    if (!/^\d+$/.test(resolved)) throw new SecretResolutionError('invalid_value', fieldPath);
    const port = Number(resolved);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new SecretResolutionError('invalid_value', fieldPath);
    }
    return { value: port, sensitive: true, release: registerSensitiveValue(resolved) };
  }

  private validateString(value: string, fieldPath: string, kind: Exclude<SecretFieldKind, 'ssh_port'>): string {
    if (!value || value !== value.trim() || CONTROL_CHARACTER_REGEX.test(value)) {
      throw new SecretResolutionError('invalid_value', fieldPath);
    }
    if ((kind === 'ssh_target' || kind === 'ssh_user') && /\s/.test(value)) {
      throw new SecretResolutionError('invalid_value', fieldPath);
    }
    return value;
  }

  private readReference(reference: SecretReference, fieldPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let outputTooLarge = false;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const options: SpawnOptions = {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      };
      const child = this.spawnProcess(
        this.executablePath,
        ['read', '--no-newline', '--', reference],
        options
      );
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, this.timeoutMs);

      const fail = (error: SecretResolutionError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };

      child.on('error', (error: NodeJS.ErrnoException) => {
        fail(new SecretResolutionError(error.code === 'ENOENT' ? 'cli_missing' : 'process_failed', fieldPath));
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > this.maxOutputBytes) {
          outputTooLarge = true;
          child.kill('SIGKILL');
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > this.maxOutputBytes) {
          outputTooLarge = true;
          child.kill('SIGKILL');
          return;
        }
        stderrChunks.push(chunk);
      });
      child.on('close', (code) => {
        if (settled) return;
        clearTimeout(timer);
        if (timedOut) return fail(new SecretResolutionError('timeout', fieldPath));
        if (outputTooLarge) return fail(new SecretResolutionError('output_too_large', fieldPath));
        if (code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString('utf8').toLowerCase();
          if (/sign in|signed in|authenticat|authoriz|unauthorized|forbidden|permission/.test(stderr)) {
            return fail(new SecretResolutionError('authentication_required', fieldPath));
          }
          if (/not found|could not find|does not exist|isn't an item/.test(stderr)) {
            return fail(new SecretResolutionError('reference_not_found', fieldPath));
          }
          return fail(new SecretResolutionError('process_failed', fieldPath));
        }
        try {
          const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(stdoutChunks));
          if (!decoded) return fail(new SecretResolutionError('invalid_value', fieldPath));
          settled = true;
          resolve(decoded);
        } catch {
          fail(new SecretResolutionError('invalid_value', fieldPath));
        }
      });
    });
  }
}
