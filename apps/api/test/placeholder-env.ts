import { loadDotenv } from '../src/config/load-dotenv';

/**
 * Placeholder env for the jest configs that run without a .env in CI (unit,
 * db, search). Importing any module that reaches src/config/env.ts validates
 * process.env at import time and exits when a required variable is missing,
 * so every suite that touches it would die before a single test ran.
 *
 * Order matters: the real .env (if any) is loaded first, then placeholders
 * fill only what is still unset. Locally your .env still wins (e.g. the real
 * MEILI_HOST for test:search); in CI the job's env vars win, and the
 * placeholders cover the rest. Nothing here is ever connected to.
 */
loadDotenv();

const PLACEHOLDER_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://unit:unit@127.0.0.1:1/unit',
  REDIS_URL: 'redis://127.0.0.1:1',
  MEILI_HOST: 'http://127.0.0.1:1',
  MEILI_MASTER_KEY: 'unit-test',
  STORAGE_PUBLIC_URL: 'http://127.0.0.1:1/media',
  API_PUBLIC_URL: 'http://127.0.0.1:1',
  JWT_SECRET: 'unit-test-placeholder-secret',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '60d',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1',
  SMTP_FROM: 'unit@example.com',
  GOOGLE_CLIENT_ID: 'unit-test',
  APP_ROOT_DOMAIN: 'unit.local',
};

for (const [key, value] of Object.entries(PLACEHOLDER_ENV)) {
  process.env[key] ??= value;
}
