# WhatsApp API Gateway

REST gateway over WhatsApp for K2: send messages and files, list chats, and publish inbound
messages to RabbitMQ. Since **2.0.0** it is written in Go on [whatsmeow](https://github.com/tulir/whatsmeow):
the gateway is a linked device speaking WhatsApp's own protocol over a websocket — no browser,
no Puppeteer, no WhatsApp Web build to pin.

| | 1.x (whatsapp-web.js) | 2.x (whatsmeow) |
|---|---|---|
| Runtime | Node + headless Chromium | one static Go binary |
| Image | ~430 MB | ~55 MB |
| Memory | 2–4 GiB limit, OOMs | ~10–30 MiB |
| Session | LocalAuth on a RWO volume | Postgres (`whatsmeow_*` tables) |
| Inbound delivery | reconcile scan, ≤ 1000 messages / chat after a restart | outbox in Postgres, written before WhatsApp's ack |
| Breaks when WhatsApp Web changes | yes (`messageId`, media prep, `getChats`) | no |

## API (unchanged from 1.x)

Swagger UI at **`GET /docs`**, raw spec at `GET /openapi.json` (both honour `PATH_BASE`).

- `POST /messages/send`, `POST /messages/send-with-files` — to a phone number (JSON with base64 files / multipart).
- `POST /messages/chat/send`, `POST /messages/chat/send-with-files` — to a chat id; the only way to reach a group.
  `quotedMessageId` sends a reply; `idempotencyKey` makes a retry safe (200 `deduplicated` replay, 409 while in flight).
- `GET /chats` — chat ids (`@g.us`, `@c.us`, `@lid`, `@newsletter`, `status@broadcast`) with names and whether the
  forward allowlist takes them.
- `GET /health` (liveness, always 200), `GET /health/owner` (readiness: 200 on the replica that owns the session),
  `GET /ready` (200 only when a send can go out).
- Session: `GET /session`, `POST /session/login`, `POST /session/logout`, `GET /session/qr` (302 → `GET /qr`, PNG),
  and new in 2.0 `POST /session/pair-code` `{phoneNumber}` — link with an 8-character code typed on the phone.

Paths, bodies, status codes and error codes (`WA_NOT_LOGGED_IN`, `WA_NOT_READY`, `WA_CHAT_ID_INVALID`,
`WA_CHAT_NOT_FOUND`, `WA_NUMBER_NOT_FOUND`, `WA_SEND_FAILED`, `WA_SEND_IN_FLIGHT`, `BAD_ATTACHMENT`,
`VALIDATION_ERROR`) are those of 1.x. Ids keep the whatsapp-web.js spelling: one-to-one chats are `<number>@c.us`
(`@s.whatsapp.net` is accepted), message ids are `<fromMe>_<chat>_<id>[_<participant>]`. A `quotedMessageId`
this gateway has never seen (for instance one recorded by 1.x) is sent unquoted, as 1.x did with one WhatsApp
could not find.

No endpoint requires a token: keep the gateway on the internal network.

## RabbitMQ events (unchanged from 1.x)

Durable **headers** exchange `RABBITMQ_EXCHANGE`, headers `chatId` and `event`, JSON body:

| `event` | when | extra fields | AMQP `messageId` |
|---|---|---|---|
| `created` | a new inbound message | — | `<id>` |
| `edited` | the sender edited it | `body` (new), `previousBody`, `editedAt` | `<id>:edited:<editedAtMs>` |
| `deleted` | deleted for everyone | `body`/`type` of the original, `deletedAt` | `<id>:deleted` |

Common fields: `event, id, chatId, from, author (groups and status), body, type, timestamp, hasMedia`. `type`
uses the whatsapp-web.js names (`chat`, `image`, `video`, `audio`, `ptt`, `document`, `sticker`, `location`,
`vcard`, `poll_creation`, …). Only `RABBITMQ_CHAT_IDS` chats are published (empty = all). Messages the account
itself sends are not published, as in 1.x.

**Delivery is at-least-once and lossless.** The message and the event owed for it are written to Postgres in one
transaction *before* WhatsApp is acked (whatsmeow `SynchronousAck`); a pump publishes the outbox in order with
publisher confirms and marks each event only once the broker has confirmed it. A broker outage, a missing
`RABBITMQ_URL` or a restart delays events, never drops them. While the gateway is down, WhatsApp keeps the
messages for the linked device and delivers them on reconnect; there is no per-chat cap.

## Running several replicas

Only one process may drive a WhatsApp device (a second connection replaces the first). Every replica serves HTTP,
but only the holder of a Postgres **session advisory lock** (keyed by `WHATSAPP_CLIENT_ID`) connects WhatsApp and
drains the outbox; readiness is true only there. When the owner stops, a standby takes over in about a second
(measured: 1.1 s). This is why `DATABASE_URL` must reach Postgres directly, not through pgbouncer in transaction mode.

## Configuration

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | — (required) | Postgres DSN; tables go to the role's `search_path` |
| `PORT`, `PATH_BASE`, `LOG_LEVEL` | `3000`, `""`, `info` | `PATH_BASE` is stripped like ASP.NET `UsePathBase` |
| `WHATSAPP_CLIENT_ID` | `default` | names the session and its owner lock |
| `WHATSAPP_MESSAGE_DELAY_MS` | `3000` | minimum gap between outbound messages |
| `WHATSAPP_LOGIN_WAIT_MS` | `60000` | how long `POST /session/login` waits for a QR |
| `WHATSAPP_DEVICE_NAME` | `K2 WhatsApp Gateway` | shown on the phone under Linked devices |
| `WHATSAPP_HISTORY_RETENTION_SEC` | `604800` | messages and published events are kept this long |
| `IDEMPOTENCY_TTL_MS`, `IDEMPOTENCY_IN_FLIGHT_TIMEOUT_MS` | 7 d, 5 min | key lifetime; when an unfinished claim is taken over |
| `RABBITMQ_URL`, `RABBITMQ_EXCHANGE`, `RABBITMQ_CHAT_IDS` | —, `whatsapp.messages`, all | unset URL = events wait in the outbox |
| `RABBITMQ_RECONNECT_DELAY_MS`, `RABBITMQ_CONNECT_TIMEOUT_MS`, `RABBITMQ_PUBLISH_BATCH` | 5000, 10000, 100 | |

1.x variables for Chromium, Puppeteer, the WhatsApp Web build, reconcile and backfill are ignored.

## Development

```bash
go test ./...                                   # unit tests
WA_TEST_DATABASE_URL=postgres://wa_reader:…@localhost:5432/whatsapp \
WA_TEST_RABBITMQ_URL=amqp://guest:guest@localhost:5672/ \
  go test -race -tags integration ./...         # + outbox, owner lock, idempotency against real services
DATABASE_URL=postgres://… go run ./cmd/wa-reader  # then open /qr and scan it
docker build --add-host k2:10.20.50.25 --pull -t wa-reader .
```

Layout: `cmd/wa-reader` (start order, shutdown), `internal/api` (REST, OpenAPI, Swagger UI embedded),
`internal/wa` (whatsmeow session, inbound, sends, chats), `internal/store` (Postgres: migrations, outbox, cache,
idempotency, owner lock), `internal/rabbit` (outbox pump), `internal/ids` (1.x id dialect).

Version: `VERSION` (baked into the binary); release notes: `changelog/`.
