import { appendFileSync, writeFileSync } from 'node:fs';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  namespace: string;
  message: string;
  timestamp: Date;
  context?: Record<string, unknown>;
  error?: Error | { name: string; message: string; stack?: string };
}

export type LogHandler = (entry: LogEntry) => void;

export interface LoggerOptions {
  minLevel?: LogLevel;
  handlers?: LogHandler[];
  sanitize?: boolean;
}

export interface Logger {
  readonly namespace: string;
  readonly minLevel: LogLevel;
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, error?: unknown, context?: Record<string, unknown>): void;
  child(namespace: string): Logger;
}

const LOG_LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const SENSITIVE_KEY_PATTERNS = [
  /pass(word)?/i,
  /passwd/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /auth(orization)?/i,
  /private[_-]?key/i,
  /credential/i,
  /cert(ificate)?/i,
  /ssh[_-]?key/i,
  /access[_-]?token/i,
  /refresh[_-]?token/i,
  /cookie/i,
];

const PRIVATE_KEY_REGEX = /(-----BEGIN [A-Z0-9\s_-]+PRIVATE KEY-----)[\s\S]*?(-----END [A-Z0-9\s_-]+PRIVATE KEY-----)/gi;
const BEARER_TOKEN_REGEX = /Bearer\s+[A-Za-z0-9_\-.~+/=]+/gi;
const API_KEY_REGEX = /(sk-[a-zA-Z0-9_-]{8,}|ghp_[a-zA-Z0-9]{15,}|gho_[a-zA-Z0-9]{15,}|glpat-[a-zA-Z0-9\-_]{15,})/g;
const URL_AUTH_REGEX = /([a-zA-Z0-9+.-]+:\/\/)([^:/\s@]+):([^@/\s]+)@/gi;
const OP_REFERENCE_REGEX = /op:\/\/[^\r\n]*/gi;
const registeredSensitiveValues = new Map<string, number>();

/** Registers a resolved value for global log/error redaction during its in-memory lifetime. */
export function registerSensitiveValue(value: string): () => void {
  if (!value) return () => undefined;
  registeredSensitiveValues.set(value, (registeredSensitiveValues.get(value) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = registeredSensitiveValues.get(value) ?? 0;
    if (count <= 1) registeredSensitiveValues.delete(value);
    else registeredSensitiveValues.set(value, count - 1);
  };
}

/**
 * Masks sensitive patterns inside a string (keys, tokens, basic auth credentials).
 */
export function maskSensitiveString(str: string): string {
  if (typeof str !== 'string') {
    return str;
  }

  let sanitized = str;
  for (const value of [...registeredSensitiveValues.keys()].sort((a, b) => b.length - a.length)) {
    sanitized = sanitized.split(value).join('[REDACTED RESOLVED VALUE]');
  }
  sanitized = sanitized.replace(OP_REFERENCE_REGEX, '[REDACTED 1PASSWORD REFERENCE]');
  sanitized = sanitized.replace(PRIVATE_KEY_REGEX, '$1\n[REDACTED PRIVATE KEY]\n$2');
  sanitized = sanitized.replace(BEARER_TOKEN_REGEX, 'Bearer [REDACTED]');
  sanitized = sanitized.replace(API_KEY_REGEX, '[REDACTED TOKEN]');
  sanitized = sanitized.replace(URL_AUTH_REGEX, '$1$2:[REDACTED]@');

  return sanitized;
}

/**
 * Checks if an object key is considered sensitive.
 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Recursively masks sensitive data in objects, arrays, errors, or primitives.
 */
export function maskSensitiveData<T>(data: T, seen = new WeakSet<object>()): T {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    return maskSensitiveString(data) as unknown as T;
  }

  if (typeof data !== 'object') {
    return data;
  }

  if (data instanceof Date) {
    return new Date(data.getTime()) as unknown as T;
  }

  if (data instanceof Error) {
    const sanitizedError = new Error(maskSensitiveString(data.message));
    sanitizedError.name = data.name;
    if (data.stack) {
      sanitizedError.stack = maskSensitiveString(data.stack);
    }
    return sanitizedError as unknown as T;
  }

  if (seen.has(data as object)) {
    return '[CIRCULAR]' as unknown as T;
  }
  seen.add(data as object);

  if (Array.isArray(data)) {
    return data.map((item) => maskSensitiveData(item, seen)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = maskSensitiveData(value, seen);
    }
  }

  return result as T;
}

export class DefaultLogger implements Logger {
  readonly namespace: string;
  readonly minLevel: LogLevel;
  private readonly handlers: LogHandler[];
  private readonly sanitize: boolean;

  constructor(namespace: string, options: LoggerOptions = {}) {
    this.namespace = namespace;
    this.minLevel = options.minLevel ?? 'info';
    this.handlers = options.handlers ?? [DefaultLogger.defaultConsoleHandler];
    this.sanitize = options.sanitize !== false;
  }

  private shouldLog(level: Exclude<LogLevel, 'silent'>): boolean {
    return LOG_LEVEL_SEVERITY[level] >= LOG_LEVEL_SEVERITY[this.minLevel];
  }

  private emit(
    level: Exclude<LogLevel, 'silent'>,
    message: string,
    error?: unknown,
    context?: Record<string, unknown>,
  ): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const processedMessage = this.sanitize ? maskSensitiveString(message) : message;
    const processedContext = this.sanitize && context ? maskSensitiveData(context) : context;

    let processedError: Error | { name: string; message: string; stack?: string } | undefined;
    if (error !== undefined) {
      if (error instanceof Error) {
        processedError = this.sanitize ? maskSensitiveData(error) : error;
      } else if (typeof error === 'string') {
        const msg = this.sanitize ? maskSensitiveString(error) : error;
        processedError = { name: 'Error', message: msg };
      } else if (typeof error === 'object' && error !== null) {
        processedError = this.sanitize
          ? (maskSensitiveData(error as Record<string, unknown>) as unknown as {
              name: string;
              message: string;
              stack?: string;
            })
          : (error as unknown as { name: string; message: string; stack?: string });
      }
    }

    const entry: LogEntry = {
      level,
      namespace: this.namespace,
      message: processedMessage,
      timestamp: new Date(),
      context: processedContext,
      error: processedError,
    };

    for (const handler of this.handlers) {
      try {
        handler(entry);
      } catch {
        // Silently ignore handler failures to prevent crashing logging path
      }
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.emit('debug', message, undefined, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.emit('info', message, undefined, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.emit('warn', message, undefined, context);
  }

  error(message: string, error?: unknown, context?: Record<string, unknown>): void {
    this.emit('error', message, error, context);
  }

  child(subNamespace: string): Logger {
    return new DefaultLogger(`${this.namespace}:${subNamespace}`, {
      minLevel: this.minLevel,
      handlers: this.handlers,
      sanitize: this.sanitize,
    });
  }

  static defaultConsoleHandler(entry: LogEntry): void {
    const formattedPrefix = `[${entry.timestamp.toISOString()}] [${entry.level.toUpperCase()}] [${entry.namespace}]: ${entry.message}`;
    switch (entry.level) {
      case 'debug':
        if (entry.context) {
          console.debug(formattedPrefix, entry.context);
        } else {
          console.debug(formattedPrefix);
        }
        break;
      case 'info':
        if (entry.context) {
          console.info(formattedPrefix, entry.context);
        } else {
          console.info(formattedPrefix);
        }
        break;
      case 'warn':
        if (entry.context) {
          console.warn(formattedPrefix, entry.context);
        } else {
          console.warn(formattedPrefix);
        }
        break;
      case 'error':
        if (entry.error && entry.context) {
          console.error(formattedPrefix, entry.error, entry.context);
        } else if (entry.error) {
          console.error(formattedPrefix, entry.error);
        } else if (entry.context) {
          console.error(formattedPrefix, entry.context);
        } else {
          console.error(formattedPrefix);
        }
        break;
    }
  }
}

export function createLogger(namespace: string, options?: LoggerOptions): Logger {
  return new DefaultLogger(namespace, options);
}

/**
 * Creates a file log handler that formats and appends log entries to disk.
 * Optionally wipes/resets the file when initialized.
 */
export function createFileLogHandler(filePath: string, wipeOnStart = false): LogHandler {
  if (wipeOnStart) {
    try {
      writeFileSync(
        filePath,
        `=== Spawnea Execution Log [Started: ${new Date().toISOString()}] ===\n\n`,
        'utf8'
      );
    } catch {
      // Ignore initial write failure
    }
  }

  return (entry: LogEntry) => {
    try {
      const timestamp = entry.timestamp.toISOString();
      const level = entry.level.toUpperCase().padEnd(5);
      let line = `[${timestamp}] [${level}] [${entry.namespace}]: ${entry.message}`;

      if (entry.context && Object.keys(entry.context).length > 0) {
        line += `\n  Context: ${JSON.stringify(entry.context, null, 2).replace(/\n/g, '\n  ')}`;
      }

      if (entry.error) {
        if (entry.error instanceof Error) {
          line += `\n  Error: ${entry.error.stack || entry.error.message}`;
        } else if (typeof entry.error === 'object' && entry.error !== null) {
          line += `\n  Error: ${(entry.error as any).stack || (entry.error as any).message || JSON.stringify(entry.error)}`;
        }
      }

      line += '\n';
      appendFileSync(filePath, line, 'utf8');
    } catch {
      // Ignore append errors
    }
  };
}
