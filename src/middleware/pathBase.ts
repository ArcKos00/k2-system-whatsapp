import { RequestHandler } from 'express';

/**
 * ASP.NET-style `UsePathBase` for Express.
 *
 * When the service is hosted behind an ingress / reverse proxy under a sub-path
 * (e.g. `https://host/whatsapp-api`) that forwards the full path, this strips the
 * configured prefix from the incoming URL so routes defined at the root still
 * match (`/whatsapp-api/messages/send` -> `/messages/send`).
 *
 * Requests that arrive WITHOUT the prefix — e.g. in-cluster Kubernetes liveness/
 * readiness probes hitting the pod directly on `/health` — pass through unchanged.
 * This makes the same image work both behind a path-routing ingress and directly.
 */
export function usePathBase(pathBase: string): RequestHandler {
  return (req, _res, next) => {
    if (
      pathBase &&
      (req.url === pathBase ||
        req.url.startsWith(`${pathBase}/`) ||
        req.url.startsWith(`${pathBase}?`))
    ) {
      const stripped = req.url.slice(pathBase.length);
      req.url = stripped.startsWith('/') ? stripped : `/${stripped}`;
    }
    next();
  };
}
