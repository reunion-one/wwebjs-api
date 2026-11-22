# Reunion WWebJS service

This repository is the pinned WhatsApp Web service used by Reunion COMM. It wraps `whatsapp-web.js` behind a local REST/callback API and contains Reunion-specific session recovery, catch-up-source readiness, callback, and graceful-shutdown behavior.

The Reunion superproject pins the exact reviewed revision through its gitlink. Production installation uses `npm ci`; `postinstall` applies the tracked `patch-package` patches. Do not replace the pinned `whatsapp-web.js` revision or remove those patches without revalidating restored-session behavior and the repository test cycle.

## Production deployment contract

Bootstrap renders the production `.env` and runs this service directly as:

```text
node server.js
```

The production configuration is private and loopback-only:

- `HOST` is a literal loopback address;
- `PORT` comes from bootstrap `WWEBJS_PORT`;
- `BASE_WEBHOOK_URL` points to COMM's loopback `/whatsapp-webhook` endpoint;
- `AUTO_START_SESSIONS=FALSE`;
- `ENABLE_WEBSOCKET=FALSE`;
- `ENABLE_SWAGGER_ENDPOINT=FALSE`;
- `ENABLE_WEB_UI=FALSE`;
- LocalAuth state lives under the configured persistent `SESSIONS_PATH`;
- Chromium/headless/proxy settings come from bootstrap configuration.

The service is not a public ingress surface. COMM and bootstrap are its production callers.

## Selected session ownership

Reunion production uses one selected WhatsApp session for the configured agent phone. Bootstrap derives the session ID from the canonical agent E.164 number by removing the leading `+`.

WWebJS does not choose the production session. Because production sets `AUTO_START_SESSIONS=FALSE`, bootstrap starts the listener, queries the derived selected session, and starts that session only if the service reports it absent. Sibling LocalAuth directories are not enumerated or auto-started by the production lifecycle.

A persistent LocalAuth directory is reusable across ordinary service restarts. If the saved authentication is still valid, the selected session reconnects without QR pairing. If authentication is required, the session exposes QR state for bootstrap/operator handling.

`/ping` proves process liveness only. Session `CONNECTED` proves authentication/socket state; it does not prove startup history/catch-up readiness.

## Graceful shutdown and LocalAuth

`server.js` handles `SIGTERM` and `SIGINT` as application shutdown signals. Shutdown is idempotent and:

1. visits both active and initializing session IDs;
2. calls the session-preserving `destroySession()` path;
3. waits for browser/client teardown;
4. closes the HTTP server;
5. exits `0` on successful shutdown.

`destroySession()` is the normal service-stop path. It destroys browser/client state and removes in-memory/session-runtime state but does **not** call WhatsApp logout and does **not** delete the LocalAuth directory.

`deleteSession()` is a destructive administrative path: it logs out when possible and removes session storage. Do not use logout/delete semantics for normal bootstrap stop, restart, test-cycle cleanup, or deployment update.

The production systemd unit uses `KillMode=mixed` with a bounded stop timeout so the main Node process gets the graceful-shutdown opportunity while leftover child processes are still bounded by systemd.

## Restored-session browser bridge

The tracked `patch-package` patch under `patches/` is required for restored LocalAuth sessions. A browser page is not treated as fully injected merely because `window.WWebJS` exists; the browser-to-Node event bridge must also be attached. Navigation/page recovery reinjects when that bridge is incomplete.

This boundary preserves callbacks such as `message_create` after reconnecting a saved session and keeps send operations fail-closed while the injected bridge is unavailable.

## Catch-up-source readiness

WWebJS owns WhatsApp-Web-specific synchronization interpretation. It derives an additive `catchupSourceReady` state from provider/browser synchronization signals rather than asking COMM to interpret raw RECENT-history, offline-delivery, socket, or `ready` events.

Every new/reinitialized client lifecycle starts fail-closed with catch-up-source readiness false. Readiness transitions are delivered to COMM's internal loopback lifecycle endpoint independently of ordinary public callback filtering. A false transition invalidates downstream readiness; a true transition allows COMM to re-read the state and perform its own Reunion catch-up convergence.

This separation means:

- session `CONNECTED` is not historical-sync completion;
- disabled ordinary callbacks do not suppress internal lifecycle readiness delivery;
- COMM remains the owner of canonical WhatsApp catch-up completion.

## Webhook and API behavior

Ordinary WhatsApp events are delivered to `BASE_WEBHOOK_URL` when webhook delivery is enabled. Per-session callback overrides, WebSocket mode, Swagger UI, and the session-management web UI exist as service capabilities, but the Reunion production configuration keeps WebSocket/Swagger/UI disabled and uses the bootstrap-rendered COMM callback URL.

The REST surface includes session lifecycle/status/QR endpoints and client/group/message operations. `swagger.json` is the generated OpenAPI description; regenerate it with:

```bash
npm run swagger
```

## Local development and validation

Node.js 20 or newer is required.

```bash
npm ci
cp .env.example .env
npm run config:check
npm test
npm start
```

`.env.example` describes standalone local defaults. In particular, standalone `AUTO_START_SESSIONS` defaults to true when unset; the Reunion production environment explicitly renders it false and bootstrap owns selected-session startup.

Repository-level production-fidelity validation is run from the superproject through `test_harness/`. The WWebJS-specific offline phase runs this submodule's Jest suite, and live phases additionally validate the authenticated selected session, phone parsing, COMM callback path, restart continuity, and clean production lifecycle behavior.

## Security and disclaimer

This service uses an unofficial WhatsApp Web client and must be treated as a private integration component. Reunion production binds it to loopback rather than exposing it directly to the internet. WhatsApp may change or restrict unofficial-client behavior without notice.

This project is not affiliated with, authorized by, or endorsed by WhatsApp or Meta. Third-party names and marks belong to their respective owners.

The project is distributed under the MIT License; see `LICENSE.md`.
