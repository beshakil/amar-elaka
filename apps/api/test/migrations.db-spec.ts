import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql, TransactionSql } from 'postgres';
import { inRollback, MIGRATIONS_FOLDER, testSqlClient } from './db/test-database';

const MIGRATIONS_JOURNAL = join(MIGRATIONS_FOLDER, 'meta', '_journal.json');

const PARTNER = '0191e3a0-0000-7000-8000-0000000000a1';
const AREA_1 = '0191e3a0-0000-7000-8000-0000000000e1';
const AREA_2 = '0191e3a0-0000-7000-8000-0000000000e2';
const POINT = 'SRID=4326;POINT(90.2667 23.8583)';

async function insertTenant(
  tx: TransactionSql,
  slug: string,
  geoAreaId: string,
  status = 'provisioning',
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into tenants (partner_id, geo_area_id, slug, name_bn, name_en, status_code, map_center)
    values (${PARTNER}, ${geoAreaId}, ${slug}, 'সাভার', 'Savar', ${status}, ${POINT})
    returning id`;
  if (!row) throw new Error('tenant insert returned nothing');
  return row.id;
}

async function insertUser(tx: TransactionSql, phone: string): Promise<string> {
  const [row] = await tx<
    { id: string }[]
  >`insert into users (phone_e164) values (${phone}) returning id`;
  if (!row) throw new Error('user insert returned nothing');
  return row.id;
}

async function expectRejected(
  tx: TransactionSql,
  statement: (sp: TransactionSql) => Promise<unknown>,
  code: string,
) {
  await expect(tx.savepoint((sp) => statement(sp))).rejects.toMatchObject({
    code,
  });
}

describe('Migrations', () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = testSqlClient(2);
    // tenants.partner_id and tenants.geo_area_id have been real FKs since
    // 0003/0004; every tenant fixture in this file needs both to point at.
    await sql`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Fixture Partner Ltd.', 'Fixture Partner', '+8801711000099')
      on conflict (id) do nothing`;
    await sql`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release)
      values
        (${AREA_1}, 3, 'upazila', '00-fixture-1', 'Fixture Area 1', 'fixture'),
        (${AREA_2}, 3, 'upazila', '00-fixture-2', 'Fixture Area 2', 'fixture')
      on conflict (id) do nothing`;
  });

  afterAll(async () => {
    await sql.end();
  });

  it('applied every migration in the journal, in order', async () => {
    const journal = JSON.parse(readFileSync(MIGRATIONS_JOURNAL, 'utf8')) as {
      entries: { idx: number }[];
    };
    const rows = await sql<{ count: string }[]>`select count(*) from drizzle.__drizzle_migrations`;
    expect(Number(rows[0]?.count)).toBe(journal.entries.length);
  });

  describe('uuid_generate_v7()', () => {
    it('produces RFC 9562 version-7 UUIDs with the variant bits set', async () => {
      const rows = await sql<
        { id: string }[]
      >`select uuid_generate_v7()::text as id from generate_series(1, 1000)`;
      const ids = rows.map((row) => row.id);
      expect(new Set(ids).size).toBe(1000);
      for (const id of ids) {
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      }
    });

    it('embeds the current Unix time in milliseconds', async () => {
      const [row] = await sql<{ id: string; now_ms: string }[]>`
        select uuid_generate_v7()::text as id,
               floor(extract(epoch from clock_timestamp()) * 1000)::bigint::text as now_ms`;
      const embeddedMs = parseInt(row!.id.replace(/-/g, '').slice(0, 12), 16);
      expect(Math.abs(embeddedMs - Number(row!.now_ms))).toBeLessThan(1000);
    });

    it('sorts by creation time across milliseconds', async () => {
      const [row] = await sql<{ first: string; second: string }[]>`
        select uuid_generate_v7()::text as first, (select pg_sleep(0.005)) is null as _pause,
               uuid_generate_v7()::text as second`;
      expect(row!.first < row!.second).toBe(true);
    });
  });

  describe('set_updated_at()', () => {
    it('is attached as a BEFORE UPDATE trigger to every table with updated_at', async () => {
      const missing = await sql<{ table_name: string }[]>`
        select c.relname as table_name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'updated_at' and not a.attisdropped
        where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
          and not exists (
            select 1 from pg_trigger t
            join pg_proc p on p.oid = t.tgfoid
            where t.tgrelid = c.oid and p.proname = 'set_updated_at'
              and (t.tgtype & 2) = 2   -- BEFORE
              and (t.tgtype & 16) = 16 -- UPDATE
          )
        order by 1`;
      expect(missing).toEqual([]);
    });

    it('bumps updated_at on update', async () => {
      await inRollback(sql, async (tx) => {
        const id = await insertTenant(tx, 'savar', AREA_1);
        await tx`update tenants set updated_at = now() - interval '1 day' where id = ${id}`;
        const [before] = await tx<
          { updated_at: Date }[]
        >`select updated_at from tenants where id = ${id}`;
        expect(Date.now() - before!.updated_at.getTime()).toBeLessThan(60_000);
      });
    });
  });

  describe('constraints', () => {
    it('accepts only Bangladeshi mobile numbers for live users, but allows a tombstone after deletion', async () => {
      await inRollback(sql, async (tx) => {
        await insertUser(tx, '+8801712345678');
        await expectRejected(tx, (sp) => insertUser(sp, '+8801212345678'), '23514');
        await expectRejected(tx, (sp) => insertUser(sp, '+447700900123'), '23514');
        await expectRejected(tx, (sp) => insertUser(sp, '01712345678'), '23514');
        await tx`insert into users (phone_e164, deleted_at) values ('scrubbed:0191e3a0', now())`;
      });
    });

    it('keeps one live account per phone and frees the number when the account closes', async () => {
      await inRollback(sql, async (tx) => {
        const first = await insertUser(tx, '+8801812345678');
        await expectRejected(tx, (sp) => insertUser(sp, '+8801812345678'), '23505');
        await tx`update users set deleted_at = now() where id = ${first}`;
        await insertUser(tx, '+8801812345678');
      });
    });

    it('allows one membership per user per tenant', async () => {
      await inRollback(sql, async (tx) => {
        const tenantId = await insertTenant(tx, 'dhamrai', AREA_1);
        const userId = await insertUser(tx, '+8801912345678');
        await tx`insert into tenant_members (tenant_id, user_id) values (${tenantId}, ${userId})`;
        await expectRejected(
          tx,
          (sp) =>
            sp`insert into tenant_members (tenant_id, user_id) values (${tenantId}, ${userId})`,
          '23505',
        );
      });
    });

    it('allows one live tenant per area, and re-letting an archived one', async () => {
      await inRollback(sql, async (tx) => {
        await insertTenant(tx, 'old-savar', AREA_2, 'archived');
        await insertTenant(tx, 'new-savar', AREA_2);
        await expectRejected(tx, (sp) => insertTenant(sp, 'third-savar', AREA_2), '23505');
        await expectRejected(tx, (sp) => insertTenant(sp, 'Bad Slug', AREA_1), '23514');
      });
    });

    it('enforces blacklist identifier, evidence and reviewer rules', async () => {
      await inRollback(sql, async (tx) => {
        const admin = await insertUser(tx, '+8801512345678');
        const insertEntry = (
          sp: TransactionSql,
          fields: {
            phone: string | null;
            status: string;
            evidence: string;
            reviewer: string | null;
          },
        ) =>
          sp`insert into blacklist_entries
               (phone_e164, reason_code, severity_code, status_code, summary, recommended_by_user_id, evidence_refs, reviewed_by_user_id)
             values (${fields.phone}, 'advance_payment_scam', 'banned', ${fields.status}, 'Took advance for a cow, never delivered',
                     ${admin}, ${fields.evidence}::text::jsonb, ${fields.reviewer})`;

        await insertEntry(tx, {
          phone: '+8801612345678',
          status: 'recommended',
          evidence: '[]',
          reviewer: null,
        });
        await expectRejected(
          tx,
          (sp) =>
            insertEntry(sp, {
              phone: null,
              status: 'recommended',
              evidence: '[]',
              reviewer: null,
            }),
          '23514',
        );
        await expectRejected(
          tx,
          (sp) =>
            insertEntry(sp, {
              phone: '+8801612345679',
              status: 'active',
              evidence: '[]',
              reviewer: admin,
            }),
          '23514',
        );
        await expectRejected(
          tx,
          (sp) =>
            insertEntry(sp, {
              phone: '+8801612345679',
              status: 'active',
              evidence: '[{"type":"report","id":"x"}]',
              reviewer: null,
            }),
          '23514',
        );
      });
    });
  });

  describe('audit_logs', () => {
    it('routes rows into monthly partitions with Asia/Dhaka boundaries', async () => {
      await inRollback(sql, async (tx) => {
        await tx`insert into audit_logs (actor_role, action, entity_table) values ('system', 'tenant.create', 'tenants')`;
        const [row] = await tx<{ partition: string }[]>`
          select tableoid::regclass::text as partition from audit_logs order by occurred_at desc limit 1`;
        expect(row!.partition).toMatch(/^audit_logs_y\d{4}m\d{2}$/);

        // The partition holding "now" must start exactly at Dhaka midnight on the 1st
        // (compared in the session time zone, as pg_get_expr prints it).
        const [bounds] = await tx<{ bound: string; dhaka_month_start: string }[]>`
          select pg_get_expr(c.relpartbound, c.oid) as bound,
                 ((date_trunc('month', now() at time zone 'Asia/Dhaka')) at time zone 'Asia/Dhaka')::text
                   as dhaka_month_start
          from pg_class c where c.relname = ${row!.partition}`;
        expect(bounds!.bound.startsWith(`FOR VALUES FROM ('${bounds!.dhaka_month_start}')`)).toBe(
          true,
        );
      });
    });

    it('rejects rows outside any partition instead of hiding them in a default partition', async () => {
      await inRollback(sql, async (tx) => {
        await expectRejected(
          tx,
          (sp) => sp`insert into audit_logs (occurred_at, actor_role, action, entity_table)
                     values (now() + interval '5 years', 'system', 'tenant.create', 'tenants')`,
          '23514',
        );
      });
    });

    it('is immutable', async () => {
      await inRollback(sql, async (tx) => {
        await tx`insert into audit_logs (actor_role, action, entity_table) values ('system', 'user.login', 'users')`;
        await expectRejected(tx, (sp) => sp`update audit_logs set reason = 'edited'`, '42501');
        await expectRejected(tx, (sp) => sp`delete from audit_logs`, '42501');
      });
    });

    it('creates partitions idempotently', async () => {
      await inRollback(sql, async (tx) => {
        const [first] = await tx<{ created: number }[]>`
          select ensure_audit_log_partitions(((now() at time zone 'Asia/Dhaka') + interval '6 months')::date, 2) as created`;
        const [again] = await tx<{ created: number }[]>`
          select ensure_audit_log_partitions(((now() at time zone 'Asia/Dhaka') + interval '6 months')::date, 2) as created`;
        expect(first!.created).toBe(2);
        expect(again!.created).toBe(0);
      });
    });
  });
});
