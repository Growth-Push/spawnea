import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from 'node:http';
import type { Socket, AddressInfo } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  DEFAULT_MOBILE_API_PORT,
  SPAWNEA_CONTROL_API_VERSION,
  type CatalogApiConfig,
  type Logger,
} from '@spawnea/domain';
import type { AgentControlService } from './agent-control-service.js';
import type { SessionManager } from './session-manager.js';
import { classifyControlError } from './control-operations.js';
import {
  extractBearerToken,
  validateArgon2idConfigHashDetailed,
  verifyKey,
} from './mobile-api-auth.js';

export const MAX_REQUEST_BODY_BYTES = 128 * 1024; // 128 KiB
export const DEFAULT_AUTH_RATE_LIMIT_MAX = 300; // Sized for client polling (list/detail/history)
export const DEFAULT_FAILED_AUTH_RATE_LIMIT_MAX = 10; // Strict limit for failed auth attempts
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
export const MAX_CLIENT_REQUEST_ID_LENGTH = 128;

export interface MobileApiServerOptions {
  control: AgentControlService;
  sessionManager: SessionManager;
  logger: Logger;
  config?: CatalogApiConfig | null;
  port?: number;
  profile?: string;
  authenticatedRateLimitMax?: number;
  failedAuthRateLimitMax?: number;
  rateLimitMax?: number; // Overrides authenticated limit for backward compatibility in tests
  rateLimitWindowMs?: number;
  maxBodyBytes?: number;
}

export class SimpleRateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private timestamps: number[] = [];

  constructor(maxRequests = DEFAULT_AUTH_RATE_LIMIT_MAX, windowMs = DEFAULT_RATE_LIMIT_WINDOW_MS) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  check(): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const now = Date.now();
    const threshold = now - this.windowMs;
    this.timestamps = this.timestamps.filter((t) => t > threshold);

    if (this.timestamps.length >= this.maxRequests) {
      const oldest = this.timestamps[0];
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      return { allowed: false, retryAfterSeconds };
    }

    this.timestamps.push(now);
    return { allowed: true };
  }

  reset(): void {
    this.timestamps = [];
  }
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  data: unknown,
  extraHeaders?: Record<string, string>
): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(
  res: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
  extraHeaders?: Record<string, string>
): void {
  sendJson(
    res,
    statusCode,
    {
      apiVersion: SPAWNEA_CONTROL_API_VERSION,
      error: { code, message },
    },
    extraHeaders
  );
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number
): Promise<
  | { ok: true; body: any }
  | { ok: false; status: number; code: string; message: string; closeConnection?: boolean }
> {
  const contentLength = req.headers['content-length'];
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    return {
      ok: false,
      status: 413,
      code: 'payload_too_large',
      message: `Request body exceeds maximum size of ${maxBytes} bytes`,
      closeConnection: true,
    };
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytesReceived = 0;
    let rejected = false;

    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      bytesReceived += chunk.length;
      if (bytesReceived > maxBytes) {
        rejected = true;
        chunks.length = 0;
        req.pause();
        resolve({
          ok: false,
          status: 413,
          code: 'payload_too_large',
          message: `Request body exceeds maximum size of ${maxBytes} bytes`,
          closeConnection: true,
        });
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (rejected) return;
      const fullBuffer = Buffer.concat(chunks);
      const raw = fullBuffer.toString('utf8');
      if (!raw.trim()) {
        resolve({ ok: true, body: {} });
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve({ ok: true, body: parsed });
      } catch {
        resolve({
          ok: false,
          status: 400,
          code: 'invalid_request',
          message: 'Malformed JSON in request body',
        });
      }
    });

    req.on('error', (err) => {
      if (rejected) return;
      resolve({
        ok: false,
        status: 400,
        code: 'invalid_request',
        message: `Stream error: ${err.message}`,
      });
    });
  });
}

export class MobileApiServer {
  private readonly control: AgentControlService;
  private readonly sessionManager: SessionManager;
  private readonly logger: Logger;
  private readonly config?: CatalogApiConfig | null;
  private readonly options: MobileApiServerOptions;
  private readonly profile?: string;
  private readonly authenticatedRateLimiter: SimpleRateLimiter;
  private readonly failedAuthRateLimiter: SimpleRateLimiter;
  private readonly maxBodyBytes: number;
  private readonly sockets = new Set<Socket>();
  private server: HttpServer | null = null;
  private listeningPort: number | null = null;
  private cachedTokenHash: Buffer | null = null;

  constructor(options: MobileApiServerOptions) {
    this.options = options;
    this.control = options.control;
    this.sessionManager = options.sessionManager;
    this.logger = options.logger;
    this.config = options.config;
    this.profile = options.profile;
    this.authenticatedRateLimiter = new SimpleRateLimiter(
      options.authenticatedRateLimitMax ?? options.rateLimitMax ?? DEFAULT_AUTH_RATE_LIMIT_MAX,
      options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS
    );
    this.failedAuthRateLimiter = new SimpleRateLimiter(
      options.failedAuthRateLimitMax ?? DEFAULT_FAILED_AUTH_RATE_LIMIT_MAX,
      options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS
    );
    this.maxBodyBytes = options.maxBodyBytes ?? MAX_REQUEST_BODY_BYTES;
  }

  isListening(): boolean {
    return this.server !== null && this.server.listening;
  }

  getPort(): number | null {
    return this.listeningPort;
  }

  getAddress(): AddressInfo | null {
    if (!this.server) return null;
    const addr = this.server.address();
    return typeof addr === 'object' && addr !== null ? addr : null;
  }

  getProfile(): string | undefined {
    return this.profile;
  }

  async start(): Promise<{ port: number; host: string } | null> {
    if (!this.config || this.config.enabled !== true) {
      this.logger.info('Mobile HTTP API is disabled by configuration');
      return null;
    }

    this.cachedTokenHash = null;

    const validation = await validateArgon2idConfigHashDetailed(this.config.key_hash);
    if (!validation.ok) {
      if (validation.reason === 'native_load_failure') {
        this.logger.error(
          'Mobile HTTP API is enabled, but native Argon2 module failed to load; listener not opened',
          { error: validation.error instanceof Error ? validation.error.message : String(validation.error) }
        );
      } else {
        this.logger.warn(
          'Mobile HTTP API is enabled, but key_hash is missing or not a valid Argon2id hash; listener not opened'
        );
      }
      return null;
    }

    if (this.server) {
      throw new Error('Mobile HTTP API server is already running');
    }

    const portToUse =
      this.options.port !== undefined
        ? this.options.port
        : (this.config.port ?? DEFAULT_MOBILE_API_PORT);

    if (!Number.isSafeInteger(portToUse) || portToUse < 0 || portToUse > 65535) {
      this.logger.warn('Mobile HTTP API has invalid port; listener not opened', { port: portToUse });
      return null;
    }

    const server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        this.logger.error('Unhandled Mobile API error', {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) {
          sendError(res, 500, 'operation_failed', 'Internal server error');
        }
      });
    });

    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });

    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off('listening', onListening);
        this.server = null;
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      // Strictly loopback only
      server.listen(portToUse, '127.0.0.1');
    });

    const addr = server.address() as AddressInfo;
    this.listeningPort = addr.port;
    this.logger.info('Mobile HTTP API listening on loopback', {
      port: this.listeningPort,
      host: '127.0.0.1',
    });
    return { port: this.listeningPort, host: '127.0.0.1' };
  }

  async close(): Promise<void> {
    this.cachedTokenHash = null;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    if (this.server) {
      const s = this.server;
      this.server = null;
      this.listeningPort = null;
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 1. Remote address check: loopback only
    const remoteAddr = req.socket.remoteAddress;
    if (
      remoteAddr &&
      remoteAddr !== '127.0.0.1' &&
      remoteAddr !== '::ffff:127.0.0.1' &&
      remoteAddr !== '::1'
    ) {
      req.socket.destroy();
      return;
    }

    // 2. Authenticate Bearer token (with in-memory SHA-256 hash cache and failed-auth rate limiting)
    const token = extractBearerToken(req.headers['authorization']);
    if (!token) {
      const failedCheck = this.failedAuthRateLimiter.check();
      if (!failedCheck.allowed) {
        res.setHeader('Retry-After', String(failedCheck.retryAfterSeconds));
        sendError(res, 429, 'rate_limited', 'Too many failed authentication attempts. Please try again later.');
        return;
      }
      this.logger.warn('Mobile API unauthorized request: missing or malformed Bearer token', {
        method: req.method,
        path: req.url,
      });
      sendError(res, 401, 'unauthorized', 'Unauthorized');
      return;
    }

    const candidateHash = createHash('sha256').update(token, 'utf8').digest();
    let isKeyValid = false;

    if (
      this.cachedTokenHash !== null &&
      candidateHash.length === this.cachedTokenHash.length &&
      timingSafeEqual(candidateHash, this.cachedTokenHash)
    ) {
      // Cached valid token: constant-time match, skip expensive Argon2 verification
      isKeyValid = true;
    } else {
      // Uncached token: check failed-auth rate limit before executing expensive Argon2
      const failedCheck = this.failedAuthRateLimiter.check();
      if (!failedCheck.allowed) {
        res.setHeader('Retry-After', String(failedCheck.retryAfterSeconds));
        sendError(res, 429, 'rate_limited', 'Too many failed authentication attempts. Please try again later.');
        return;
      }

      isKeyValid = await verifyKey(this.config?.key_hash, token);
      if (isKeyValid) {
        // Cache the SHA-256 digest of the accepted token (never store raw token)
        this.cachedTokenHash = candidateHash;
      }
    }

    if (!isKeyValid) {
      // CRITICAL: NEVER echo or log the candidate token
      this.logger.warn('Mobile API unauthorized request: invalid token', {
        method: req.method,
        path: req.url,
      });
      sendError(res, 401, 'unauthorized', 'Unauthorized');
      return;
    }

    // 3. Authenticated rate limit check (sized for polling, e.g. 300/min)
    const authRateCheck = this.authenticatedRateLimiter.check();
    if (!authRateCheck.allowed) {
      res.setHeader('Retry-After', String(authRateCheck.retryAfterSeconds));
      sendError(res, 429, 'rate_limited', 'Too many requests. Please try again later.');
      return;
    }

    // 4. URL routing
    const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const pathParts = parsedUrl.pathname.split('/').filter(Boolean);

    // All endpoints reside under /api/v1/sessions
    if (pathParts[0] !== 'api' || pathParts[1] !== 'v1' || pathParts[2] !== 'sessions') {
      sendError(res, 404, 'not_found', 'Not found');
      return;
    }

    // GET /api/v1/sessions
    if (pathParts.length === 3) {
      if (req.method === 'GET') {
        await this.handleListSessions(res);
        return;
      }
      sendError(res, 405, 'invalid_request', `Method '${req.method}' not allowed on /api/v1/sessions`);
      return;
    }

    let sessionId: string;
    try {
      sessionId = decodeURIComponent(pathParts[3]);
    } catch {
      sendError(res, 400, 'invalid_request', 'Malformed session ID');
      return;
    }

    // GET /api/v1/sessions/:id
    if (pathParts.length === 4) {
      if (req.method === 'GET') {
        await this.handleSessionDetail(sessionId, res);
        return;
      }
      sendError(res, 405, 'invalid_request', `Method '${req.method}' not allowed on /api/v1/sessions/:id`);
      return;
    }

    // Sub-resources: /api/v1/sessions/:id/<subResource>
    if (pathParts.length === 5) {
      const subResource = pathParts[4];

      if (subResource === 'output' && req.method === 'GET') {
        await this.handleCurrentOutput(sessionId, parsedUrl.searchParams, res);
        return;
      }

      if (subResource === 'history' && req.method === 'GET') {
        await this.handleHistory(sessionId, parsedUrl.searchParams, res);
        return;
      }

      if (subResource === 'message' && req.method === 'POST') {
        const bodyRes = await readJsonBody(req, this.maxBodyBytes);
        if (!bodyRes.ok) {
          if (bodyRes.closeConnection) {
            res.once('finish', () => {
              req.destroy();
            });
            sendError(res, bodyRes.status, bodyRes.code, bodyRes.message, {
              Connection: 'close',
            });
          } else {
            sendError(res, bodyRes.status, bodyRes.code, bodyRes.message);
          }
          return;
        }
        await this.handleSendMessage(sessionId, bodyRes.body, res);
        return;
      }
    }

    sendError(res, 404, 'not_found', 'Not found');
  }

  private async handleListSessions(res: ServerResponse): Promise<void> {
    const state = await this.control.getState();
    sendJson(res, 200, {
      apiVersion: SPAWNEA_CONTROL_API_VERSION,
      sessions: state.sessions,
    });
  }

  private async handleSessionDetail(sessionId: string, res: ServerResponse): Promise<void> {
    const state = await this.control.getState();
    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session) {
      sendError(res, 404, 'not_found', `Session '${sessionId}' not found`);
      return;
    }
    sendJson(res, 200, {
      apiVersion: SPAWNEA_CONTROL_API_VERSION,
      session,
    });
  }

  private async handleCurrentOutput(
    sessionId: string,
    searchParams: URLSearchParams,
    res: ServerResponse
  ): Promise<void> {
    const state = await this.control.getState();
    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session) {
      sendError(res, 404, 'not_found', `Session '${sessionId}' not found`);
      return;
    }

    const linesParam = searchParams.get('lines');
    let lines = 200;
    if (linesParam) {
      const parsed = parseInt(linesParam, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        lines = Math.min(parsed, 2000);
      }
    }

    // Check if session is currently active/live (not disconnected or done)
    const isLiveStatus = session.status !== 'disconnected' && session.status !== 'done';

    let output: string | null = null;
    let available = false;

    if (isLiveStatus) {
      try {
        if (typeof (this.sessionManager as any).captureSessionTerminalDetailed === 'function') {
          const capture = await (this.sessionManager as any).captureSessionTerminalDetailed(sessionId, lines);
          if (capture.success) {
            output = capture.output;
            available = true;
          } else {
            output = null;
            available = false;
          }
        } else {
          output = await this.sessionManager.captureSessionTerminal(sessionId, lines);
          available = true;
        }
      } catch {
        output = null;
        available = false;
      }
    }

    if (!available) {
      sendJson(res, 200, {
        apiVersion: SPAWNEA_CONTROL_API_VERSION,
        sessionId,
        available: false,
        status: 'unavailable',
        output: null,
        message: 'Current terminal output is unavailable because the session is not running.',
      });
      return;
    }

    sendJson(res, 200, {
      apiVersion: SPAWNEA_CONTROL_API_VERSION,
      sessionId,
      available: true,
      status: 'live',
      output,
    });
  }

  private async handleHistory(
    sessionId: string,
    searchParams: URLSearchParams,
    res: ServerResponse
  ): Promise<void> {
    const state = await this.control.getState();
    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session) {
      sendError(res, 404, 'not_found', `Session '${sessionId}' not found`);
      return;
    }

    const limitParam = searchParams.get('limit');
    let limit = 20; // Default: last 20 exchanges
    if (limitParam) {
      const parsed = parseInt(limitParam, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.min(parsed, 50);
      }
    }
    const cursor = searchParams.get('cursor') || undefined;

    const historyResult = await this.sessionManager.getSessionHistory(sessionId, {
      limit,
      cursor,
      mode: cursor ? 'forward' : 'recent_exchanges',
      recentExchanges: cursor ? undefined : limit,
    });

    if (historyResult.source === 'transcript') {
      // Transcript from Claude/Codex agent files is persistent across restarts
      sendJson(res, 200, {
        apiVersion: SPAWNEA_CONTROL_API_VERSION,
        sessionId,
        available: true,
        source: 'transcript',
        items: historyResult.items,
        cursor: historyResult.cursor,
        hasMore: historyResult.hasMore ?? false,
      });
      return;
    }

    // If source is 'screen': check if session is currently active and terminal capture succeeded
    const isLive = session.status !== 'disconnected' && session.status !== 'done';

    if (!isLive || historyResult.captureSuccess === false) {
      // After restart, when session is disconnected, or when terminal capture failed, screen history is unavailable
      sendJson(res, 200, {
        apiVersion: SPAWNEA_CONTROL_API_VERSION,
        sessionId,
        available: false,
        source: 'screen',
        items: [],
        cursor: historyResult.cursor,
        hasMore: false,
        message:
          !isLive
            ? 'Session history is unavailable because this session does not have agent transcript files and the terminal is not active.'
            : 'Session history is unavailable because the terminal capture failed.',
      });
      return;
    }

    sendJson(res, 200, {
      apiVersion: SPAWNEA_CONTROL_API_VERSION,
      sessionId,
      available: true,
      source: 'screen',
      items: historyResult.items,
      cursor: historyResult.cursor,
      hasMore: historyResult.hasMore ?? false,
    });
  }

  private async handleSendMessage(
    sessionId: string,
    body: Record<string, unknown>,
    res: ServerResponse
  ): Promise<void> {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendError(res, 400, 'invalid_request', 'Request body must be a JSON object');
      return;
    }

    const rawPrompt =
      typeof body.prompt === 'string'
        ? body.prompt
        : typeof body.message === 'string'
          ? body.message
          : '';
    const promptText = rawPrompt.trim();

    if (!promptText) {
      sendError(res, 400, 'invalid_request', 'Prompt or message text is required');
      return;
    }

    if (promptText.length > 32_000) {
      sendError(res, 400, 'invalid_request', 'Prompt text must be 32,000 characters or fewer');
      return;
    }

    const clientRequestId =
      typeof body.clientRequestId === 'string' ? body.clientRequestId.trim() : '';

    if (!clientRequestId) {
      sendError(res, 400, 'invalid_request', 'clientRequestId is required');
      return;
    }

    if (clientRequestId.length > MAX_CLIENT_REQUEST_ID_LENGTH) {
      sendError(
        res,
        400,
        'invalid_request',
        `clientRequestId must be ${MAX_CLIENT_REQUEST_ID_LENGTH} characters or fewer`
      );
      return;
    }

    try {
      const result = await this.control.sendPrompt({
        target: sessionId,
        prompt: promptText,
        clientRequestId,
      });

      sendJson(res, 200, {
        apiVersion: SPAWNEA_CONTROL_API_VERSION,
        sessionId: result.sessionId,
        delivered: result.delivered,
        deliveryMethod: result.deliveryMethod,
        status: result.status,
        turnId: result.turnId,
        replayed: result.replayed ?? false,
        message: result.message,
      });
    } catch (error) {
      const classified = classifyControlError(error);
      const statusMap: Record<string, number> = {
        not_found: 404,
        conflict: 409,
        needs_human: 422,
        invalid_request: 400,
        unauthorized: 401,
        operation_failed: 500,
      };
      const httpStatus = statusMap[classified.code] || 500;
      sendError(res, httpStatus, classified.code, classified.message);
    }
  }
}
