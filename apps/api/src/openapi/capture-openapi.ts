import 'reflect-metadata';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Writes the OpenAPI document without a running API or any of its
 * infrastructure: the app is created in Nest's preview mode, which builds the
 * module graph and reads controller/DTO metadata without instantiating a
 * single provider — so no Postgres, Redis or Meilisearch connection is ever
 * attempted.
 *
 * Runs from the tsc-compiled dist/, never through tsx: esbuild drops the
 * `design:type` parameter metadata Swagger reflects on, which silently
 * empties request schemas (docs/decisions/001).
 *
 * Usage: node dist/openapi/capture-openapi.js <output file>
 */

// env.ts validates process.env at import time. Preview mode never connects to
// anything, so placeholders that merely satisfy the schema are enough — they
// are applied only where the caller has not set a real value.
const PLACEHOLDER_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://openapi:openapi@127.0.0.1:1/openapi',
  REDIS_URL: 'redis://127.0.0.1:1',
  MEILI_HOST: 'http://127.0.0.1:1',
  MEILI_MASTER_KEY: 'openapi-capture',
  STORAGE_PUBLIC_URL: 'http://127.0.0.1:1/media',
  JWT_SECRET: 'openapi-capture-placeholder-secret',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '60d',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1',
  SMTP_FROM: 'openapi@example.com',
  GOOGLE_CLIENT_ID: 'openapi-capture',
  APP_ROOT_DOMAIN: 'openapi.local',
};

async function main(): Promise<void> {
  const outFile = process.argv[2];
  if (!outFile) throw new Error('Usage: capture-openapi <output file>');

  for (const [key, value] of Object.entries(PLACEHOLDER_ENV)) {
    process.env[key] ??= value;
  }

  // Imported only after the placeholders exist, because importing the app
  // module is what triggers env validation.
  const { NestFactory } = await import('@nestjs/core');
  const { FastifyAdapter } = await import('@nestjs/platform-fastify');
  const { AppModule } = await import('../app.module');
  const { buildOpenApiDocument } = await import('./openapi-document');

  const app = await NestFactory.create(AppModule, new FastifyAdapter(), {
    preview: true,
    logger: ['error'],
  });
  const document = buildOpenApiDocument(app);
  await app.close();

  const target = resolve(outFile);
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`Wrote ${target}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
