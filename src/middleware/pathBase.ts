import { RequestHandler } from 'express';

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
