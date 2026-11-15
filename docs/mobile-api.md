# Spawnea Mobile HTTP API Guide

This guide describes how to enable, authenticate, rotate keys, and securely access the private Spawnea Mobile HTTP API from a mobile client.

---

## 1. Overview & Architecture

The mobile API is a **thin HTTP adapter** over Spawnea's internal control service (`AgentControlService` and `SessionManager`), designed for mobile companion clients (such as Spawnea Mobile) to list sessions, view session status and output, page conversation history, and submit prompts.

### Key Architectural Axioms
1. **Disabled by Default:** The HTTP API listener is completely disabled until explicitly enabled in `config.yaml`.
2. **Strict Loopback Binding:** The server listens **exclusively on IPv4 loopback (`127.0.0.1`)**. It cannot be configured to bind to public or external wildcard network interfaces.
3. **Argon2id Authentication:** The desktop configuration stores **only an Argon2id hash** of the secret key. Requests authenticate with `Authorization: Bearer <key>`. Failed authentication attempts never echo or log the candidate key.
4. **Invalid Auth Safeguard:** If `api.enabled: true` is set but `key_hash` is missing, empty, or not a valid Argon2id hash, Spawnea **never opens a listener**.
5. **Polling Only:** The mobile client queries status, output, and history via HTTP polling. No WebSockets, SSE, or background push daemons are used.
6. **Honest Live vs. Historical Provenance:** What does not come from live active terminal capture or persistent agent transcript files is reported via legacy `available: false` (`status: "unavailable"`, `output: null`, `items: []`) so existing mobile clients never display stale snapshots as fresh live content. Bounded SQLite snapshots (`64 KiB` output, `50` parsed screen items replaced per observation even when Mobile is disabled, `7`-day retention within a `32 MiB` aggregate payload budget, without continuous PTY transcript recording) are exposed additively via `lastOutput`, `storedItems`, freshness flags (`freshness`, `stale`, `stored`, `updatedAt`, `capturedAt`, `truncated`, `version`), and explicit pagination cursor states (`cursorStatus`, `cursorExpired`). Persisted snapshots are stored locally in unredacted cleartext (readable by the local OS user and authorized callers) and enforce owner-only `0600` permissions on supported POSIX systems before writes (failing closed if unavailable; Windows relies on user profile ACLs).
7. **Rate & Size Limits:** Requests are bounded to 128 KiB, with dual-tier rate limiting (default 300 authenticated requests per minute, 10 failed authentication attempts per minute).

---

## 2. Key Generation & Configuration

### Step 1: Generate an Argon2id Hash

Use the offline `spawnea hash-key` command to generate an Argon2id hash for your chosen secret key (minimum 32 characters). Supplying the key via standard input is recommended to keep it out of shell history:

```bash
# Piped via stdin (recommended; the key must be at least 32 characters)
printf '%s' "$MOBILE_SECRET_KEY" | spawnea hash-key

# JSON output
printf '%s' "$MOBILE_SECRET_KEY" | spawnea hash-key --json
```

Output:
```text
$argon2id$v=19$m=19456,t=2,p=1$c2FtcGxlc2FsdA$samplehashvalue...
```

Keep the plaintext passphrase safe on your mobile device (e.g., in mobile secure storage / keychain).

### Step 2: Configure `config.yaml`

Add the `api` section to your active operational catalog (by default `~/.config/spawnea/config.yaml`, or `$SPAWNEA_USER_DATA_DIR/config.yaml`):

```yaml
version: 1

api:
  enabled: true
  port: 5757 # Optional; defaults to 5757
  key_hash: "$argon2id$v=19$m=19456,t=2,p=1$c2FtcGxlc2FsdA$samplehashvalue..."

hosts:
  local:
    name: Local Workstation
    enabled: true
    projects:
      ...
```

Restart Spawnea desktop for the configuration to take effect. If `key_hash` is missing or invalid, Spawnea logs a warning and leaves the network port closed.

---

## 3. Key Rotation

To rotate the mobile access key:

1. Generate a new Argon2id hash with `printf '%s' "$NEW_KEY" | spawnea hash-key` (minimum 32 characters).
2. Update the `key_hash` field in `config.yaml`.
3. Restart the Spawnea desktop app.
4. Update the key stored on your mobile device.

The previous key is invalidated immediately once the desktop app restarts.

---

## 4. Secure Mobile Access via Tailscale Serve

Because Spawnea binds exclusively to `127.0.0.1`, network access from your mobile phone must be routed through an authenticated encrypted mesh configured **outside Spawnea**.

We recommend **Tailscale Serve** within your private Tailnet.

### Setup Instructions

1. Ensure both your desktop machine and your mobile phone are connected to your private Tailnet.
2. On your desktop workstation, expose the loopback port to your private Tailnet using Tailscale Serve:
   ```bash
   # Expose local port 5757 to your private Tailnet on HTTPS port 5757:
   tailscale serve --bg --https=5757 http://127.0.0.1:5757
   ```
   *(Alternatively, omit `--https=5757` to serve on default HTTPS port 443).*
3. Check the status:
   ```bash
   tailscale serve status
   ```
4. In Spawnea Mobile, configure the server URL to your desktop's Tailscale node address:
   `https://<your-machine>.<your-tailnet>.ts.net:5757` (or without `:5757` if using default port 443)
   and enter your plaintext secret key.

### Security Warning: No Funnel

> [!CAUTION]
> **DO NOT USE TAILSCALE FUNNEL.**
> Tailscale Funnel exposes the local port to the entire public internet. Spawnea Mobile API is designed strictly for private tailnet access. Never run `tailscale funnel` with Spawnea.

---

## 5. Endpoints Reference

All requests must include the header:
```http
Authorization: Bearer <key>
```

All JSON responses include `"apiVersion": "v1"`.

### 1. List Sessions
- **Endpoint:** `GET /api/v1/sessions`
- **Response:**
  ```json
  {
    "apiVersion": "v1",
    "sessions": [
      {
        "id": "sess-123",
        "name": "Backend feature",
        "parentSessionId": null,
        "childAlias": null,
        "task": "Implement feature",
        "host": { "id": "local", "name": "Local Workstation" },
        "project": { "id": "proj-1", "name": "Spawnea" },
        "harness": { "id": "local:codex", "name": "Codex", "command": "codex" },
        "worktree": { "managed": true, "path": "/path/to/worktree", "branch": "feature-x", "baseBranch": "main" },
        "tmuxSessionName": "spawnea-sess-123",
        "status": "idle",
        "active": true,
        "createdAt": "2026-11-04T12:00:00.000Z",
        "lastActivityAt": "2026-11-04T12:05:00.000Z"
      }
    ]
  }
  ```

### 2. Session Detail
- **Endpoint:** `GET /api/v1/sessions/:id`
- **Response:**
  ```json
  {
    "apiVersion": "v1",
    "session": { ... }
  }
  ```

### 3. Current Output
- **Endpoint:** `GET /api/v1/sessions/:id/output?lines=200`
- **Query Parameters:** `lines` (optional, default 200, max 2000)
- **Response (Live Session):**
  ```json
  {
    "apiVersion": "v1",
    "sessionId": "sess-123",
    "available": true,
    "status": "live",
    "output": "...terminal text...",
    "freshness": "live",
    "stale": false,
    "stored": false,
    "updatedAt": "2026-11-15T12:00:00.000Z",
    "truncated": false
  }
  ```
- **Response (Disconnected / Capture Failed / After Restart):**
  When a bounded snapshot exists in SQLite, `available`, `status`, and `output` keep their unavailable legacy shape while `lastOutput` and additive metadata expose the retained snapshot:
  ```json
  {
    "apiVersion": "v1",
    "sessionId": "sess-123",
    "available": false,
    "status": "unavailable",
    "output": null,
    "freshness": "historical",
    "stale": true,
    "stored": true,
    "updatedAt": "2026-11-15T11:58:00.000Z",
    "capturedAt": "2026-11-15T11:58:00.000Z",
    "truncated": false,
    "version": 3,
    "lastOutput": {
      "output": "...last retained snapshot...",
      "updatedAt": "2026-11-15T11:58:00.000Z",
      "capturedAt": "2026-11-15T11:58:00.000Z",
      "stale": true,
      "truncated": false,
      "version": 3
    },
    "message": "Current terminal output is unavailable because the session is not running. Retained historical output is exposed in lastOutput."
  }
  ```
  If no snapshot is stored, `lastOutput` is `null`, `freshness` is `"unavailable"`, `stale` is `false`, `stored` is `false`, `updatedAt` is `null`, `capturedAt` is `null`, and `version` is `null`.

### 4. Conversation History
- **Endpoint:** `GET /api/v1/sessions/:id/history?limit=20`
- **Query Parameters:**
  - `limit` (optional, default 20, max 50)
  - `cursor` (optional, resumption pagination cursor)
- **Response (Claude/Codex Agent Transcripts):**
  Persistent transcript responses include `available: true` and `source: "transcript"`. When the session is active, `freshness` is `"live"` and `stale` is `false`; when the session is `disconnected` or `done`, `freshness` is `"historical"` and `stale` is `true` (`stored: false` in both cases because transcripts come from agent transcript files rather than Spawnea's SQLite snapshot cache). Transcript pagination returns explicit `cursorStatus` (`initial`, `valid`, `eof`, `expired`, `invalid`, `mismatched`) and `cursorExpired` when malformed, past-EOF, or file/head-mismatched cursors reset to offset `0`:
  ```json
  {
    "apiVersion": "v1",
    "sessionId": "sess-123",
    "available": true,
    "source": "transcript",
    "items": [
      {
        "id": "item-1",
        "role": "user",
        "text": "Please refactor the database connector",
        "source": "transcript"
      },
      {
        "id": "item-2",
        "role": "agent",
        "text": "Refactoring completed.",
        "source": "transcript"
      }
    ],
    "cursor": "offset:4096",
    "hasMore": false,
    "freshness": "live",
    "stale": false,
    "stored": false,
    "truncated": false,
    "cursorStatus": "initial",
    "cursorExpired": false
  }
  ```
- **Response (Screen-only sessions when inactive or capture failed):**
  Legacy `available: false` and `items: []` remain intact; any retained snapshot items are returned in `storedItems` (with `storedHasMore`, `cursor`, `cursorStatus`, and `cursorExpired` distinguishing `initial`, `valid`, `eof`, `expired`, `invalid`, `mismatched`, and `restarted`). Stored snapshot cursors are opaque tokens bound to the owning session, a non-reused `snapshotGeneration`, and snapshot `version`, so cursors from another session, a stale snapshot version, or a pruned/recreated snapshot row return `mismatched` or `expired` (`cursorExpired: true`) instead of `eof`:
  ```json
  {
    "apiVersion": "v1",
    "sessionId": "sess-123",
    "available": false,
    "source": "screen",
    "items": [],
    "cursor": "stored:<opaque-token>",
    "hasMore": false,
    "freshness": "historical",
    "stale": true,
    "stored": true,
    "updatedAt": "2026-11-15T11:58:00.000Z",
    "capturedAt": "2026-11-15T11:58:00.000Z",
    "truncated": false,
    "version": 2,
    "storedItems": [
      {
        "id": "item-1",
        "role": "user",
        "text": "Echo test",
        "source": "screen"
      }
    ],
    "storedHasMore": false,
    "cursorStatus": "initial",
    "cursorExpired": false,
    "message": "Session history is unavailable because this session does not have agent transcript files and the terminal is not active. Retained historical items are exposed in storedItems."
  }
  ```

### 5. Send Message
- **Endpoint:** `POST /api/v1/sessions/:id/message`
- **Headers:** `Content-Type: application/json`
- **Body:**
  ```json
  {
    "message": "Run the tests and summarize failures",
    "clientRequestId": "uuid-or-unique-client-id"
  }
  ```
- **Requirements:**
  - `message` (or `prompt`): Non-empty string, maximum 32,000 characters (returns `400 invalid_request` if missing or empty).
  - `clientRequestId`: Non-empty string, maximum 128 characters (returns `400 invalid_request` if missing, empty, or exceeds 128 characters). Mobile clients must supply a unique client request ID so retries can never double-send.
- **Response (Delivered):**
  ```json
  {
    "apiVersion": "v1",
    "sessionId": "sess-123",
    "delivered": true,
    "deliveryMethod": "tmux",
    "status": "working",
    "turnId": "turn-uuid",
    "replayed": false,
    "message": "Prompt submitted. Use spawnea_get_turn to read or wait for the response."
  }
  ```
- **Response (Uncertain Delivery):**
  ```json
  {
    "apiVersion": "v1",
    "sessionId": "sess-123",
    "delivered": false,
    "deliveryMethod": "tmux",
    "status": "unknown",
    "turnId": "turn-uuid",
    "replayed": false,
    "message": "Prompt text was delivered but Enter could not be confirmed. Inspect the terminal; do not resend the prompt. The request is retained to prevent duplicate text."
  }
  ```
- **Idempotency Rule:** Sending the exact same `clientRequestId` and `prompt` returns the previous response with `"replayed": true`. Reusing `clientRequestId` with different prompt content returns `409 Conflict`.

---

## 6. Protection, Rate Limiting & Performance

- **Dual-Tier Rate Limiting:**
  - **Authenticated Requests:** Governed by an authenticated polling rate limit (default 300 requests/minute), sized to accommodate mobile polling across session list, detail, output, and history endpoints.
  - **Failed Authentication:** Governed by a strict unauthenticated failure limit (default 10 failed attempts/minute). Once exhausted, further attempts receive HTTP `429 Too Many Requests` with a `Retry-After` header prior to running Argon2, preventing brute-force exhaustion without locking out authenticated clients.
- **In-Memory Token Hash Cache:**
  - Upon initial Argon2id verification, the SHA-256 digest of the accepted token is retained in memory. Subsequent polling requests verify against this digest in constant time (`crypto.timingSafeEqual`), executing in sub-millisecond time without repeated Argon2 CPU load.
  - Raw secret keys are never stored in memory or written to disk or logs.
  - The cache is automatically cleared when the desktop server closes or restarts.
- **Request & Response Size Boundaries:**
  - Maximum request body: 128 KiB (HTTP `413 Payload Too Large` returned on excess).
  - Maximum prompt text: 32,000 characters.
  - Bounded history page size: at most 200 items / 512 KiB per page response, with continuation available through returned cursors (`hasMore: true`).
