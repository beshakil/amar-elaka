import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { loadDotenv } from '../../config/load-dotenv';

/**
 * Drops and recreates the dev database's schema, then re-applies every
 * migration from scratch — the dev-database counterpart of
 * test/db/test-database.ts's resetAndMigrate(), which this mirrors
 * (duplicated rather than imported: that file lives under test/ and this
 * script isn't a test). 0000 (creates extensions) and 0002 (reassigns
 * table ownership to ae_migrator) need superuser; 0003+ must run as
 * ae_migrator, same as `pnpm db:migrate` in real deployments — running
 * them as superuser instead would leave every later table owned by the
 * superuser, not ae_migrator, breaking the "app never connects as the
 * owner" RLS invariant (docs/specs/schema.md §0.6). `pnpm db:reset` chains
 * this with `db:seed`.
 */

const MIGRATIONS_FOLDER = join(__dirname, '..', '..', '..', '..', '..', 'infra', 'migrations');
const MIGRATIONS_SCHEMA = 'drizzle';
const MIGRATIONS_TABLE = '__drizzle_migrations';
const SUPERUSER_ONLY_TAGS = new Set([
  '0000_foundation',
  '0001_tenancy_identity',
  '0002_row_level_security',
]);

interface Journal {
  version: string;
  dialect: string;
  entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
}

function buildSuperuserOnlyMigrationsFolder(): string {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;
  const entries = journal.entries.filter((e) => SUPERUSER_ONLY_TAGS.has(e.tag));

  const dir = mkdtempSync(join(tmpdir(), 'ae-superuser-migrations-'));
  mkdirSync(join(dir, 'meta'), { recursive: true });
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) {
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  }
  return dir;
}

async function main(): Promise<void> {
  loadDotenv();
  const superuserUrl = process.env.DEV_SUPERUSER_DATABASE_URL;
  const migratorUrl = process.env.MIGRATION_DATABASE_URL;
  if (!superuserUrl) throw new Error('Set DEV_SUPERUSER_DATABASE_URL to run db:reset.');
  if (!migratorUrl) throw new Error('Set MIGRATION_DATABASE_URL to run db:reset.');

  const superuserSql = postgres(superuserUrl, { max: 1, onnotice: () => undefined });
  try {
    console.log('Dropping public schema...');
    await superuserSql.unsafe(`DROP SCHEMA IF EXISTS ${MIGRATIONS_SCHEMA} CASCADE`);
    await superuserSql.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await superuserSql.unsafe('CREATE SCHEMA public');

    console.log('Migrating 0000-0002 as superuser...');
    const superuserOnlyFolder = buildSuperuserOnlyMigrationsFolder();
    try {
      await migrate(drizzle(superuserSql), {
        migrationsFolder: superuserOnlyFolder,
        migrationsSchema: MIGRATIONS_SCHEMA,
        migrationsTable: MIGRATIONS_TABLE,
      });
    } finally {
      rmSync(superuserOnlyFolder, { recursive: true, force: true });
    }
  } finally {
    await superuserSql.end();
  }

  console.log('Migrating 0003+ as ae_migrator...');
  const migratorSql = postgres(migratorUrl, { max: 1, onnotice: () => undefined });
  try {
    await migrate(drizzle(migratorSql), {
      migrationsFolder: MIGRATIONS_FOLDER,
      migrationsSchema: MIGRATIONS_SCHEMA,
      migrationsTable: MIGRATIONS_TABLE,
    });
  } finally {
    await migratorSql.end();
  }

  console.log('Reset complete.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
