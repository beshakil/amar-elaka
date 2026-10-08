import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/**
 * Lets a request say `content-type: application/json` with no body, meaning
 * "no body". Fastify refuses that by default (FST_ERR_CTP_EMPTY_JSON_BODY,
 * 400, before any guard or filter), and the app's HTTP client sends the
 * header on every POST, so every bodiless action from a phone failed: save,
 * follow, mark read (found on a device). Nest owns the JSON parser, so this
 * only drops the content type of a request whose body is empty; a body that
 * is there but isn't JSON is still a 400.
 */
export function allowEmptyJsonBody(app: NestFastifyApplication): void {
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', (request, _reply, done) => {
      const type = request.headers['content-type'];
      const empty =
        request.headers['content-length'] === '0' ||
        (request.headers['content-length'] === undefined &&
          request.headers['transfer-encoding'] === undefined);
      if (typeof type === 'string' && type.startsWith('application/json') && empty) {
        delete request.headers['content-type'];
      }
      done();
    });
}
