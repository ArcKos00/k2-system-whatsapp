import type { Request } from 'express';
import jwt, { JwtHeader, JwtPayload, SigningKeyCallback } from 'jsonwebtoken';
import { JwksClient } from 'jwks-rsa';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { ForbiddenError, UnauthorizedError } from '../errors/appErrors';

const issuer = `${config.keycloak.authServerUrl}/realms/${config.keycloak.realm}`;
const jwksUri = `${issuer}/protocol/openid-connect/certs`;

// Caches signing keys from the Keycloak realm; refreshes on key rotation.
const jwks = new JwksClient({
  jwksUri,
  cache: true,
  cacheMaxAge: 10 * 60 * 1000,
  rateLimit: true,
  jwksRequestsPerMinute: 10,
});

function getKey(header: JwtHeader, callback: SigningKeyCallback): void {
  if (!header.kid) {
    callback(new Error('Token header is missing "kid"'));
    return;
  }
  jwks.getSigningKey(header.kid, (err, key) => {
    if (err || !key) {
      callback(err ?? new Error('Signing key not found'));
      return;
    }
    callback(null, key.getPublicKey());
  });
}

function verify(token: string): Promise<JwtPayload> {
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      getKey,
      {
        algorithms: ['RS256'],
        issuer,
        audience: config.keycloak.audience || undefined,
      },
      (err, decoded) => {
        if (err || !decoded || typeof decoded === 'string') {
          reject(err ?? new Error('Invalid token payload'));
          return;
        }
        resolve(decoded);
      },
    );
  });
}

/** Flatten Keycloak realm + client roles into a single list. */
function extractRoles(payload: JwtPayload): string[] {
  const realmRoles: string[] = payload.realm_access?.roles ?? [];
  const resourceAccess = (payload.resource_access ?? {}) as Record<string, { roles?: string[] }>;
  const clientRoles = Object.values(resourceAccess).flatMap((entry) => entry.roles ?? []);
  return [...realmRoles, ...clientRoles];
}

/**
 * tsoa authentication hook. Invoked for every `@Security('keycloak')` route.
 * `scopes` map to required Keycloak roles (realm or client roles).
 * Referenced from tsoa.json -> routes.authenticationModule.
 */
export async function expressAuthentication(
  request: Request,
  securityName: string,
  scopes: string[] = [],
): Promise<JwtPayload> {
  if (securityName !== 'keycloak') {
    throw new UnauthorizedError(`Unknown security scheme: ${securityName}`);
  }

  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing or malformed Authorization header');
  }

  const token = header.slice('Bearer '.length).trim();

  let payload: JwtPayload;
  try {
    payload = await verify(token);
  } catch (err) {
    logger.warn('JWT verification failed', err instanceof Error ? err.message : err);
    throw new UnauthorizedError('Invalid or expired token');
  }

  if (scopes.length > 0) {
    const roles = extractRoles(payload);
    const missing = scopes.filter((scope) => !roles.includes(scope));
    if (missing.length > 0) {
      throw new ForbiddenError(`Missing required role(s): ${missing.join(', ')}`);
    }
  }

  // Returned value is attached to request.user by tsoa.
  return payload;
}
