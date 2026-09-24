import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

/**
 * One definition of the published document, used both by the dev server's
 * /api/docs and by the offline capture that writes packages/shared-types'
 * openapi.json — so the committed spec is exactly what the server serves.
 *
 * Paths are relative to the API's `/api/v1` base: the global prefix and URI
 * version are applied by main.ts at the router, and every client configures
 * its base URL to include them.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Amar Elaka API')
    .setDescription('Hyperlocal multi-tenant platform API')
    .setVersion('1.0')
    .build();
  return SwaggerModule.createDocument(app, config);
}
