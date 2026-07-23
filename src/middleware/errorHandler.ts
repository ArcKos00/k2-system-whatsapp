import { NextFunction, Request, Response } from 'express';
import { ValidateError } from 'tsoa';
import { AppError } from '../errors/appErrors';
import { ErrorResponse } from '../dtos/sendMessage.dto';
import { logger } from '../utils/logger';

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response<ErrorResponse>,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof ValidateError) {
    logger.warn(`Validation failed for ${req.method} ${req.path}`, err.fields);
    res.status(422).json({
      message: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: err.fields,
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({ message: err.message, code: err.code });
    return;
  }

  const maybeHttp = err as { status?: number; statusCode?: number; message?: string };
  const status = maybeHttp.status ?? maybeHttp.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({
      message: maybeHttp.message ?? 'Bad request',
      code: 'BAD_REQUEST',
    });
    return;
  }

  logger.error(`Unhandled error on ${req.method} ${req.path}`, err);
  res.status(500).json({ message: 'Internal server error', code: 'INTERNAL_ERROR' });
}

export function notFoundHandler(req: Request, res: Response<ErrorResponse>): void {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.path}`, code: 'NOT_FOUND' });
}
