import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * Migration 0027 against real Postgres: RLS on member_trust_scores and
 * moderation_queue_items (including cross-tenant isolation), and the guards
 * inside file_moderation_item() and scrub_post().
 */

const FIXTURE = '0191e3a0-7a11-7000-8000-%';
const PARTNER = '0191e3a0-7a11-7000-8000-000000000001';
const AREA_A = '0191e3a0-7a11-7000-8000-000000000011';
const AREA_B = '0191e3a0-7a11-7000-8000-000000000012';
const TENANT_A = '0191e3a0-7a11-7000-8000-000000000021';
const TENANT_B = '0191e3a0-7a11-7000-8000-000000000022';
const AUTHOR = '0191e3a0-7a11-7000-8000-000000000031';
const OTHER = '0191e3a0-7a11-7000-8000-000000000032';
const MOD_A = '0191e3a0-7a11-7000-8000-000000000033';
const MOD_B = '0191e3a0-7a11-7000-8000-000000000034';
const M_AUTHOR = '0191e3a0-7a11-7000-8000-000000000041';
const M_OTHER = '0191e3a0-7a11-7000-8000-000000000042';
const M_MOD_A = '0191e3a0-7a11-7000-8000-000000000043';
const M_MOD_B = '0191e3a0-7a11-7000-8000-000000000044';
const CATEGORY = '0191e3a0-7a11-7000-8000-000000000051';
const SCHEMA = '0191e3a0-7a11-7000-8000-000000000061';
const POST = '0191e3a0-7a11-7000-8000-000000000101';
const HOLD = '0191e3a0-7a11-7000-8000-000000000201';

type Context = Record<string, string>;
const member = (userId: string, memberId: string, tenantId = TENANT_A): Context => ({
  tenant_id: tenantId,
  user_id: userId,
  member_id: memberId,
  role: 'member',
});
const moderator = (userId: string, memberId: string, tenantId: string): Context => ({
  ...member(userId, memberId, tenantId),
  role: 'moderator',
});

async function as<T>(sql: Sql, context: Context, work: (tx: TransactionSql) => Promise<T>) {
  return sql.begin(async (tx) => {
    for (const [key, value] of Object.entries(context)) {
      await tx`select set_config(${`app.${key}`}, ${value}, true)`;
    }
    return work(tx);
  }) as Promise<T>;
}

describe('Trust and moderation tables (0027)', () => {
  let admin: Sql;
  let app: Sql;

  async function cleanUp(): Promise<void> {
    await admin`delete from legal_holds where id::text like ${FIXTURE}`;
    await admin`delete from moderation_queue_items where tenant_id::text like ${FIXTURE}`;
    await admin`delete from member_trust_scores where tenant_id::text like ${FIXTURE}`;
    await admin`delete from posts where tenant_id::text like ${FIXTURE}`;
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    app = testSqlClient(2, resolveTestAppDatabaseUrl());
    await cleanUp();
    await admin`
      insert into users (id, phone_e164) values
        (${AUTHOR}, '+8801788100001'), (${OTHER}, '+8801788100002'),
        (${MOD_A}, '+8801788100003'), (${MOD_B}, '+8801788100004')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Trust DB Partner', 'Trust DB Partner', '+8801788100099')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
        (${AREA_A}, 3, 'upazila', 'trust-db-a', 'Trust DB A', 'fixture'),
        (${AREA_B}, 3, 'upazila', 'trust-db-b', 'Trust DB B', 'fixture')`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
        (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'trust-db-a', 'এ', 'A', st_point(90.4, 23.8)::geography, 'active'),
        (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'trust-db-b', 'বি', 'B', st_point(90.5, 23.9)::geography, 'active')`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${M_AUTHOR}, ${TENANT_A}, ${AUTHOR}, 'member'), (${M_OTHER}, ${TENANT_A}, ${OTHER}, 'member'),
        (${M_MOD_A}, ${TENANT_A}, ${MOD_A}, 'moderator'), (${M_MOD_B}, ${TENANT_B}, ${MOD_B}, 'moderator')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en)
      values (${CATEGORY}, 'marketplace', 'trust-db-category', 'বিভাগ', 'Category')`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, status_code)
      values (${SCHEMA}, ${CATEGORY}, 1, '{}'::jsonb, 'draft')`;
    await admin`
      insert into posts (id, tenant_id, author_member_id, category_id, field_schema_id, title, status_code)
      values (${POST}, ${TENANT_A}, ${M_AUTHOR}, ${CATEGORY}, ${SCHEMA}, 'trust db post', 'pending')`;
    await admin`
      insert into member_trust_scores (tenant_id, member_id, score, components, algorithm_version)
      values (${TENANT_A}, ${M_AUTHOR}, 42, '{"base": 20}', 1), (${TENANT_A}, ${M_OTHER}, 55, '{}', 1)`;
  });

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await admin.end();
      await app.end();
    }
  });

  describe('member_trust_scores', () => {
    it('a member reads only their own score; staff read the tenant’s', async () => {
      const own = await as(
        app,
        member(AUTHOR, M_AUTHOR),
        (tx) => tx<{ member_id: string }[]>`
        select member_id from member_trust_scores`,
      );
      expect(own.map((r) => r.member_id)).toEqual([M_AUTHOR]);
      const staff = await as(
        app,
        moderator(MOD_A, M_MOD_A, TENANT_A),
        (tx) => tx`select 1 from member_trust_scores`,
      );
      expect(staff).toHaveLength(2);
    });

    it('staff of another tenant see nothing', async () => {
      const rows = await as(
        app,
        moderator(MOD_B, M_MOD_B, TENANT_B),
        (tx) => tx`select 1 from member_trust_scores`,
      );
      expect(rows).toHaveLength(0);
    });

    it('nobody but the system writes a score', async () => {
      const updated = await as(
        app,
        member(AUTHOR, M_AUTHOR),
        (tx) => tx`
        update member_trust_scores set score = 100 where member_id = ${M_AUTHOR}`,
      );
      expect(updated.count).toBe(0);
      const staffUpdate = await as(
        app,
        moderator(MOD_A, M_MOD_A, TENANT_A),
        (tx) => tx`
        update member_trust_scores set score = 100 where member_id = ${M_AUTHOR}`,
      );
      expect(staffUpdate.count).toBe(0);
    });
  });

  describe('moderation_queue_items', () => {
    it('the author files an item through file_moderation_item but cannot read the queue', async () => {
      await as(
        app,
        member(AUTHOR, M_AUTHOR),
        (tx) => tx`
        select public.file_moderation_item(${POST}::uuid, 'submission', array['low_trust']::text[], 42::smallint)`,
      );
      const seen = await as(
        app,
        member(AUTHOR, M_AUTHOR),
        (tx) => tx`select 1 from moderation_queue_items`,
      );
      expect(seen).toHaveLength(0);
      const [item] = await admin<{ author_member_id: string; reasons: string[] }[]>`
        select author_member_id, reasons from moderation_queue_items where post_id = ${POST}`;
      expect(item).toEqual({ author_member_id: M_AUTHOR, reasons: ['low_trust'] });
    });

    it("refuses to file for someone else's post, and never inserts directly", async () => {
      await expect(
        as(
          app,
          member(OTHER, M_OTHER),
          (tx) => tx`
          select public.file_moderation_item(${POST}::uuid, 'submission', array['low_trust']::text[], null)`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        as(
          app,
          member(AUTHOR, M_AUTHOR),
          (tx) => tx`
          insert into moderation_queue_items (post_id, author_member_id, source_code)
          values (${POST}, ${M_AUTHOR}, 'submission')`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('staff of the tenant see the item; staff of another tenant do not', async () => {
      const a = await as(
        app,
        moderator(MOD_A, M_MOD_A, TENANT_A),
        (tx) => tx`select 1 from moderation_queue_items`,
      );
      const b = await as(
        app,
        moderator(MOD_B, M_MOD_B, TENANT_B),
        (tx) => tx`select 1 from moderation_queue_items`,
      );
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(0);
    });

    it('rejects an unknown reason', async () => {
      await expect(
        admin`insert into moderation_queue_items (tenant_id, post_id, author_member_id, source_code, reasons)
              values (${TENANT_A}, ${POST}, ${M_AUTHOR}, 'rereview', array['vibes'])`,
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('scrub_post', () => {
    it('refuses without a moderation_actions row in the same transaction', async () => {
      await expect(
        as(
          app,
          moderator(MOD_A, M_MOD_A, TENANT_A),
          (tx) => tx`
          select public.scrub_post(${POST}::uuid, 'doxxing', 'moderator_removed')`,
        ),
      ).rejects.toMatchObject({ code: 'AE101' });
    });

    it('refuses a post under a legal hold, even with the action recorded', async () => {
      await admin`
        insert into legal_holds (id, subject_type_code, subject_id, reason, placed_by_user_id)
        values (${HOLD}, 'user', ${AUTHOR}, 'fixture', ${MOD_A})`;
      try {
        await expect(
          as(app, moderator(MOD_A, M_MOD_A, TENANT_A), async (tx) => {
            await tx`
              insert into moderation_actions (post_id, actor_user_id, action_code, reason_code, reason_text, evidence_refs)
              values (${POST}, ${MOD_A}, 'moderator_removed', 'doxxing', 'address', '["e1"]')`;
            return tx`select public.scrub_post(${POST}::uuid, 'doxxing', 'moderator_removed')`;
          }),
        ).rejects.toMatchObject({ code: 'AE100' });
      } finally {
        await admin`delete from legal_holds where id = ${HOLD}`;
      }
      const [row] = await admin<
        { scrubbed_at: Date | null }[]
      >`select scrubbed_at from posts where id = ${POST}`;
      expect(row!.scrubbed_at).toBeNull();
    });
  });
});
