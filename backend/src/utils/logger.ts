import crypto from 'crypto';

export interface LogEntry {
  level: 'info' | 'warn' | 'error' | 'debug';
  correlationId: string;
  message: string;
  [key: string]: unknown;
}

function createCorrelationId(): string {
  return crypto.randomUUID();
}

export function createLogger(correlationId?: string) {
  const cid = correlationId || createCorrelationId();

  function log(level: LogEntry['level'], message: string, meta?: Record<string, unknown>) {
    const entry: LogEntry = {
      level,
      correlationId: cid,
      message,
      ...meta,
    };
    const output = JSON.stringify(entry);
    switch (level) {
      case 'error':
        console.error(output);
        break;
      case 'warn':
        console.warn(output);
        break;
      default:
        console.log(output);
    }
  }

  return {
    info: (message: string, meta?: Record<string, unknown>) => log('info', message, meta),
    warn: (message: string, meta?: Record<string, unknown>) => log('warn', message, meta),
    error: (message: string, meta?: Record<string, unknown>) => log('error', message, meta),
    debug: (message: string, meta?: Record<string, unknown>) => log('debug', message, meta),
    getCorrelationId: () => cid,
  };
}

export type Logger = ReturnType<typeof createLogger>;
