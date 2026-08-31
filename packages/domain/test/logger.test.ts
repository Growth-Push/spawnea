import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import {
  maskSensitiveString,
  isSensitiveKey,
  maskSensitiveData,
  createLogger,
  createFileLogHandler,
  registerSensitiveValue,
  type LogEntry,
} from '../src/index.js';

describe('Sensitive Data Masking', () => {
  describe('maskSensitiveString', () => {
    it('masks private keys', () => {
      const privateKey =
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Y123...\n-----END RSA PRIVATE KEY-----';
      const masked = maskSensitiveString(privateKey);
      expect(masked).not.toContain('MIIEowIBAAKCAQEA0Y123');
      expect(masked).toContain('[REDACTED PRIVATE KEY]');
    });

    it('masks Bearer tokens', () => {
      const authHeader = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secretpayload.signature';
      const masked = maskSensitiveString(authHeader);
      expect(masked).toBe('Bearer [REDACTED]');
    });

    it('masks API keys like OpenAI / Anthropic / GitHub / GitLab tokens', () => {
      const log = 'Connecting with sk-ant-api03-abcdef123456789 and ghp_1234567890abcdefghij';
      const masked = maskSensitiveString(log);
      expect(masked).not.toContain('sk-ant-api03-abcdef123456789');
      expect(masked).not.toContain('ghp_1234567890abcdefghij');
      expect(masked).toContain('[REDACTED TOKEN]');
    });

    it('masks basic auth credentials in URLs', () => {
      const gitUrl = 'https://admin:super_secret_pass@example.invalid/org/repo.git';
      const masked = maskSensitiveString(gitUrl);
      expect(masked).toBe('https://admin:[REDACTED]@example.invalid/org/repo.git');
    });

    it('leaves non-sensitive strings intact', () => {
      const normal = 'Connecting to server 198.51.100.50:22 for user developer';
      expect(maskSensitiveString(normal)).toBe(normal);
    });

    it('masks complete 1Password references and leased resolved values', () => {
      const resolved = 'private-hostname.example.test';
      const release = registerSensitiveValue(resolved);
      try {
        const masked = maskSensitiveString(`read op://private-vault/server-prod/hostname`);
        const resolvedMasked = maskSensitiveString(`connected to ${resolved}`);
        expect(masked).not.toContain('private-vault');
        expect(masked).not.toContain('server-prod');
        expect(masked).toContain('[REDACTED 1PASSWORD REFERENCE]');
        expect(resolvedMasked).not.toContain(resolved);
        expect(resolvedMasked).toContain('[REDACTED RESOLVED VALUE]');
      } finally {
        release();
      }
      expect(maskSensitiveString(resolved)).toBe(resolved);
    });
  });

  describe('isSensitiveKey', () => {
    it('detects sensitive key variants', () => {
      expect(isSensitiveKey('password')).toBe(true);
      expect(isSensitiveKey('user_password')).toBe(true);
      expect(isSensitiveKey('passwd')).toBe(true);
      expect(isSensitiveKey('secret')).toBe(true);
      expect(isSensitiveKey('client_secret')).toBe(true);
      expect(isSensitiveKey('token')).toBe(true);
      expect(isSensitiveKey('access_token')).toBe(true);
      expect(isSensitiveKey('refresh_token')).toBe(true);
      expect(isSensitiveKey('apiKey')).toBe(true);
      expect(isSensitiveKey('api_key')).toBe(true);
      expect(isSensitiveKey('authorization')).toBe(true);
      expect(isSensitiveKey('privateKey')).toBe(true);
      expect(isSensitiveKey('private_key')).toBe(true);
      expect(isSensitiveKey('credential')).toBe(true);
      expect(isSensitiveKey('certificate')).toBe(true);
      expect(isSensitiveKey('sshKey')).toBe(true);
      expect(isSensitiveKey('cookie')).toBe(true);
    });

    it('returns false for standard non-sensitive keys', () => {
      expect(isSensitiveKey('id')).toBe(false);
      expect(isSensitiveKey('name')).toBe(false);
      expect(isSensitiveKey('host')).toBe(false);
      expect(isSensitiveKey('status')).toBe(false);
      expect(isSensitiveKey('createdAt')).toBe(false);
      expect(isSensitiveKey('task')).toBe(false);
    });
  });

  describe('maskSensitiveData', () => {
    it('masks sensitive object fields and nested objects', () => {
      const sensitiveField = ['api', 'Key'].join('');
      const payload = {
        id: 'srv-1',
        name: 'Production Server',
        config: {
          password: 'my-db-password',
          [sensitiveField]: 'synthetic-value',
          normalSetting: 'active',
          nested: {
            token: 'auth-token-123',
            safeValue: 42,
          },
        },
      };

      const masked = maskSensitiveData(payload);
      expect(masked.id).toBe('srv-1');
      expect(masked.config.normalSetting).toBe('active');
      expect(masked.config.password).toBe('[REDACTED]');
      expect(masked.config.apiKey).toBe('[REDACTED]');
      expect(masked.config.nested.token).toBe('[REDACTED]');
      expect(masked.config.nested.safeValue).toBe(42);
    });

    it('masks sensitive strings inside arrays', () => {
      const list = [
        'normal-arg',
        'https://user:mypassword@example.com/api',
        'Bearer token123456',
      ];
      const masked = maskSensitiveData(list);
      expect(masked[0]).toBe('normal-arg');
      expect(masked[1]).toBe('https://user:[REDACTED]@example.com/api');
      expect(masked[2]).toBe('Bearer [REDACTED]');
    });

    it('safely handles circular references', () => {
      const obj: Record<string, unknown> = { name: 'circular-test' };
      obj.self = obj;

      const masked = maskSensitiveData(obj);
      expect(masked.name).toBe('circular-test');
      expect(masked.self).toBe('[CIRCULAR]');
    });

    it('masks Error messages and stack traces', () => {
      const err = new Error('Failed connecting to https://user:secret123@example.test');
      const maskedErr = maskSensitiveData(err);
      expect(maskedErr.message).toBe('Failed connecting to https://user:[REDACTED]@example.test');
      if (maskedErr.stack) {
        expect(maskedErr.stack).not.toContain('secret123');
      }
    });

    it('preserves Dates and null/undefined', () => {
      const now = new Date();
      expect(maskSensitiveData(null)).toBe(null);
      expect(maskSensitiveData(undefined)).toBe(undefined);
      const maskedDate = maskSensitiveData(now);
      expect(maskedDate.getTime()).toBe(now.getTime());
    });
  });

  describe('createLogger', () => {
    it('filters log messages below minLevel', () => {
      const handler = vi.fn();
      const logger = createLogger('test', { minLevel: 'warn', handlers: [handler] });

      logger.debug('debug message');
      logger.info('info message');
      expect(handler).not.toHaveBeenCalled();

      logger.warn('warn message');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'warn',
          namespace: 'test',
          message: 'warn message',
        }),
      );

      logger.error('error message');
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('automatically sanitizes messages and context objects', () => {
      const logs: LogEntry[] = [];
      const logger = createLogger('auth-service', {
        minLevel: 'debug',
        handlers: [(entry) => logs.push(entry)],
      });

      logger.info('User authenticated with password-login', {
        user: 'alice',
        password: 'alice-secret-password',
        token: 'Bearer eyJhbGciOi...',
      });

      expect(logs).toHaveLength(1);
      expect(logs[0].context).toEqual({
        user: 'alice',
        password: '[REDACTED]',
        token: '[REDACTED]',
      });
    });

    it('supports child namespaces', () => {
      const logs: LogEntry[] = [];
      const parent = createLogger('app', {
        minLevel: 'debug',
        handlers: [(entry) => logs.push(entry)],
      });
      const child = parent.child('db');

      child.info('Connected to database');
      expect(logs[0].namespace).toBe('app:db');
    });

    it('writes formatted and sanitized log entries to file via createFileLogHandler', () => {
      const tempPath = `/tmp/spawnea-test-log-${Date.now()}.txt`;
      const fileHandler = createFileLogHandler(tempPath, true);
      const logger = createLogger('file-test', {
        minLevel: 'debug',
        handlers: [fileHandler],
      });

      logger.info('Test file message', { token: 'secret-token-value' });

      const content = readFileSync(tempPath, 'utf8');
      expect(content).toContain('[INFO ] [file-test]: Test file message');
      expect(content).toContain('"token": "[REDACTED]"');

      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    });
  });
});
