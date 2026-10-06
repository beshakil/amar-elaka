import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import { HttpStatus, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';

/** The base map is served at `${tiles public base}/<file>`: bd-<version>.pmtiles, fonts/, sprites/. */
export const MAP_TILES_ROUTE = '/tiles';

// settings-exempt: HTTP cache policy. A versioned .pmtiles name never changes
// content (a new build is a new name), so it is cached for the HTTP maximum.
const IMMUTABLE = 'public, max-age=31536000, immutable';
// settings-exempt: HTTP cache policy for fonts and sprites (stable, unversioned names)
const ASSETS = 'public, max-age=86400';
// settings-exempt: how long a browser may reuse a CORS preflight answer
const PREFLIGHT_MAX_AGE_S = '86400';

/**
 * Origin patterns → matcher. `*` stands for exactly one subdomain label, so
 * `https://*.amarelaka.com` matches every tenant's site but not
 * `https://evil.com/?.amarelaka.com` or a deeper `a.b.amarelaka.com`.
 */
export function originMatcher(patterns: readonly string[]): (origin: string) => boolean {
  const regexes = patterns.map(
    (p) =>
      new RegExp(
        `^${p
          .split('*')
          .map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&'))
          .join('[a-z0-9-]+')}$`,
        'i',
      ),
  );
  return (origin) => regexes.some((r) => r.test(origin));
}

export function tilesCorsOrigins(
  env: Pick<Env, 'MAP_TILES_CORS_ORIGINS' | 'APP_ROOT_DOMAIN'>,
): string[] {
  return (
    env.MAP_TILES_CORS_ORIGINS ?? [
      `https://${env.APP_ROOT_DOMAIN}`,
      `https://*.${env.APP_ROOT_DOMAIN}`,
    ]
  );
}

/**
 * The base map as plain static files (ADR 043): no tile server. MapLibre's
 * PMTiles reader asks for byte ranges of the one archive; @fastify/static
 * answers them with 206 Partial Content. CORS reflects our own web origins
 * only (native apps send no Origin), and exposes the headers the PMTiles
 * reader needs (Content-Range, ETag).
 */
export function mapTilesRoutes(root: string, allowOrigin: (origin: string) => boolean) {
  const plugin: FastifyPluginAsync = async (scope: FastifyInstance) => {
    const cors = (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('vary', 'Origin');
      const origin = request.headers.origin;
      if (origin && allowOrigin(origin)) {
        reply
          .header('access-control-allow-origin', origin)
          .header(
            'access-control-expose-headers',
            'Content-Range, Content-Length, ETag, Accept-Ranges',
          );
      }
    };
    scope.addHook('onRequest', async (request, reply) => cors(request, reply));

    scope.options(`${MAP_TILES_ROUTE}/*`, (request, reply) => {
      if (request.headers.origin && allowOrigin(request.headers.origin)) {
        reply
          .header('access-control-allow-methods', 'GET, HEAD, OPTIONS')
          .header('access-control-allow-headers', 'Range, If-Match, If-None-Match')
          .header('access-control-max-age', PREFLIGHT_MAX_AGE_S);
      }
      return reply.status(HttpStatus.NO_CONTENT).send();
    });

    await scope.register(fastifyStatic, {
      root,
      prefix: `${MAP_TILES_ROUTE}/`,
      decorateReply: false,
      acceptRanges: true,
      cacheControl: false,
      etag: true,
      lastModified: true,
      index: false,
      list: false,
      dotfiles: 'deny',
      setHeaders: (res, path) => {
        if (path.endsWith('.pmtiles')) res.setHeader('cache-control', IMMUTABLE);
        else if (path.endsWith('current.json')) res.setHeader('cache-control', 'no-cache');
        else res.setHeader('cache-control', ASSETS);
        res.setHeader('x-content-type-options', 'nosniff');
      },
    });
  };
  return plugin;
}

/** Mounts mapTilesRoutes on the HTTP server; a no-op in the worker (no HTTP server). */
@Injectable()
export class MapTilesRoutes implements OnModuleInit {
  private readonly logger = new Logger(MapTilesRoutes.name);

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(APP_CONFIG)
    private readonly env: Pick<
      Env,
      'MAP_TILES_PATH' | 'MAP_TILES_CORS_ORIGINS' | 'APP_ROOT_DOMAIN'
    >,
  ) {}

  async onModuleInit(): Promise<void> {
    const adapter = this.adapterHost.httpAdapter as { getInstance?: () => unknown } | undefined;
    if (!adapter?.getInstance) return;
    const fastify = adapter.getInstance() as FastifyInstance;
    const root = resolve(this.env.MAP_TILES_PATH);
    await fastify.register(mapTilesRoutes(root, originMatcher(tilesCorsOrigins(this.env))));
    this.logger.log(`serving the base map from ${root} at ${MAP_TILES_ROUTE}/`);
  }
}
