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
} as const;

export type AppConfig = typeof config;
