import dotenv from 'dotenv';

dotenv.config({ quiet: true });

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function normalizePathBase(raw?: string): string {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === '/') return '';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, '');
}

export const config = {
  port: num('PORT', 3000),
  env: process.env.NODE_ENV ?? 'development',
  pathBase: normalizePathBase(process.env.PATH_BASE),

  keycloak: {
    authServerUrl: required('KEYCLOAK_AUTH_SERVER_URL').replace(/\/+$/, ''),
    realm: required('KEYCLOAK_REALM'),
    audience: process.env.KEYCLOAK_AUDIENCE ?? '',
  },

  whatsapp: {
    clientId: process.env.WHATSAPP_CLIENT_ID ?? 'default',
    sessionPath: process.env.WHATSAPP_SESSION_PATH ?? './data/sessions',
    messageDelayMs: num('WHATSAPP_MESSAGE_DELAY_MS', 3000),
    frameRetryDelayMs: num('WHATSAPP_FRAME_RETRY_DELAY_MS', 1500),
    healthCheckIntervalMs: num('WHATSAPP_HEALTH_CHECK_INTERVAL_MS', 60000),
    healthCheckTimeoutMs: num('WHATSAPP_HEALTH_CHECK_TIMEOUT_MS', 15000),
    readyTimeoutMs: num('WHATSAPP_READY_TIMEOUT_MS', 180000),
    reconcileIntervalMs: num('WHATSAPP_RECONCILE_INTERVAL_MS', 30000),
    reconcileMaxFailures: num('WHATSAPP_RECONCILE_MAX_FAILURES', 3),
    /**
     * Ceiling on the pause after a reconcile escalation. Each consecutive session restart
     * doubles the pause (starting at one scan interval) up to this value, so a fault that a
     * restart cannot fix — an injected-code mismatch with the current WhatsApp Web build,
     * say — costs one restart per ceiling instead of one every few scans.
     */
    reconcileBackoffMaxMs: num('WHATSAPP_RECONCILE_BACKOFF_MAX_MS', 15 * 60 * 1000),
    reconcileLookbackSec: num('WHATSAPP_RECONCILE_LOOKBACK_SEC', 0),
    catchUpLimitPerChat: num('WHATSAPP_CATCHUP_LIMIT_PER_CHAT', 50),
    /**
     * How many still-nameless chats `GET /chats` may look up one at a time before it gives up
     * and returns them with only their id. The bulk read names almost every chat; this bounds
     * the per-chat fallback, which costs a round trip each, on an account with a long tail of
     * archived threads nobody has a name for. Zero disables the fallback entirely.
     */
    chatEnrichLimit: num('WHATSAPP_CHAT_ENRICH_LIMIT', 250),
    cursorPath: process.env.WHATSAPP_CURSOR_PATH || undefined,
    initMaxAttempts: num('WHATSAPP_INIT_MAX_ATTEMPTS', 3),
    initTimeoutMs: num('WHATSAPP_INIT_TIMEOUT_MS', 90000),
    /**
     * How long `POST /session/login` waits for the session to show a QR (or come up ready)
     * before answering with whatever state it is in. The QR stays at `GET /qr` either way.
     */
    loginWaitMs: num('WHATSAPP_LOGIN_WAIT_MS', 60000),
    /**
     * How long after `ready` reconcile and the media-prep probe wait before they touch chats.
     * WhatsApp Web keeps loading after the library reports ready, and opening chats in that
     * window got the device logged out (CLIENT_FATAL).
     */
    postReadyDelayMs: num('WHATSAPP_POST_READY_DELAY_MS', 20000),
    webVersion: process.env.WHATSAPP_WEB_VERSION || undefined,
    webVersionRemotePath: process.env.WHATSAPP_WEB_VERSION_REMOTE_PATH || undefined,
    /**
     * Where a pinned build's HTML is kept once it has been fetched. It lives on the session
     * volume so the pin survives a restart even if the archive is unreachable from the cluster,
     * and so the file can be put there by hand when it always is.
     */
    webVersionCachePath: process.env.WHATSAPP_WEB_VERSION_CACHE_PATH || undefined,
    webVersionFetchTimeoutMs: num('WHATSAPP_WEB_VERSION_FETCH_TIMEOUT_MS', 20000),
    qrImagePath: process.env.WHATSAPP_QR_PATH || undefined,
    /**
     * Ceiling on the Chromium renderer's JavaScript heap, in MB.
     *
     * It was set low to keep the pod off the kernel's OOM killer, but the renderer is also
     * where WhatsApp Web decodes and re-encodes a photo before uploading it, and a full-size
     * image needs far more room than a chat does. Zero leaves the flag off entirely and lets
     * the renderer use what the container allows.
     */
    rendererHeapMb: num('WHATSAPP_RENDERER_HEAP_MB', 256),
    puppeteerExecutablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    puppeteerChannel: process.env.PUPPETEER_BROWSER_CHANNEL || undefined,
  },

  history: {
    /**
     * Where the processed-message history lives (defaults to <session path>/processed-messages.json).
     * Keep it on the same durable volume as the session.
     */
    path: process.env.WHATSAPP_HISTORY_PATH || undefined,
    /** How long a forwarded message id is remembered. Never shorter than the backfill window. */
    retentionSec: num('WHATSAPP_HISTORY_RETENTION_SEC', 7 * 24 * 60 * 60),
    /**
     * Whether a start resumes where the last process stopped. On, each chat is scrolled back to
     * the last message it confirmed and everything after it is forwarded. Off, the service
     * starts clean: only messages that arrive after this start are forwarded.
     */
    backfillOnStart: bool('WHATSAPP_BACKFILL_ON_START', true),
    /** The furthest back a backfill ever reaches, however long the service was down. */
    backfillMaxAgeSec: num('WHATSAPP_BACKFILL_MAX_AGE_SEC', 2 * 24 * 60 * 60),
    /** How many messages one chat may be scrolled back through looking for its anchor. */
    backfillMaxMessagesPerChat: num('WHATSAPP_BACKFILL_MAX_MESSAGES_PER_CHAT', 1000),
  },

  idempotency: {
    /**
     * Where successful sends are remembered so a retried request with the same
     * `idempotencyKey` is answered from the record instead of sending twice.
     * Put this on the same mounted volume as the session to survive restarts.
     */
    path: process.env.IDEMPOTENCY_STORE_PATH ?? './data/idempotency.json',
    /**
     * How long a key stays valid. Must comfortably exceed the caller's total retry
     * window; beyond it the key is forgotten and a resend would go through.
     */
    ttlMs: num('IDEMPOTENCY_TTL_MS', 7 * 24 * 60 * 60 * 1000),
  },

  rabbitmq: {
    url: process.env.RABBITMQ_URL || undefined,
    exchange: process.env.RABBITMQ_EXCHANGE ?? 'whatsapp.messages',
    reconnectDelayMs: num('RABBITMQ_RECONNECT_DELAY_MS', 5000),
    connectTimeoutMs: num('RABBITMQ_CONNECT_TIMEOUT_MS', 10000),
    chatIds: list('RABBITMQ_CHAT_IDS'),
  },
} as const;

export type AppConfig = typeof config;
