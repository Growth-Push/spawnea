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
6. **No Custom Persistence:** What does not come from agent files (e.g. live terminal tail or screen-based history) is reported as unavailable after a desktop restart, never as live.
7. **Rate & Size Limits:** Requests are bounded to 128 KiB, with dual-tier rate limiting (default 300 authenticated requests per minute, 10 failed authentication attempts per minute).

---

## 2. Key Generation & Configuration

### Step 1: Generate an Argon2id Hash

Use the offline `spawnea hash-key` command to generate an Argon2id hash for your chosen secret key:

```bash
# Using an argument
spawnea hash-key "your-secure-random-passphrase"

# Using a flag
spawnea hash-key --key "your-secure-random-passphrase"

# JSON output
spawnea hash-key "your-secure-random-passphrase" --json
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

1. Generate a new Argon2id hash using `spawnea hash-key "new-passphrase"`.
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
    "output": "...terminal text..."
  }
  ```
- **Response (Disconnected / After Restart):**
  ```json
  {
    "apiVersion": "v1",
    "sessionId": "sess-123",
    "available": false,
    "status": "unavailable",
    "output": null,
    "message": "Current terminal output is unavailable because the session is not running."
  }
  ```

### 4. Conversation History
- **Endpoint:** `GET /api/v1/sessions/:id/history?limit=20`
- **Query Parameters:**
  - `limit` (optional, default 20, max 50)
  - `cursor` (optional, resumption pagination cursor)
- **Response (Claude/Codex Agent Transcripts):**
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
    "hasMore": false
  }
  ```
- **Response (Screen-only sessions after restart):**
  ```json
  {
    "apiVersion": "v1",
    "sessionId": "sess-123",
    "available": false,
    "source": "screen",
    "items": [],
    "message": "Session history is unavailable because this session does not have agent transcript files and the terminal is not active."
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
  - `clientRequestId`: Non-empty string (returns `400 invalid_request` if missing or empty). Mobile clients must supply a unique client request ID so retries can never double-send.
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
