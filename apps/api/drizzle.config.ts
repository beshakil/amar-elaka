import { defineConfig } from 'drizzle-kit';
import { loadDotenv } from './src/config/load-dotenv';

/**
 * Migrations are hand-written SQL in infra/migrations (create one with
 * `pnpm db:new <name>`), applied in journal order by `pnpm db:migrate`.
 * drizzle-kit never generates DDL from the TypeScript schema: most of the
 * spec (partitioning, exclusion constraints, triggers, RLS) can't be expressed
 * there. src/database/schema mirrors the tables for typed queries, and
 * test/schema-drift.db-spec.ts keeps the mirror honest.
 */
loadDotenv();

const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  throw new Error('Set MIGRATION_DATABASE_URL or DATABASE_URL to run drizzle-kit.');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema/index.ts',
  out: '../../infra/migrations',
  dbCredentials: { url },
  migrations: { schema: 'drizzle', table: '__drizzle_migrations' },
});
