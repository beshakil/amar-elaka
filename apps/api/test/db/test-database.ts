import { mkdtempSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { loadDotenv } from '../../src/config/load-dotenv';

export const MIGRATIONS_FOLDER = join(__dirname, '..', '..', '..', '..', 'infra', 'migrations');
export const MIGRATIONS_SCHEMA = 'drizzle';
export const MIGRATIONS_TABLE = '__drizzle_migrations';

/**
 * Migrations that must run before the RLS roles are usable, so they run as
 * the superuser: 0000 creates extensions, 0001 has no roles to run as yet,
 * 0002 reassigns table ownership to ae_migrator and needs to already own
 * everything it's reassigning (docs/decisions/019-row-level-security.md).
 * Every later migration runs as ae_migrator, same as `pnpm db:migrate` in
 * real deployments after `MIGRATION_DATABASE_URL` is switched over.
 */
const SUPERUSER_ONLY_MIGRATION_TAGS = new Set([
  '0000_foundation',
  '0001_tenancy_identity',
  '0002_row_level_security',
]);

/**
 * Three roles, three connections:
 *
 *  - TEST_DATABASE_URL      superuser. Only for DROP/CREATE SCHEMA and for
 *                           applying migrations from scratch (0000 creates
 *                           extensions, which needs superuser).
 *  - TEST_APP_DATABASE_URL  ae_app. What every test that touches data uses,
 *                           because it is what the API connects as — RLS is
 *                           only exercised if the test role is subject to it.
 *  - TEST_MIGRATOR_DATABASE_URL  ae_migrator. Owns the schema; used by tests
 *                           that assert what the owner can and cannot do, and
 *                           by incremental migrations (0003+).
 */

/** The dedicated test database. Refuses to run against the dev database. */
export function resolveTestDatabaseUrl(): string {
  return requireTestUrl('TEST_DATABASE_URL');
}

/** Connection as `ae_app`: unprivileged, RLS enforced. */
export function resolveTestAppDatabaseUrl(): string {
  return requireTestUrl('TEST_APP_DATABASE_URL');
}

/** Connection as `ae_migrator`: schema owner, still subject to FORCE RLS. */
export function resolveTestMigratorDatabaseUrl(): string {
  return requireTestUrl('TEST_MIGRATOR_DATABASE_URL');
}

function requireTestUrl(name: string): string {
  loadDotenv();
  const url = process.env[name];
  if (!url) {
    throw new Error(
      `${name} is not set. Database tests must run against the dedicated test database ` +
        '(see .env.example, and run `make db-roles-test`).',
    );
  }
  if (url === process.env.DATABASE_URL) {
    throw new Error(`${name} must not point at the dev database (DATABASE_URL).`);
  }
  return url;
}

export function testSqlClient(max: number, url = resolveTestDatabaseUrl()): Sql {
  return postgres(url, { max, onnotice: () => undefined });
}

interface Journal {
  version: string;
  dialect: string;
  entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
}

/**
 * A migrationsFolder containing only the superuser-only entries, copied
 * byte-for-byte from MIGRATIONS_FOLDER. drizzle hashes a migration by its
 * file content (see readMigrationFiles in drizzle-orm/migrator), so applying
 * a byte-identical copy here and then pointing migrate() at the real,
 * complete folder as ae_migrator makes drizzle recognise these as already
 * applied and move straight on to 0003+ — no drizzle-internal state is
 * duplicated or forked, only these few files are.
 */
function buildSuperuserOnlyMigrationsFolder(): string {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;
  const superuserEntries = journal.entries.filter((entry) =>
    SUPERUSER_ONLY_MIGRATION_TAGS.has(entry.tag),
  );

  const dir = mkdtempSync(join(tmpdir(), 'ae-superuser-migrations-'));
  mkdirSync(join(dir, 'meta'), { recursive: true });
  writeFileSync(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: superuserEntries }),
  );
  for (const entry of superuserEntries) {
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  }
  return dir;
}

/**
 * Drops everything and re-applies infra/migrations from scratch, matching
 * how a real deployment bootstraps: 0000–0002 as the superuser, everything
 * from 0003 on as ae_migrator (see SUPERUSER_ONLY_MIGRATION_TAGS). Requires
 * the ae_migrator/ae_app roles to already exist (`make db-roles-test`).
 */
export async function resetAndMigrate(): Promise<void> {
  const superuserSql = testSqlClient(1);
  try {
    await superuserSql.unsafe(`DROP SCHEMA IF EXISTS ${MIGRATIONS_SCHEMA} CASCADE`);
    await superuserSql.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await superuserSql.unsafe('CREATE SCHEMA public');

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

  const migratorSql = testSqlClient(1, resolveTestMigratorDatabaseUrl());
  try {
    await migrate(drizzle(migratorSql), {
      migrationsFolder: MIGRATIONS_FOLDER,
      migrationsSchema: MIGRATIONS_SCHEMA,
      migrationsTable: MIGRATIONS_TABLE,
    });
  } finally {
    await migratorSql.end();
  }
}

/** Runs `work` in a transaction that is always rolled back. */
export async function inRollback(
  sql: Sql,
  work: (tx: TransactionSql) => Promise<void>,
): Promise<void> {
  const rollback = new Error('rollback');
  await sql
    .begin(async (tx) => {
      await work(tx);
      throw rollback;
    })
    .catch((error: unknown) => {
      if (error !== rollback) throw error;
    });
}
