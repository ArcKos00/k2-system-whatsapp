# WhatsApp API Gateway

REST API gateway over [`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js).
Built with **TypeScript + Express + tsoa**, secured with **Keycloak** (bearer JWT),
documented with **Swagger UI**, and DI via **tsyringe**.

## Features

- `POST /messages/send` — send text + base64 attachments (JSON).
- `POST /messages/send-with-files` — send text + uploaded files (multipart).
- `GET /health` — liveness/readiness (unauthenticated).
- `GET /qr` — login QR as a PNG while authentication is pending (404 once linked).
- `GET /docs` — Swagger UI; `GET /openapi.json` — raw spec.
- WhatsApp session persisted via `LocalAuth` (QR printed to console on first run).
- Per-message throttle to reduce ban risk.
- Keycloak JWT validation against the realm JWKS (RS256), optional role checks.

## Project structure

```
.
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── package.json
├── tsconfig.json
├── tsoa.json                     # tsoa spec + routes config
└── src
    ├── server.ts                 # entry point: init WhatsApp, then listen
    ├── app.ts                    # Express app: swagger, routes, error handling
    ├── ioc.ts                    # tsoa ↔ tsyringe DI bridge
    ├── config/env.ts             # typed env config
    ├── controllers/
    │   ├── messagesController.ts # @Route('messages') @Security('keycloak')
    │   └── healthController.ts
    ├── services/whatsappService.ts   # initClient() + sendMessage()
    ├── dtos/sendMessage.dto.ts       # request/response DTOs (drive the OpenAPI spec)
    ├── middleware/
    │   ├── authentication.ts     # expressAuthentication() — Keycloak JWT
    │   └── errorHandler.ts
    ├── errors/appErrors.ts
    ├── utils/logger.ts
    └── generated/                # tsoa output (git-ignored): routes.ts, swagger.json
```

## Getting started

```bash
npm install
cp .env.example .env          # fill in Keycloak settings
npm run tsoa                  # generate src/generated/{routes.ts,swagger.json}
npm run dev                   # ts-node + nodemon (auto-runs tsoa first)
```

On first run, no WhatsApp session exists. The HTTP server starts immediately and
WhatsApp connects in the background, so you can grab the login QR three ways:

- open **`GET /qr`** in a browser (PNG, perfectly square) — recommended;
- open the PNG file written to `<WHATSAPP_SESSION_PATH>/qr.png`;
- read the ASCII QR from the console/logs.

Scan it from WhatsApp ▸ Linked devices. The session is then saved under
`WHATSAPP_SESSION_PATH` and reused on subsequent restarts (`/qr` returns 404 once
linked).

> Important: `app.ts` imports `./generated/routes` and `./generated/swagger.json`,
> which are produced by tsoa. Always run `npm run tsoa` (the `build`/`dev`
> scripts do this automatically) before `tsc`/start, otherwise compilation fails.

## Build & run (production)

```bash
npm run build     # tsoa spec-and-routes && tsc  ->  dist/
npm start         # node dist/server.js
```

## Docker

```bash
docker compose up --build
```

The image installs Chromium and points Puppeteer at it
(`PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`). The WhatsApp session is
persisted in the `whatsapp-data` volume mounted at `/app/data`.

To scan the QR on first launch, watch the container logs:

```bash
docker compose logs -f whatsapp-api
```

## Kubernetes / ingress sub-path (`PATH_BASE`)

When the service is exposed under a sub-path (e.g. `https://host/whatsapp-api`),
set `PATH_BASE=/whatsapp-api`. An ASP.NET-style `UsePathBase` middleware strips
that prefix from incoming requests, so:

- through the ingress, `/whatsapp-api/messages/send` routes correctly;
- direct in-cluster probes hitting the pod on `/health` (no prefix) still work;
- Swagger UI assets resolve relatively, and the spec's `servers` is set to the
  base path so "Try it out" targets the right URL.

No ingress path rewrite is required — forward the full path to the pod. Point
the Kubernetes probes at the pod directly (no prefix needed):

```yaml
livenessProbe:
  httpGet: { path: /health, port: 3000 }
readinessProbe:
  httpGet: { path: /health, port: 3000 }
```

Persist the WhatsApp session with a `PersistentVolumeClaim` mounted at
`/app/data` (matches `WHATSAPP_SESSION_PATH=/app/data/sessions`).

## Authentication

Every `/messages/*` endpoint requires `Authorization: Bearer <token>`.
Tokens are validated against `"{KEYCLOAK_AUTH_SERVER_URL}/realms/{KEYCLOAK_REALM}"`
using the realm JWKS. To require a specific role, change the decorator, e.g.:

```ts
@Security('keycloak', ['whatsapp:send'])
```

## Example requests

JSON (text only):

```bash
curl -X POST http://localhost:3000/messages/send \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "phoneNumber": "380501234567", "message": "Привіт!" }'
```

JSON with a base64 file:

```bash
curl -X POST http://localhost:3000/messages/send \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "phoneNumber":"380501234567", "message":"Рахунок",
        "files":[{"filename":"invoice.pdf","mimetype":"application/pdf","base64":"JVBERi0x..."}] }'
```

Multipart upload:

```bash
curl -X POST http://localhost:3000/messages/send-with-files \
  -H "Authorization: Bearer $TOKEN" \
  -F "phoneNumber=380501234567" \
  -F "message=Документи" \
  -F "files=@./invoice.pdf" \
  -F "files=@./photo.jpg"
```

## Notes on reliability / anti-ban

- `WHATSAPP_MESSAGE_DELAY_MS` enforces a minimum gap between sends. Increase it
  for bulk sending. WhatsApp may ban numbers that automate aggressively.
- The number is validated with `getNumberId` before sending; unknown numbers
  return `404 WA_NUMBER_NOT_FOUND`.
- If the client is not connected, sends return `503 WA_NOT_READY`.

### Pinning the WhatsApp Web build

The library's injected helpers (`getChats`, message fetching, …) call into WhatsApp Web's own
internal modules, so they only work against a build whose internals they still match. When the
build moves out from under them, calls fail with minified page errors such as `r: r` thrown from
`Client.getChats`, and no amount of restarting helps — the fresh session loads the same build.

`WHATSAPP_WEB_VERSION` pins the build; `WHATSAPP_WEB_VERSION_REMOTE_PATH` overrides where the
HTML comes from (by default the matching file in
[wa-version](https://github.com/wppconnect-team/wa-version/tree/main/html)). Left unset,
whatsapp-web.js requests its own default build, which is no longer published there, so its cache
falls back to whatever WhatsApp serves today.

To pin: read the `WhatsApp Web version in use` line the gateway logs when the session turns
ready, check that `html/<version>.html` exists in wa-version, and set the variable to it. Unset
it to go back to the library default if a pinned build stops loading, and expect to bump it when
whatsapp-web.js is upgraded.

### Reconcile back-off

The reconcile loop republishes anything the live listener missed. `WHATSAPP_RECONCILE_MAX_FAILURES`
consecutive failed passes restart the session; each restart also pauses scanning, starting at one
`WHATSAPP_RECONCILE_INTERVAL_MS` and doubling per consecutive restart up to
`WHATSAPP_RECONCILE_BACKOFF_MAX_MS` (15 min by default). A pass that succeeds clears the ladder.
That way a fault a restart cannot fix — the version mismatch above, typically — costs an
occasional retry instead of a restart every few passes.
