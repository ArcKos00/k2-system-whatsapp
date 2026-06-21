type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, message: string, meta?: unknown): void {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] ${level.toUpperCase()}`;
  const sink = level === 'error' || level === 'warn' ? console.error : console.log;
  if (meta !== undefined) {
    sink(`${prefix} ${message}`, meta);
  } else {
    sink(`${prefix} ${message}`);
  }
}

/** Minimal dependency-free structured-ish logger. Swap for pino/winston if needed. */
export const logger = {
  debug: (message: string, meta?: unknown) => emit('debug', message, meta),
  info: (message: string, meta?: unknown) => emit('info', message, meta),
  warn: (message: string, meta?: unknown) => emit('warn', message, meta),
  error: (message: string, meta?: unknown) => emit('error', message, meta),
};
