import type { FastifyRequest } from 'fastify';

const BEARER_PREFIX = 'Bearer ';

export function extractBearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith(BEARER_PREFIX)) return undefined;
  return header.slice(BEARER_PREFIX.length).trim() || undefined;
}
