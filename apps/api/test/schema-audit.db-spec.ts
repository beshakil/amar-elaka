import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, type QueryResultRow } from 'pg';
import { withRetry, withTimeout } from '../src/common/utils/with-timeout';
import { loadDotenv } from '../src/config/load-dotenv';

/**
 * Runs scripts/audit-schema.sql against the dedicated test database and fails
 * if any check returns a row. A self-test plants one violation of each kind in
 * a throwaway schema (rolled back) to prove the checks can't silently pass.
 */

const AUDIT_SQL_PATH = join(__dirname, '..', '..', '..', 'scripts', 'audit-schema.sql');
const CONNECT_TIMEOUT_MS = 5_000;
const QUERY_TIMEOUT_MS = 30_000;
const SELF_TEST_SCHEMA = 'audit_selftest';
const MIGRATIONS_JOURNAL = join(
  __dirname,
  '..',
  '..',
  '..',
  'infra',
  'migrations',
  'meta',
  '_journal.json',
);

/**
 * Nothing is exempt any more: 0002_row_level_security enabled and forced RLS
 * on every table 0001 created. The list must stay empty — the "RLS_PENDING
 * expires" test below fails if a future migration adds an exemption instead of
 * a policy. Partitions are covered by the parent's policies plus their own
 * deny-all policy, and the audit query sees them as protected.
 */
const RLS_PENDING_UNTIL_MIGRATION_COUNT = 2;
const RLS_PENDING_TABLES: ReadonlySet<string> = new Set<string>([]);

function isRlsPending(tableName: string): boolean {
  return RLS_PENDING_TABLES.has(tableName);
}

const EXPECTED_CHECKS = [
  'missing_rls',
  'unspecified_on_delete',
  'float_money_columns',
  'timestamp_without_time_zone',
  'geography_without_gist',
  'status_deletion_enum_overlap',
  'purge_job_without_legal_hold_check',
] as const;

type CheckName = (typeof EXPECTED_CHECKS)[number];

interface AuditCheck {
  name: string;
  sql: string;
}

interface AuditRow extends QueryResultRow {
  table_name: string;
}

function parseChecks(source: string): AuditCheck[] {
  const markers = [...source.matchAll(/^-- @check ([a-z_]+)\s*$/gm)];
  return markers.map((marker, index) => {
    const name = marker[1];
    if (!name) {
      throw new Error(`Malformed @check marker: "${marker[0]}"`);
    }
    const start = (marker.index ?? 0) + marker[0].length;
    const next = markers[index + 1];
    const end = next?.index ?? source.length;
    return { name, sql: source.slice(start, end).trim() };
  });
}

function resolveTestDatabaseUrl(): string {
  loadDotenv();
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. The schema audit must run against the dedicated test database.',
    );
  }
  if (url === process.env.DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL must not point at the dev database (DATABASE_URL).');
  }
  return url;
}

async function connect(connectionString: string): Promise<Client> {
  return withRetry(async () => {
    const candidate = new Client({
      connectionString,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      statement_timeout: QUERY_TIMEOUT_MS,
    });
    try {
      await withTimeout(candidate.connect(), CONNECT_TIMEOUT_MS);
      return candidate;
    } catch (error) {
      await candidate.end().catch(() => undefined);
      throw error;
    }
  });
}

async function runCheck(client: Client, check: AuditCheck): Promise<AuditRow[]> {
  const result = await withTimeout(client.query<AuditRow>(check.sql), QUERY_TIMEOUT_MS);
  return result.rows;
}

function findCheck(checks: AuditCheck[], name: CheckName): AuditCheck {
  const check = checks.find((candidate) => candidate.name === name);
  if (!check) {
    throw new Error(`scripts/audit-schema.sql is missing the "${name}" check`);
  }
  return check;
}

describe('Schema audit (scripts/audit-schema.sql)', () => {
  const checks = parseChecks(readFileSync(AUDIT_SQL_PATH, 'utf8'));
  let client: Client;

  beforeAll(async () => {
    client = await connect(resolveTestDatabaseUrl());
  });

  afterAll(async () => {
    await client?.end();
  });

  it('defines exactly the seven expected checks', () => {
    expect(checks.map((check) => check.name)).toEqual([...EXPECTED_CHECKS]);
  });

  it.each(EXPECTED_CHECKS)('%s returns no rows', async (name) => {
    const rows = await runCheck(client, findCheck(checks, name));
    const violations =
      name === 'missing_rls' ? rows.filter((row) => !isRlsPending(row.table_name)) : rows;
    expect(violations).toEqual([]);
  });

  it('RLS_PENDING expires once the RLS migration exists', () => {
    const journal = JSON.parse(readFileSync(MIGRATIONS_JOURNAL, 'utf8')) as {
      entries: unknown[];
    };
    if (journal.entries.length > RLS_PENDING_UNTIL_MIGRATION_COUNT) {
      expect([...RLS_PENDING_TABLES]).toEqual([]);
    }
  });

  describe('self-test', () => {
    it('catches one planted violation of each kind and ignores a compliant table', async () => {
      const postgis = await client.query("select 1 from pg_extension where extname = 'postgis'");
      if (postgis.rows.length === 0) {
        throw new Error('The test database needs PostGIS (see infra/initdb/01-extensions.sql).');
      }

      await client.query('BEGIN');
      try {
        await client.query(`CREATE SCHEMA ${SELF_TEST_SCHEMA}`);

        // Violations: no RLS, FK without ON DELETE, float + wrong-precision money,
        // timestamp without time zone, geography without GiST.
        await client.query(`CREATE TABLE ${SELF_TEST_SCHEMA}.bad_parent (id integer PRIMARY KEY)`);
        await client.query(
          `CREATE TABLE ${SELF_TEST_SCHEMA}.bad_child (
             id integer PRIMARY KEY,
             parent_id integer REFERENCES ${SELF_TEST_SCHEMA}.bad_parent (id),
             price double precision,
             amount numeric,
             happened_at timestamp,
             location geography(Point, 4326)
           )`,
        );

        // Compliant counterpart: must not appear in any check.
        await client.query(`CREATE TABLE ${SELF_TEST_SCHEMA}.good_parent (id integer PRIMARY KEY)`);
        await client.query(
          `CREATE TABLE ${SELF_TEST_SCHEMA}.good_child (
             id integer PRIMARY KEY,
             parent_id integer REFERENCES ${SELF_TEST_SCHEMA}.good_parent (id) ON DELETE RESTRICT,
             price numeric(12,2),
             platform_share_rate_final numeric(5,4),
             balance_credits integer,
             happened_at timestamptz,
             location geography(Point, 4326)
           )`,
        );
        await client.query(
          `CREATE INDEX good_child_location_idx ON ${SELF_TEST_SCHEMA}.good_child USING gist (location)`,
        );
        // Status vs deletion-reason enums: 'sold' planted in both for bad_posts;
        // good_posts uses disjoint enums. These tables are otherwise compliant so
        // only the overlap check should report them.
        const enumTables: ReadonlyArray<[string, string[]]> = [
          ['bad_post_statuses', ['live', 'sold']],
          ['bad_post_deletion_reasons', ['user_deleted', 'sold']],
          ['good_post_statuses', ['live', 'sold']],
          ['good_post_deletion_reasons', ['user_deleted']],
        ];
        for (const [table, codes] of enumTables) {
          await client.query(`CREATE TABLE ${SELF_TEST_SCHEMA}.${table} (code text PRIMARY KEY)`);
          await client.query(
            `INSERT INTO ${SELF_TEST_SCHEMA}.${table} (code) SELECT unnest($1::text[])`,
            [codes],
          );
        }
        for (const prefix of ['bad', 'good']) {
          await client.query(
            `CREATE TABLE ${SELF_TEST_SCHEMA}.${prefix}_posts (
               id integer PRIMARY KEY,
               status_code text NOT NULL
                 REFERENCES ${SELF_TEST_SCHEMA}.${prefix}_post_statuses (code) ON DELETE RESTRICT,
               deletion_reason_code text
                 REFERENCES ${SELF_TEST_SCHEMA}.${prefix}_post_deletion_reasons (code) ON DELETE RESTRICT
             )`,
          );
        }

        const compliantTables = [
          'good_parent',
          'good_child',
          ...enumTables.map(([table]) => table),
          'bad_posts',
          'good_posts',
        ];
        for (const table of compliantTables) {
          await client.query(`ALTER TABLE ${SELF_TEST_SCHEMA}.${table} ENABLE ROW LEVEL SECURITY`);
          await client.query(`ALTER TABLE ${SELF_TEST_SCHEMA}.${table} FORCE ROW LEVEL SECURITY`);
          await client.query(
            `CREATE POLICY ${table}_all ON ${SELF_TEST_SCHEMA}.${table} USING (true)`,
          );
        }

        // Purge/scrub/anonymise jobs: one missing the legal-hold check, one calling
        // legal_hold_blocks(), one with an explicit exemption marker, and a
        // non-job function that the naming rule must ignore.
        await client.query(
          `CREATE FUNCTION ${SELF_TEST_SCHEMA}.legal_hold_blocks(subject_type text, subject_id uuid)
             RETURNS boolean LANGUAGE sql STABLE AS 'SELECT false'`,
        );
        await client.query(
          `CREATE FUNCTION ${SELF_TEST_SCHEMA}.purge_bad_media() RETURNS void LANGUAGE sql
             AS 'DELETE FROM ${SELF_TEST_SCHEMA}.good_parent WHERE false'`,
        );
        await client.query(
          `CREATE FUNCTION ${SELF_TEST_SCHEMA}.scrub_good_post(post uuid) RETURNS boolean LANGUAGE sql
             AS 'SELECT NOT ${SELF_TEST_SCHEMA}.legal_hold_blocks(''post'', post)'`,
        );
        await client.query(
          `CREATE FUNCTION ${SELF_TEST_SCHEMA}.purge_good_outbox() RETURNS void LANGUAGE plpgsql AS $fn$
           BEGIN
             -- legal-hold-exempt: outbox rows never reference holdable subjects
             DELETE FROM ${SELF_TEST_SCHEMA}.good_parent WHERE false;
           END
           $fn$`,
        );
        await client.query(
          `CREATE FUNCTION ${SELF_TEST_SCHEMA}.purgeable_count() RETURNS integer LANGUAGE sql AS 'SELECT 0'`,
        );

        await client.query("SELECT set_config('audit.schema', $1, true)", [SELF_TEST_SCHEMA]);

        const findings: Record<string, string[]> = {};
        for (const name of EXPECTED_CHECKS) {
          const rows = await runCheck(client, findCheck(checks, name));
          findings[name] = [...new Set(rows.map((row) => row.table_name))].sort();
        }

        expect(findings).toEqual({
          missing_rls: ['bad_child', 'bad_parent'],
          unspecified_on_delete: ['bad_child'],
          float_money_columns: ['bad_child'],
          timestamp_without_time_zone: ['bad_child'],
          geography_without_gist: ['bad_child'],
          status_deletion_enum_overlap: ['bad_posts'],
          purge_job_without_legal_hold_check: ['purge_bad_media'],
        });
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });
});
