# WhatsApp API Gateway

REST API gateway over [`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js).
Built with **TypeScript + Express + tsoa**, secured with **Keycloak** (bearer JWT),
documented with **Swagger UI**, and DI via **tsyringe**.

## Features

- `POST /messages/send` — send text + base64 attachments to a phone number (JSON).
- `POST /messages/send-with-files` — send text + uploaded files to a phone number (multipart).
- `POST /messages/chat/send` — same, addressed by chat id instead of number (JSON).
  The only way to reach a **group**.
- `POST /messages/chat/send-with-files` — same, multipart.
- `GET /chats` — list every chat with its id and the fullest description WhatsApp will give.
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
    │   ├── messagesController.ts     # @Route('messages')      — send by phone number
    │   ├── chatMessagesController.ts # @Route('messages/chat') — send by chat id
    │   ├── chatsController.ts        # @Route('chats')         — list chats
    │   └── healthController.ts
    ├── services/
    │   ├── whatsappService.ts        # initClient(), sendMessage(), listChatSummaries()
    │   └── idempotentSend.ts         # shared idempotency-key handling for every send
    ├── dtos/                         # request/response DTOs (drive the OpenAPI spec)
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

### Sending to a chat id (groups)

A group has no phone number, so `/messages/send` cannot address one. Take the `id` from
`GET /chats` and post it to `/messages/chat/send`, which is otherwise identical — same
throttle, same attachments, same `idempotencyKey`:

```bash
curl -X POST http://localhost:3000/messages/chat/send \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "chatId": "120363412778233770@g.us", "message": "Привіт, команда!" }'
```

```bash
curl -X POST http://localhost:3000/messages/chat/send-with-files \
  -H "Authorization: Bearer $TOKEN" \
  -F "chatId=120363412778233770@g.us" \
  -F "message=Документи" \
  -F "files=@./invoice.pdf"
```

`chatId` takes the ids exactly as the listing reports them — `@g.us` (group), `@c.us`
(one-to-one), `@lid` (linked identity), `@newsletter` (channel). A bare number is read as
`<number>@c.us` and a bare `<a>-<b>` as `<a>-<b>@g.us`, so an id copied without its suffix
still works. A malformed id returns `422 WA_CHAT_ID_INVALID`; a well-formed id the linked
account cannot see returns `404 WA_CHAT_NOT_FOUND`.

## Notes on reliability / anti-ban

- Photos, videos and audio (`image/jpeg`, `image/png`, `image/webp`, `video/mp4`,
  `video/3gpp`, `audio/*`) are sent as inline media so they render as a picture or a
  player. If WhatsApp rejects the inline upload — an oversized image, an unsupported
  codec — the same file is re-sent as a document. Everything else (PDF, Office, GIF,
  archives…) is sent as a document from the start. A generic `application/octet-stream`
  mimetype is replaced by the type implied by the file extension.
- An attachment's first bytes have the final say over its type. A file whose content does not
  match its name — a video or an HTML error page saved as `.jpeg` — is sent under the type the
  content implies, because WhatsApp Web decodes photos and videos in the page before uploading
  and a mislabelled one breaks that prep instead of being refused.
- An empty attachment returns `400 BAD_ATTACHMENT` and is never sent; the caller's retry policy
  should treat it as final, since the same upload cannot succeed.
- Every attachment is prepared by WhatsApp Web itself before the upload, and everything after
  that step is keyed by the `filehash` the prep returns. A build that stops returning one takes
  *every* media send down with WhatsApp's own minified
  `Data passed to getter must include an id property (it's how we memoize) but got undefined`,
  because the library hands the missing hash to an in-page getter. The gateway fills the hash in
  itself when the prep omits it, and logs one `WhatsApp media prep` line per ready session saying
  whether the prep is healthy, whether our hash is carrying it, or what the prep returned
  instead. A send that still fails is reported as `502 WA_SEND_FAILED` naming the prep — it is
  the build, not the file, so the fix is pinning `WHATSAPP_WEB_VERSION` (see below), and the
  media must not be dropped in the meantime.
- `GET /health/media-prep` runs that same check on demand and answers with what it found;
  `?chatId=<id>` also resolves that chat, which is the one call every send makes before the
  media path is even reached, and `?pixels=2048` preps a generated full-size photo instead of
  the 8x8 one — the prep can be perfectly healthy on a thumbnail and give up on a real photo.
  It sends nothing and needs no token.
- `WHATSAPP_RENDERER_HEAP_MB` caps the Chromium renderer's JavaScript heap (256 by default, 0
  to leave it uncapped). The renderer is where an outgoing photo is decoded and re-encoded, so a
  ceiling that keeps idle memory down can also be what makes the prep give up on a full-size
  image — if `?pixels=2048` fails and `?pixels=64` does not, raise this before suspecting the
  build.
- `WHATSAPP_MESSAGE_DELAY_MS` enforces a minimum gap between sends. Increase it
  for bulk sending. WhatsApp may ban numbers that automate aggressively.
- The number is validated with `getNumberId` before sending; unknown numbers
  return `404 WA_NUMBER_NOT_FOUND`. A chat id is checked against the chats the account
  actually has, and an unknown one returns `404 WA_CHAT_NOT_FOUND` (a `@c.us` id the
  account has never talked to still falls back to the number check, since sending opens
  that chat).
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

Pinning was tried against this on 2026-09-17 and does not hold: the pinned index loads — the
gateway downloads it, serves it from disk and logs both — and WhatsApp Web then updates itself
past it, so `version in use` comes back as the current build anyway. The machinery stays because
it costs nothing, and `version in use` is logged as an error when it disagrees with the pin, so a
pin that silently does not take can never look like one that did.

The drift it was meant to cure, for the record: The build WhatsApp was serving had
slimmed `MsgKey` down to `{fromMe, remote, id, participant}` — the `from`, `to`, `selfDir` and
`_serialized` the library fills in and reads back are gone — so every send built a key WhatsApp
could not index and died on `Data passed to getter must include an id property`. Worth knowing
for the next time: that error names nothing and surfaces wherever the undefined lands, and it
took the media path down first, so it read for a day like a problem with the attachments. It was
not. The file preps, hashes and uploads to WhatsApp's servers cleanly; the message built around
it is what WhatsApp refuses. `GET /health/media-prep` exists to tell those two apart quickly,
and a failing send now logs both account identities and a freshly built key beside the trace.

### Finding chat ids for the forward allowlist

`RABBITMQ_CHAT_IDS` keys on WhatsApp chat ids, which are not something you can read off the
phone. `GET /chats` lists them:

```bash
curl -s https://<host>/whatsapp/chats | jq '.chats[] | {id, displayName, kind, forwarded}'
```

Groups end in `@g.us`, one-to-one chats in `@c.us`, linked-identity threads in `@lid`.
`forwarded` says what the allowlist currently in force does with each chat, and `allowlist`
echoes that configuration back. Chats WhatsApp would not let the library model come back as
bare ids in `unreadableChatIds` — reconcile skips those too.

#### How chats are described

`whatsapp-web.js` exposes only `formattedTitle`, which WhatsApp leaves empty for exactly the
chats that most need a name: a group whose metadata the account has not synced, and anyone who
is not in the phone's address book. The listing therefore reads WhatsApp's own in-page chat
models directly, in one page call, and pulls out everything they carry:

| field | where it comes from |
| --- | --- |
| `subject`, `description`, `participantCount` | group metadata — this is what names an unnamed group |
| `contactName`, `pushName`, `verifiedName`, `isMyContact` | the contact record behind a one-to-one chat |
| `phoneNumber` | the contact's number; for a `@lid` thread, resolved through WhatsApp's own lid→number mapping |
| `kind` | `group` / `private` / `lid` / `channel` / `broadcast`, read off the id |
| `isReadOnly`, `archived`, `timestamp`, `unreadCount` | the chat model |

`name` is the best of those, and `nameSource` says which one it is — so `number` means WhatsApp
only had a phone number and `fallback` means it had nothing at all. `displayName` is never
empty; it falls back to the id's user part. `unnamedCount` in the response counts how many
chats ended up with no name.

Any chat still nameless after the bulk read gets a second, per-chat pass: `getChatById` forces
WhatsApp to fetch the group metadata, and `getContactById` asks for a contact it has not pushed
to us. Those are round trips, so `WHATSAPP_CHAT_ENRICH_LIMIT` (default 250) caps how many one
listing will do; anything past the cap is returned with its id only and logged as a warning.

Without the endpoint the ids are also visible in the logs: every inbound message logs its
`chatId`, whether it was forwarded or dropped by the allowlist.

### Reconcile back-off

The reconcile loop republishes anything the live listener missed. `WHATSAPP_RECONCILE_MAX_FAILURES`
consecutive failed passes restart the session; each restart also pauses scanning, starting at one
`WHATSAPP_RECONCILE_INTERVAL_MS` and doubling per consecutive restart up to
`WHATSAPP_RECONCILE_BACKOFF_MAX_MS` (15 min by default). A pass that succeeds clears the ladder.
That way a fault a restart cannot fix — the version mismatch above, typically — costs an
occasional retry instead of a restart every few passes.
