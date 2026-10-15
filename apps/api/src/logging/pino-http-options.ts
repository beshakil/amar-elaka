import { randomUUID } from 'node:crypto';
import type { Params } from 'nestjs-pino';
import type { Env } from '../config/env.schema';

/**
 * Shared between AppModule (HTTP) and WorkerModule (no HTTP — PinoLogger
 * falls back to this same root logger config when there's no request scope,
 * see nestjs-pino's PinoLogger.logger getter) so the two never drift apart.
 */
export function buildPinoHttpOptions(env: Pick<Env, 'NODE_ENV'>): NonNullable<Params['pinoHttp']> {
  return {
    level: env.NODE_ENV === 'production' ? 'info' : 'debug',
    genReqId: (req: { headers: Record<string, unknown> }) => {
      const existing = req.headers['x-request-id'];
      return typeof existing === 'string' && existing.length > 0 ? existing : randomUUID();
    },
    // The NID number (ADR 062) never reaches a log, wherever it would appear.
    redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body.nid', '*.nid', 'nid'],
    ...(env.NODE_ENV === 'production'
      ? {}
      : { transport: { target: 'pino-pretty', options: { singleLine: true, colorize: true } } }),
  };
}
