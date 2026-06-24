import dotenv from 'dotenv';

dotenv.config();

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Normalise a path base into "" (root) or "/segment" with no trailing slash.
 * e.g. "whatsapp-api/" -> "/whatsapp-api", "/" -> "", undefined -> "".
 */
function normalizePathBase(raw?: string): string {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === '/') return '';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, '');
}

/**
 * Centralised, typed access to runtime configuration.
 * Values are read once at process start.
 */
export const config = {
  port: num('PORT', 3000),
  env: process.env.NODE_ENV ?? 'development',
  /**
   * Sub-path the service is hosted under behind an ingress/reverse proxy
   * (e.g. "/whatsapp-api"). Empty when served at the root. See PATH_BASE.
   */
  pathBase: normalizePathBase(process.env.PATH_BASE),

  keycloak: {
    /** e.g. https://keycloak.example.com (no trailing slash, no /realms). */
    authServerUrl: required('KEYCLOAK_AUTH_SERVER_URL').replace(/\/+$/, ''),
    realm: required('KEYCLOAK_REALM'),
    /**
     * Expected audience (client id) inside the access token.
     * Leave empty to skip audience validation (Keycloak often sets `aud`
     * to "account" unless an audience mapper is configured).
     */
    audience: process.env.KEYCLOAK_AUDIENCE ?? '',
  },

  whatsapp: {
    /** Distinguishes multiple sessions inside the same session directory. */
    clientId: process.env.WHATSAPP_CLIENT_ID ?? 'default',
    /** Persisted LocalAuth session folder (mount this as a Docker volume). */
    sessionPath: process.env.WHATSAPP_SESSION_PATH ?? './data/sessions',
    /** Minimum delay between outbound messages (anti-ban throttle), ms. */
    messageDelayMs: num('WHATSAPP_MESSAGE_DELAY_MS', 3000),
    /**
     * Pause before retrying an operation after a transient Puppeteer frame
     * detach (WhatsApp Web reload), ms. Gives the page time to re-attach.
     */
    frameRetryDelayMs: num('WHATSAPP_FRAME_RETRY_DELAY_MS', 1500),
    /**
     * How many times to retry client.initialize() when it fails or hangs
     * (transient "Execution context was destroyed", or a stuck inject/launch).
     */
    initMaxAttempts: num('WHATSAPP_INIT_MAX_ATTEMPTS', 3),
    /**
     * Hard cap on a single client.initialize() attempt, ms. initialize() can
     * hang indefinitely if the browser launch or WA Web page load stalls; on
     * timeout we tear down and retry instead of waiting forever. 0 disables.
     */
    initTimeoutMs: num('WHATSAPP_INIT_TIMEOUT_MS', 90000),
    /**
     * Pin a specific WhatsApp Web version to dodge "Execution context was
     * destroyed" caused by an incompatible live WA Web build. When set, the
     * client loads this version's HTML from a remote cache instead of whatever
     * web.whatsapp.com currently serves. Use a snapshot known to work with the
     * installed whatsapp-web.js, e.g. from
     * https://github.com/wppconnect-team/wa-version (folder "html").
     * Leave empty to use the live version.
     */
    webVersion: process.env.WHATSAPP_WEB_VERSION || undefined,
    /**
     * Where to fetch the pinned WA Web HTML from. Defaults to the wppconnect
     * wa-version mirror for the configured webVersion. Only used when
     * webVersion is set.
     */
    webVersionRemotePath: process.env.WHATSAPP_WEB_VERSION_REMOTE_PATH || undefined,
    /** Where the login QR PNG is written (defaults to <sessionPath>/qr.png). */
    qrImagePath: process.env.WHATSAPP_QR_PATH || undefined,
    /** Chromium binary path; required in slim containers. Highest priority. */
    puppeteerExecutablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    /**
     * Installed browser channel to launch when no explicit path is set
     * (e.g. "chrome", "chrome-beta", "msedge"). Portable for local dev.
     */
    puppeteerChannel: process.env.PUPPETEER_BROWSER_CHANNEL || undefined,
  },

  rabbitmq: {
    /**
     * AMQP connection string, e.g. amqp://user:pass@host:5672. Leave empty to
     * disable forwarding of inbound WhatsApp messages to RabbitMQ.
     */
    url: process.env.RABBITMQ_URL || undefined,
    /**
     * Name of the `headers`-type exchange inbound messages are published to.
     * Consumers bind their queue with a header match on `chatId` to receive
     * messages for a specific chat.
     */
    exchange: process.env.RABBITMQ_EXCHANGE ?? 'whatsapp.messages',
    /** Pause (ms) before retrying a lost AMQP connection. */
    reconnectDelayMs: num('RABBITMQ_RECONNECT_DELAY_MS', 5000),
  },
} as const;

export type AppConfig = typeof config;
