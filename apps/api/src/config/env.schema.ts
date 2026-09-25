import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

const durationString = z
  .string()
  .regex(/^\d+(ms|s|m|h|d|y)$/, 'must be a duration like 15m, 60d, or 500ms');

const S3_REQUIRED_KEYS = [
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET_MEDIA',
  'S3_BUCKET_DOCUMENTS',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
] as const;

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().max(65535).default(3000),

    // Postgres (PostGIS)
    DATABASE_URL: z.string().url(),
    // Role that owns the schema and runs migrations. Falls back to DATABASE_URL
    // until the owner/app role split lands with RLS.
    MIGRATION_DATABASE_URL: z.string().url().optional(),
    // Pool sizing & timeouts (src/database). Per API instance: keep
    // instances × DB_POOL_MAX well under Postgres max_connections.
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),
    DB_IDLE_TIMEOUT_S: z.coerce.number().int().positive().default(30),
    DB_CONNECT_TIMEOUT_S: z.coerce.number().int().positive().default(5),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
    // Set false behind PgBouncer in transaction mode (no server-side prepared statements).
    DB_PREPARE: booleanString.default('true'),
    // Retries for serialization failures / deadlocks only (SQLSTATE 40001, 40P01).
    DB_TX_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),

    // Redis
    REDIS_URL: z.string().url(),

    // Settings cache (see src/settings). Infrastructure tuning, not business
    // rules — business numbers live in platform_settings (CLAUDE.md rule 9).
    SETTINGS_CACHE_TTL_MS: z.coerce.number().int().positive().default(60_000),
    SETTINGS_SOURCE_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),

    // Meilisearch
    MEILI_HOST: z.string().url(),
    MEILI_MASTER_KEY: z.string().min(1),
    // Prepended to every index name (posts, stores, places), so several
    // environments or test runs can share one Meilisearch without collisions.
    MEILI_INDEX_PREFIX: z
      .string()
      .regex(/^[a-z0-9_]*$/)
      .default(''),
    // Transport tuning for search calls (CLAUDE.md rule 5), not business rules.
    MEILI_TIMEOUT_MS: z.coerce.number().int().positive().default(1_500),

    // Geocoding (Barikoi). Without a key, geocoding degrades to coordinates and
    // our own area data — it never fails the request (src/locations/geocoding).
    BARIKOI_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
    BARIKOI_BASE_URL: z.string().url().default('https://barikoi.xyz'),
    // Transport tuning (CLAUDE.md rule 5), not a business rule.
    GEOCODING_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),

    // Object storage — S3_* fields only matter when STORAGE_DRIVER=s3 (see
    // the superRefine below), so they're optional here.
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_PATH: z.string().min(1).default('./storage/uploads'),
    // Public base of the media bucket. local: `${API_PUBLIC_URL}/media` (the
    // API serves it); s3: the provider's public link or a CDN (ADR 027/028).
    STORAGE_PUBLIC_URL: z.string().url(),
    // The API's public origin, e.g. https://api.amarelaka.com. Required for
    // STORAGE_DRIVER=local: upload URLs handed to apps point here.
    API_PUBLIC_URL: z.string().url().optional(),
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().min(1).optional(),
    // Public-read (avatars, post photos, ...) vs private (verification
    // documents, read only via short-lived presigned GETs).
    S3_BUCKET_MEDIA: z.string().min(1).optional(),
    S3_BUCKET_DOCUMENTS: z.string().min(1).optional(),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_FORCE_PATH_STYLE: booleanString.default('true'),

    // JWT
    JWT_SECRET: z.string().min(16, 'must be at least 16 characters'),
    JWT_ACCESS_TTL: durationString,
    JWT_REFRESH_TTL: durationString,

    // SMTP
    SMTP_HOST: z.string().min(1),
    SMTP_PORT: z.coerce.number().int().positive().max(65535),
    SMTP_FROM: z.string().email(),

    // SMS — local stub provider by default; real provider fields are optional
    // until a provider module is built.
    SMS_PROVIDER: z.string().min(1).default('local'),
    SMS_API_URL: z.string().optional().default(''),
    SMS_API_KEY: z.string().optional().default(''),
    SMS_SENDER_ID: z.string().optional().default(''),

    // Google OAuth — audience check only; ID tokens are verified locally via
    // google-auth-library, so no client secret is needed.
    GOOGLE_CLIENT_ID: z.string().min(1),

    // Tenant resolution (src/database/tenant-resolution.middleware.ts).
    // Base domain stripped off the Host header to read a tenant's subdomain,
    // e.g. Host "mirpur.amarelaka.local" -> slug "mirpur".
    APP_ROOT_DOMAIN: z.string().min(1),
    // Infrastructure tuning, not a business rule (same treatment as
    // SETTINGS_CACHE_TTL_MS) — how long a resolved tenant stays cached in
    // Redis before the next request re-reads Postgres.
    TENANT_CACHE_TTL_MS: z.coerce.number().int().positive().default(300_000),
    // Same infra-tuning treatment — how long a resolved permission set
    // (rbac/permissions.service.ts) stays cached before the next request
    // re-reads Postgres.
    PERMISSIONS_CACHE_TTL_MS: z.coerce.number().int().positive().default(300_000),
  })
  .superRefine((env, ctx) => {
    if (env.STORAGE_DRIVER === 'local' && !env.API_PUBLIC_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['API_PUBLIC_URL'],
        message: 'API_PUBLIC_URL is required when STORAGE_DRIVER=local',
      });
    }
    if (env.STORAGE_DRIVER !== 's3') return;
    for (const key of S3_REQUIRED_KEYS) {
      if (!env[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when STORAGE_DRIVER=s3`,
        });
      }
    }
  });

export type Env = z.infer<typeof EnvSchema>;
