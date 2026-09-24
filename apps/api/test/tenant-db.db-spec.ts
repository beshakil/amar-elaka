import { sql as drizzleSql } from 'drizzle-orm';
import type { Sql } from 'postgres';
import { createDatabase, createSqlClient, type Database } from '../src/database/database.client';
import { TenantContext, TenantContextMissingException } from '../src/database/tenant-context';
import { TenantDb } from '../src/database/tenant-db';
import { resolveTestAppDatabaseUrl } from './db/test-database';

/**
 * Proves the tenant context cannot leak between requests through the
 * connection pool (see the explanation on TenantDb).
 */

const TENANT_A = '0191e3a0-0000-7000-8000-00000000000a';
const TENANT_B = '0191e3a0-0000-7000-8000-00000000000b';
const USER_A = '0191e3a0-0000-7000-8000-0000000000c1';

interface Settings {
  pid: number;
  tenant_id: string | null;
  user_id: string | null;
  member_id: string | null;
  role: string | null;
}

const READ_SETTINGS = drizzleSql`
  select pg_backend_pid() as pid,
         current_setting('app.tenant_id', true) as tenant_id,
         current_setting('app.user_id', true) as user_id,
         current_setting('app.member_id', true) as member_id,
         current_setting('app.role', true) as role`;

function build(poolMax: number, maxRetries = 0) {
  const client = createSqlClient({
    url: resolveTestAppDatabaseUrl(),
    poolMax,
    idleTimeoutSeconds: 30,
    connectTimeoutSeconds: 5,
    statementTimeoutMs: 15_000,
    prepare: true,
    applicationName: 'tenant-db-test',
  });
  const db = createDatabase(client);
  const context = new TenantContext();
  const tenantDb = new TenantDb(db, context, { DB_TX_MAX_RETRIES: maxRetries });
  return { client, db, context, tenantDb };
}

async function readOutsideTransaction(db: Database): Promise<Settings> {
  const rows = await db.execute<Settings & Record<string, unknown>>(READ_SETTINGS);
  const [row] = rows;
  if (!row) throw new Error('no row');
  return row;
}

const empty = (value: string | null) => value === null || value === '';

describe('TenantDb transaction context', () => {
  describe('with a single pooled connection', () => {
    let client: Sql;
    let db: Database;
    let context: TenantContext;
    let tenantDb: TenantDb;

    beforeAll(() => {
      ({ client, db, context, tenantDb } = build(1));
    });

    afterAll(async () => {
      await client.end();
    });

    it('applies the context inside the transaction', async () => {
      const inside = await context.run({ tenantId: TENANT_A, userId: USER_A, role: 'member' }, () =>
        tenantDb.transaction(
          async (tx) => (await tx.execute<Settings & Record<string, unknown>>(READ_SETTINGS))[0],
        ),
      );
      expect(inside).toMatchObject({
        tenant_id: TENANT_A,
        user_id: USER_A,
        member_id: '',
        role: 'member',
      });
    });

    it('leaves nothing behind on the same connection after COMMIT', async () => {
      const inside = await context.run({ tenantId: TENANT_A, userId: USER_A }, () =>
        tenantDb.transaction(
          async (tx) => (await tx.execute<Settings & Record<string, unknown>>(READ_SETTINGS))[0],
        ),
      );
      const after = await readOutsideTransaction(db);

      expect(after.pid).toBe(inside?.pid); // same pooled backend connection
      expect(empty(after.tenant_id)).toBe(true);
      expect(empty(after.user_id)).toBe(true);
    });

    it('leaves nothing behind on the same connection after ROLLBACK', async () => {
      let pidInside: number | undefined;
      await expect(
        context.run({ tenantId: TENANT_B }, () =>
          tenantDb.transaction(async (tx) => {
            pidInside = (await tx.execute<Settings & Record<string, unknown>>(READ_SETTINGS))[0]
              ?.pid;
            throw new Error('boom');
          }),
        ),
      ).rejects.toThrow('boom');

      const after = await readOutsideTransaction(db);
      expect(after.pid).toBe(pidInside);
      expect(empty(after.tenant_id)).toBe(true);
    });

    it('keeps the context inside nested transactions (savepoints)', async () => {
      const nested = await context.run({ tenantId: TENANT_A }, () =>
        tenantDb.transaction((tx) =>
          tx.transaction(
            async (inner) =>
              (await inner.execute<Settings & Record<string, unknown>>(READ_SETTINGS))[0],
          ),
        ),
      );
      expect(nested?.tenant_id).toBe(TENANT_A);
    });

    it('refuses to run without a request context', async () => {
      await expect(tenantDb.transaction(() => Promise.resolve(undefined))).rejects.toBeInstanceOf(
        TenantContextMissingException,
      );
    });

    it('negative control: a session-level setting WOULD leak (which is why it is forbidden)', async () => {
      await db.execute(drizzleSql`select set_config('app.leak_probe', 'tenant-a', false)`);
      const [row] = await db.execute<{ probe: string } & Record<string, unknown>>(
        drizzleSql`select current_setting('app.leak_probe', true) as probe`,
      );
      expect(row?.probe).toBe('tenant-a');
      await db.execute(drizzleSql`reset app.leak_probe`);
    });
  });

  describe('under concurrency', () => {
    it('never shows one request the context of another', async () => {
      const { client, context, tenantDb } = build(4);
      try {
        const requests = Array.from({ length: 60 }, (_, index) => ({
          tenantId: index % 2 === 0 ? TENANT_A : TENANT_B,
          userId: `0191e3a0-0000-7000-8000-${index.toString(16).padStart(12, '0')}`,
        }));

        const results = await Promise.all(
          requests.map((request, index) =>
            context.run(request, () =>
              tenantDb.transaction(async (tx) => {
                await tx.execute(drizzleSql`select pg_sleep(${(index % 5) / 1000})`);
                return (await tx.execute<Settings & Record<string, unknown>>(READ_SETTINGS))[0];
              }),
            ),
          ),
        );

        results.forEach((row, index) => {
          expect({ tenant: row?.tenant_id, user: row?.user_id }).toEqual({
            tenant: requests[index]?.tenantId,
            user: requests[index]?.userId,
          });
        });
        // 60 transactions shared at most 4 connections, so reuse definitely happened.
        expect(new Set(results.map((row) => row?.pid)).size).toBeLessThanOrEqual(4);
      } finally {
        await client.end();
      }
    });
  });

  describe('retries', () => {
    it('retries serialization failures and re-applies the context each attempt', async () => {
      const { client, context, tenantDb } = build(1, 2);
      try {
        let attempts = 0;
        const tenant = await context.run({ tenantId: TENANT_A }, () =>
          tenantDb.transaction(async (tx) => {
            attempts += 1;
            if (attempts === 1) {
              await tx.execute(
                drizzleSql.raw(
                  "do $$ begin raise exception 'simulated' using errcode = '40001'; end $$",
                ),
              );
            }
            return (await tx.execute<Settings & Record<string, unknown>>(READ_SETTINGS))[0]
              ?.tenant_id;
          }),
        );
        expect(attempts).toBe(2);
        expect(tenant).toBe(TENANT_A);
      } finally {
        await client.end();
      }
    });

    it('does not retry other errors', async () => {
      const { client, context, tenantDb } = build(1, 2);
      try {
        let attempts = 0;
        await expect(
          context.run({ tenantId: TENANT_A }, () =>
            tenantDb.transaction(async (tx) => {
              attempts += 1;
              await tx.execute(drizzleSql.raw('select 1/0'));
            }),
          ),
        ).rejects.toBeDefined();
        expect(attempts).toBe(1);
      } finally {
        await client.end();
      }
    });
  });
});
