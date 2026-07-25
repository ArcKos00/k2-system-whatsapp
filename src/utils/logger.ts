type Level = 'debug' | 'info' | 'warn' | 'error';

const SEVERITY: Record<Level, number> = {debug: 10, info: 20, warn: 30, error: 40};

/**
 * Everything below this is dropped. Defaults to `info`, which keeps out the debug lines that
 * restate a condition already reported once — a chat that will not load on any pass, say —
 * until someone sets `LOG_LEVEL=debug` to look at them.
 */
const threshold =
  SEVERITY[process.env.LOG_LEVEL?.trim().toLowerCase() as Level] ?? SEVERITY.info;

function emit(level: Level, message: string, meta?: unknown): void {
  if (SEVERITY[level] < threshold) return;

  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] ${level.toUpperCase()}`;
  const sink = level === 'error' || level === 'warn' ? console.error : console.log;
  if (meta !== undefined) {
    sink(`${prefix} ${message}`, meta);
  } else {
    sink(`${prefix} ${message}`);
  }
}

export const logger = {
  debug: (message: string, meta?: unknown) => emit('debug', message, meta),
  info: (message: string, meta?: unknown) => emit('info', message, meta),
  warn: (message: string, meta?: unknown) => emit('warn', message, meta),
  error: (message: string, meta?: unknown) => emit('error', message, meta),
};
