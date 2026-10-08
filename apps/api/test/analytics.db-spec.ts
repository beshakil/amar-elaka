import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * analytics_daily and the seller analytics functions (0051, ADR 055) as the
 * application's connection sees them: RLS (staff of the tenant only, never a
 * scrubbed row, never across tenants), "whose numbers may I see"
 * (seller_scope_posts), the system-only lead rollup and the scrub trigger.
 */

const P = '0191e3a0-a0ca-7000-8000-';
const FIXTURE = `${P}%`;
const PARTNER = `${P}000000000001`;
const AREA_A = `${P}000000000011`;
const AREA_B = `${P}000000000012`;
const TENANT_A = `${P}000000000021`;
const TENANT_B = `${P}000000000022`;
const U_OWNER = `${P}000000000031`;
const U_EDITOR = `${P}000000000032`;
const U_MOD = `${P}000000000033`;
const M_OWNER = `${P}000000000041`;
const M_EDITOR = `${P}000000000042`;
const M_MOD = `${P}000000000043`;
const M_MOD_B = `${P}000000000044`;
const STORE = `${P}000000000051`;
const CATEGORY = `${P}000000000061`;
const SCHEMA = `${P}000000000062`;
const POST = `${P}000000000071`;

type Context = Partial<Record<'tenant_id' | 'user_id' | 'member_id' | 'role', string>>;
const OWNER: Context = {
  tenant_id: TENANT_A,
  user_id: U_OWNER,
  member_id: M_OWNER,
  role: 'member',
};
const EDITOR: Context = {
  tenant_id: TENANT_A,
  user_id: U_EDITOR,
  member_id: M_EDITOR,
  role: 'member',
};
const MOD_A: Context = { tenant_id: TENANT_A, user_id: U_MOD, member_id: M_MOD, role: 'moderator' };
const MOD_B: Context = {
  tenant_id: TENANT_B,
  user_id: U_MOD,
  member_id: M_MOD_B,
  role: 'moderator',
};
const SYSTEM: Context = { role: 'system' };

describe('seller analytics in the database (0051)', () => {
  let app: Sql;
  let admin: Sql;

  const withContext = <T>(context: Context, work: (tx: TransactionSql) => Promise<T>): Promise<T> =>
    app.begin(async (tx) => {
      for (const [key, value] of Object.entries(context)) {
        await tx`select set_config(${`app.${key}`}, ${value}, true)`;
      }
      return work(tx);
    }) as Promise<T>;
  const stateOf = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: { code?: string }) => error.code ?? 'unknown',
    );

  async function cleanUp(): Promise<void> {
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from analytics_daily where tenant_id::text like ${FIXTURE}`;
      await tx`delete from lead_daily_stats where tenant_id::text like ${FIXTURE}`;
      await tx`delete from lead_events where tenant_id::text like ${FIXTURE}`;
      await tx`delete from moderation_actions where tenant_id::text like ${FIXTURE}`;
      await tx`delete from posts where tenant_id::text like ${FIXTURE}`;
      await tx`delete from store_members where tenant_id::text like ${FIXTURE}`;
      await tx`delete from stores where tenant_id::text like ${FIXTURE}`;
      await tx`delete from tenant_members where tenant_id::text like ${FIXTURE}`;
    });
    await admin`delete from outbox_events where aggregate_id::text like ${FIXTURE}`;
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    app = testSqlClient(2, resolveTestAppDatabaseUrl());
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();
    await admin`insert into users (id, phone_e164) values
      (${U_OWNER}, '+8801799500001'), (${U_EDITOR}, '+8801799500002'), (${U_MOD}, '+8801799500003')`;
    await admin`insert into partners (id, legal_name, display_name, phone_e164)
                values (${PARTNER}, 'Analytics DB', 'Analytics DB', '+8801799500099')`;
    await admin`insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
      (${AREA_A}, 3, 'upazila', 'analytics-db-a', 'A', 'fixture'), (${AREA_B}, 3, 'upazila', 'analytics-db-b', 'B', 'fixture')`;
    await admin`insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
      (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'analytics-db-a', 'এ', 'A', st_point(89.9, 24.9)::geography, 'active'),
      (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'analytics-db-b', 'বি', 'B', st_point(89.95, 24.9)::geography, 'active')`;
    await admin`insert into tenant_members (id, tenant_id, user_id, role_code) values
      (${M_OWNER}, ${TENANT_A}, ${U_OWNER}, 'member'), (${M_EDITOR}, ${TENANT_A}, ${U_EDITOR}, 'member'),
      (${M_MOD}, ${TENANT_A}, ${U_MOD}, 'moderator'), (${M_MOD_B}, ${TENANT_B}, ${U_MOD}, 'moderator')`;
    await admin`insert into categories (id, kind_code, slug, name_bn, name_en, default_moderation_mode_code, default_post_expiry_days)
                values (${CATEGORY}, 'marketplace', 'analytics-db-sale', 'বিক্রি', 'Sale', 'post', 30)`;
    await admin`insert into category_field_schemas (id, category_id, version, json_schema, status_code, published_at)
                values (${SCHEMA}, ${CATEGORY}, 1, '{}'::jsonb, 'published', now())`;
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code)
               values (${STORE}, ${TENANT_A}, ${M_OWNER}, 'analytics-db-store', 'দোকান', 'active')`;
      await tx`insert into store_members (tenant_id, store_id, member_id, role_code, accepted_at)
               values (${TENANT_A}, ${STORE}, ${M_EDITOR}, 'editor', now())`;
      await tx`insert into posts (id, tenant_id, author_member_id, store_id, category_id, field_schema_id, title,
                                  status_code, published_at, location, price_type_code)
               values (${POST}, ${TENANT_A}, ${M_OWNER}, ${STORE}, ${CATEGORY}, ${SCHEMA}, 'পোস্ট', 'live', now(),
                       st_point(89.9, 24.9)::geography, 'fixed')`;
    });
    await admin`insert into analytics_daily (tenant_id, entity_type, entity_id, stat_date, metrics)
                values (${TENANT_A}, 'post', ${POST}, current_date - 1, '{"views": 9}'::jsonb)`;
  });

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await app.end();
      await admin.end();
    }
  });

  it('analytics_daily: no member reads it directly; staff read their own tenant only', async () => {
    const asOwner = await withContext(
      OWNER,
      (tx) => tx`select id from analytics_daily where entity_id = ${POST}`,
    );
    expect(asOwner).toHaveLength(0);
    const asModA = await withContext(
      MOD_A,
      (tx) => tx`select id from analytics_daily where entity_id = ${POST}`,
    );
    expect(asModA).toHaveLength(1);
    const asModB = await withContext(
      MOD_B,
      (tx) => tx`select id from analytics_daily where entity_id = ${POST}`,
    );
    expect(asModB).toHaveLength(0);
    expect(
      await stateOf(
        withContext(
          MOD_A,
          (tx) => tx`
        insert into analytics_daily (entity_type, entity_id, stat_date, metrics)
        values ('post', ${POST}, current_date, '{}'::jsonb)`,
        ),
      ),
    ).toBe('42501');
  });

  it("seller_scope_posts: a store's owner yes, its editor no (AE250), another tenant's context nothing", async () => {
    const owner = await withContext(
      OWNER,
      (tx) => tx<{ post_id: string }[]>`select post_id from public.seller_scope_posts(${STORE})`,
    );
    expect(owner.map((r) => r.post_id)).toEqual([POST]);
    expect(
      await stateOf(
        withContext(EDITOR, (tx) => tx`select * from public.seller_scope_posts(${STORE})`),
      ),
    ).toBe('AE250');
    expect(
      await stateOf(
        withContext(
          { ...OWNER, tenant_id: TENANT_B },
          (tx) => tx`select * from public.seller_scope_posts(${STORE})`,
        ),
      ),
    ).toBe('AE250');
    // "My posts": the author's, wherever they are; the editor has none.
    const mine = await withContext(
      OWNER,
      (tx) => tx`select post_id from public.seller_scope_posts(null)`,
    );
    expect(mine).toHaveLength(1);
    expect(
      await withContext(EDITOR, (tx) => tx`select post_id from public.seller_scope_posts(null)`),
    ).toHaveLength(0);
  });

  it('seller_daily_metrics reads through the scope', async () => {
    const rows = await withContext(
      OWNER,
      (tx) => tx<{ metrics: { views: number } }[]>`
      select metrics from public.seller_daily_metrics(${STORE}, current_date - 7, current_date)`,
    );
    expect(rows.map((r) => r.metrics.views)).toEqual([9]);
  });

  it('the lead rollup is the system’s alone, and idempotent', async () => {
    await admin`insert into lead_events (tenant_id, channel_code, source_code, post_id, store_id, target_member_id, anon_session_hash, occurred_at)
                values (${TENANT_A}, 'sms_click', 'post_detail', ${POST}, ${STORE}, ${M_OWNER}, 'x', now() - interval '1 day')`;
    const day = (
      await admin<
        { d: string }[]
      >`select ((now() - interval '1 day') at time zone 'Asia/Dhaka')::date::text as d`
    )[0]!.d;
    expect(
      await stateOf(
        withContext(
          OWNER,
          (tx) => tx`select * from public.analytics_rollup_leads(${day}::date, 'Asia/Dhaka')`,
        ),
      ),
    ).toBe('42501');
    for (let run = 0; run < 2; run++) {
      const rows = await withContext(
        SYSTEM,
        (tx) => tx<{ post_id: string; event_count: number }[]>`
        select post_id, event_count from public.analytics_rollup_leads(${day}::date, 'Asia/Dhaka')
        where post_id = ${POST}`,
      );
      expect(rows).toEqual([{ post_id: POST, event_count: 1 }]);
    }
    const [stored] = await admin<
      { n: string }[]
    >`select count(*) as n from lead_daily_stats where post_id = ${POST}`;
    expect(Number(stored!.n)).toBe(1);
  });

  it('a scrub flags the post’s analytics; nobody reads them any more', async () => {
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`select set_config('app.tenant_id', ${TENANT_A}, true)`;
      await tx`insert into moderation_actions (tenant_id, post_id, actor_user_id, action_code, reason_code, reason_text, evidence_refs)
               values (${TENANT_A}, ${POST}, ${U_MOD}, 'moderator_removed', 'doxxing', 'fixture', '["e1"]')`;
      await tx`select public.scrub_post(${POST}::uuid, 'doxxing', 'moderator_removed')`;
    });
    const [row] = await admin<
      { subject_scrubbed: boolean }[]
    >`select subject_scrubbed from analytics_daily where entity_id = ${POST}`;
    expect(row!.subject_scrubbed).toBe(true);
    expect(
      await withContext(
        MOD_A,
        (tx) => tx`select id from analytics_daily where entity_id = ${POST}`,
      ),
    ).toHaveLength(0);
    expect(
      await withContext(OWNER, (tx) => tx`select * from public.seller_scope_posts(${STORE})`),
    ).toHaveLength(0);
    expect(
      await withContext(
        OWNER,
        (tx) =>
          tx`select * from public.seller_daily_metrics(${STORE}, current_date - 7, current_date)`,
      ),
    ).toHaveLength(0);
  });
});
