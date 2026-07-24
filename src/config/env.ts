import dotenv from 'dotenv';

dotenv.config();

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
    reconcileLookbackSec: num('WHATSAPP_RECONCILE_LOOKBACK_SEC', 0),
    catchUpLimitPerChat: num('WHATSAPP_CATCHUP_LIMIT_PER_CHAT', 50),
    cursorPath: process.env.WHATSAPP_CURSOR_PATH || undefined,
    initMaxAttempts: num('WHATSAPP_INIT_MAX_ATTEMPTS', 3),
    initTimeoutMs: num('WHATSAPP_INIT_TIMEOUT_MS', 90000),
    webVersion: process.env.WHATSAPP_WEB_VERSION || undefined,
    webVersionRemotePath: process.env.WHATSAPP_WEB_VERSION_REMOTE_PATH || undefined,
    qrImagePath: process.env.WHATSAPP_QR_PATH || undefined,
    puppeteerExecutablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    puppeteerChannel: process.env.PUPPETEER_BROWSER_CHANNEL || undefined,
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
    chatIds: list('RABBITMQ_CHAT_IDS'),
  },
} as const;

export type AppConfig = typeof config;
