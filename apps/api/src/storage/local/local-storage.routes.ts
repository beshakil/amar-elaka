import { HttpStatus, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance, FastifyPluginCallback, FastifyReply } from 'fastify';
import type { Readable } from 'node:stream';
import { DomainException } from '../../common/exceptions/domain-exception';
import { STORAGE_SERVICE, type StorageService } from '../storage.ports';
import { LocalStorageService, LOCAL_UPLOAD_PATH } from './local-storage.service';

/** Public media is served under `${API_PUBLIC_URL}${PUBLIC_MEDIA_PATH}/<key>` (STORAGE_PUBLIC_URL). */
export const PUBLIC_MEDIA_PATH = '/media';

// A token authorises the upload, not a cookie, so any origin may send it —
// the same stance as an S3 bucket CORS rule for presigned PUTs.
const UPLOAD_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'PUT, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '3600',
} as const;

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof DomainException) {
    return reply
      .status(error.httpStatus)
      .send({ statusCode: error.httpStatus, error: error.code, message: error.message });
  }
  return reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    error: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected error occurred.',
  });
}

// Wildcards, not `:token`: a signed token is longer than Fastify's default
// maxParamLength (100), which would make the route silently 404.

/**
 * The HTTP half of the local driver, as an encapsulated Fastify plugin so its
 * catch-all body parser (uploads arrive as raw image/PDF bytes) can't leak to
 * the Nest routes. These routes sit outside Nest on purpose: the signed
 * upload token is the authorisation (like a presigned URL), and public media
 * needs no tenant.
 */
export function localStorageRoutes(
  storage: LocalStorageService,
  logger: Logger,
): FastifyPluginCallback {
  return (scope: FastifyInstance, _options, done) => {
    scope.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
    scope.setErrorHandler((error, request, reply) => {
      logger.error(
        { err: error, path: request.url, method: request.method },
        'local storage route',
      );
      return sendError(reply.headers(UPLOAD_CORS), error);
    });

    scope.options(`${LOCAL_UPLOAD_PATH}/*`, (_request, reply) =>
      reply.headers(UPLOAD_CORS).status(HttpStatus.NO_CONTENT).send(),
    );

    scope.put<{ Params: { '*': string } }>(`${LOCAL_UPLOAD_PATH}/*`, async (request, reply) => {
      await storage.acceptUpload(
        request.params['*'],
        request.headers['content-type'],
        request.headers['content-length'],
        request.body as Readable,
      );
      return reply.headers(UPLOAD_CORS).status(HttpStatus.OK).send();
    });

    const servePublic = async (key: string, reply: FastifyReply, withBody: boolean) => {
      const object = await storage.openPublic(key);
      if (!object) {
        return reply.status(HttpStatus.NOT_FOUND).send({
          statusCode: HttpStatus.NOT_FOUND,
          error: 'NOT_FOUND',
          message: 'No such file.',
        });
      }
      reply
        .header('content-type', object.contentType)
        .header('content-length', String(object.byteSize))
        .header('x-content-type-options', 'nosniff');
      if (object.cacheControl) reply.header('cache-control', object.cacheControl);
      if (!withBody) {
        object.stream.destroy();
        return reply.send();
      }
      return reply.send(object.stream);
    };
    scope.get<{ Params: { '*': string } }>(`${PUBLIC_MEDIA_PATH}/*`, (request, reply) =>
      servePublic(request.params['*'], reply, true),
    );
    scope.head<{ Params: { '*': string } }>(`${PUBLIC_MEDIA_PATH}/*`, (request, reply) =>
      servePublic(request.params['*'], reply, false),
    );
    done();
  };
}

/**
 * Mounts localStorageRoutes on the HTTP server when STORAGE_DRIVER=local.
 * A no-op in the worker (no HTTP server) and with the S3 driver.
 */
@Injectable()
export class LocalStorageRoutes implements OnModuleInit {
  private readonly logger = new Logger(LocalStorageRoutes.name);

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  async onModuleInit(): Promise<void> {
    const adapter = this.adapterHost.httpAdapter as { getInstance?: () => unknown } | undefined;
    if (!(this.storage instanceof LocalStorageService) || !adapter?.getInstance) return;
    const fastify = adapter.getInstance() as FastifyInstance;
    await fastify.register(localStorageRoutes(this.storage, this.logger));
  }
}
