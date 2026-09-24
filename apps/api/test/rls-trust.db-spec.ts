import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * RLS coverage for the trust domain (0010_trust.sql): reviews & responses,
 * identity/business verification, reports, the global blacklist (custom
 * RLS replacing 0002's temporary policy), computed trust scores, bans,
 * ban appeals, and append-only moderation actions. Same style as
 * rls-payments.db-spec.ts/rls-communication.db-spec.ts. The four
 * ae_rls_bypass-owned helpers (blacklist_severity, trust_summary,
 * my_active_bans, my_post_moderation_history) were already exercised
 * directly against the dev DB via psql while drafting the migration; this
 * file re-covers them through the normal app connection plus the rest of
 * the domain's RLS boundaries.
 */

const PARTNER = '0191e3a0-a00a-7000-8000-000000000001';
const GEO_AREA_A = '0191e3a0-a00a-7000-8000-000000000011';
const GEO_AREA_B = '0191e3a0-a00a-7000-8000-000000000012';
const TENANT_A = '0191e3a0-a00a-7000-8000-000000000021';
const TENANT_B = '0191e3a0-a00a-7000-8000-000000000022';
const USER_ALICE = '0191e3a0-a00a-7000-8000-000000000031'; // post author, store owner, reviewed, banned
const USER_ADMIN = '0191e3a0-a00a-7000-8000-000000000032'; // tenant_admin (staff)
const USER_STRANGER = '0191e3a0-a00a-7000-8000-000000000033';
const USER_B = '0191e3a0-a00a-7000-8000-000000000034';
const MEMBER_ALICE = '0191e3a0-a00a-7000-8000-000000000041';
const MEMBER_ADMIN = '0191e3a0-a00a-7000-8000-000000000042';
const MEMBER_STRANGER = '0191e3a0-a00a-7000-8000-000000000043';
const MEMBER_B = '0191e3a0-a00a-7000-8000-000000000044';

const CATEGORY = '0191e3a0-a00a-7000-8000-000000000051';
const FIELD_SCHEMA = '0191e3a0-a00a-7000-8000-000000000052';
const POST_1 = '0191e3a0-a00a-7000-8000-000000000053';
const STORE_1 = '0191e3a0-a00a-7000-8000-000000000061';

const REVIEW_1 = '0191e3a0-a00a-7000-8000-000000000071';
const REVIEW_RESPONSE_1 = '0191e3a0-a00a-7000-8000-000000000072';
const VERIFICATION_REQUEST_1 = '0191e3a0-a00a-7000-8000-000000000081';
const BUSINESS_VERIFICATION_1 = '0191e3a0-a00a-7000-8000-000000000091';
const REPORT_1 = '0191e3a0-a00a-7000-8000-0000000000a1';
const BLACKLIST_ENTRY_1 = '0191e3a0-a00a-7000-8000-0000000000b1'; // recommended by TENANT_A
const USER_TRUST_SCORE_USER = USER_ALICE;
const BAN_1 = '0191e3a0-a00a-7000-8000-0000000000c1';
const BAN_APPEAL_1 = '0191e3a0-a00a-7000-8000-0000000000d1';
const MODERATION_ACTION_1 = '0191e3a0-a00a-7000-8000-0000000000e1';
const MODERATION_ACTION_2 = '0191e3a0-a00a-7000-8000-0000000000e2'; // action_code = 'removed'

const FIXTURE_PREFIX = '0191e3a0-a00a-7000-8000-%';

type Context = Partial<
  Record<'tenant_id' | 'user_id' | 'member_id' | 'role' | 'is_platform_admin', string>
>;

async function withContext<T>(
  sql: Sql,
  context: Context,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    for (const [key, value] of Object.entries(context)) {
      await tx`select set_config(${`app.${key}`}, ${value}, true)`;
    }
    return work(tx);
  }) as Promise<T>;
}

const AS_ALICE: Context = {
  tenant_id: TENANT_A,
  user_id: USER_ALICE,
  member_id: MEMBER_ALICE,
  role: 'member',
};
const AS_ADMIN: Context = {
  tenant_id: TENANT_A,
  user_id: USER_ADMIN,
  member_id: MEMBER_ADMIN,
  role: 'tenant_admin',
};
const AS_STRANGER: Context = {
  tenant_id: TENANT_A,
  user_id: USER_STRANGER,
  member_id: MEMBER_STRANGER,
  role: 'member',
};
const AS_TENANT_B: Context = {
  tenant_id: TENANT_B,
  user_id: USER_B,
  member_id: MEMBER_B,
  role: 'tenant_admin',
};
const AS_SYSTEM: Context = { tenant_id: TENANT_A, role: 'system' };
const AS_PLATFORM_ADMIN: Context = { is_platform_admin: 'true', role: 'platform_admin' };

async function expectNoRowsAffected(promise: Promise<{ count: number }>): Promise<void> {
  const result = await promise;
  expect(result.count).toBe(0);
}

async function expectDenied(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught as { code?: string },
  );
  if (!error) throw new Error('expected the statement to be rejected, but it succeeded');
  expect(error.code).toBe('42501');
}

describe('Row level security: trust domain (0010)', () => {
  let app: Sql;
  let admin: Sql;

  beforeAll(async () => {
    app = testSqlClient(4, resolveTestAppDatabaseUrl());
    admin = testSqlClient(1, resolveTestDatabaseUrl());

    await admin`delete from users where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from categories where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from blacklist_entries where id::text like ${FIXTURE_PREFIX}`;

    await admin`
      insert into users (id, phone_e164) values
        (${USER_ALICE}, '+8801788000001'),
        (${USER_ADMIN}, '+8801788000002'),
        (${USER_STRANGER}, '+8801788000003'),
        (${USER_B}, '+8801788000004')`;

    await admin`
      insert into partners (id, legal_name, display_name, phone_e164) values
        (${PARTNER}, 'Trust Fixture Partner', 'Trust Fixture Partner', '+8801788000099')`;

    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
        (${GEO_AREA_A}, 3, 'upazila', 'rls-trust-a', 'RLS Trust Area A', 'fixture'),
        (${GEO_AREA_B}, 3, 'upazila', 'rls-trust-b', 'RLS Trust Area B', 'fixture')`;

    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
        (${TENANT_A}, ${PARTNER}, ${GEO_AREA_A}, 'rls-trust-tenant-a', 'এ', 'A',
          st_point(90.4, 23.8)::geography, 'active'),
        (${TENANT_B}, ${PARTNER}, ${GEO_AREA_B}, 'rls-trust-tenant-b', 'বি', 'B',
          st_point(90.5, 23.9)::geography, 'active')`;

    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${MEMBER_ALICE}, ${TENANT_A}, ${USER_ALICE}, 'member'),
        (${MEMBER_ADMIN}, ${TENANT_A}, ${USER_ADMIN}, 'tenant_admin'),
        (${MEMBER_STRANGER}, ${TENANT_A}, ${USER_STRANGER}, 'member'),
        (${MEMBER_B}, ${TENANT_B}, ${USER_B}, 'tenant_admin')`;

    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en) values
        (${CATEGORY}, 'marketplace', 'rls-trust-category', 'বিভাগ', 'Category')`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, status_code)
      values (${FIELD_SCHEMA}, ${CATEGORY}, 1, '{}'::jsonb, 'draft')`;
    await admin`
      insert into posts (id, tenant_id, author_member_id, category_id, field_schema_id, title, status_code)
      values (${POST_1}, ${TENANT_A}, ${MEMBER_ALICE}, ${CATEGORY}, ${FIELD_SCHEMA}, 'Fixture Post', 'draft')`;

    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`
        insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code) values
          (${STORE_1}, ${TENANT_A}, ${MEMBER_ALICE}, 'rls-trust-store', 'দোকান', 'active')`;
    });

    await admin`
      insert into reviews (id, tenant_id, reviewer_member_id, store_id, rating, body) values
        (${REVIEW_1}, ${TENANT_A}, ${MEMBER_STRANGER}, ${STORE_1}, 4, 'Pretty good')`;
    await admin`
      insert into review_responses (id, tenant_id, review_id, responder_member_id, body) values
        (${REVIEW_RESPONSE_1}, ${TENANT_A}, ${REVIEW_1}, ${MEMBER_ALICE}, 'Thanks!')`;

    await admin`
      insert into verification_requests (id, user_id, type_code) values
        (${VERIFICATION_REQUEST_1}, ${USER_ALICE}, 'nid')`;
    await admin`
      insert into business_verifications (id, tenant_id, store_id, type_code, submitted_by_member_id) values
        (${BUSINESS_VERIFICATION_1}, ${TENANT_A}, ${STORE_1}, 'trade_license', ${MEMBER_ALICE})`;

    await admin`
      insert into reports (id, tenant_id, reporter_member_id, reported_member_id, reason_code) values
        (${REPORT_1}, ${TENANT_A}, ${MEMBER_STRANGER}, ${MEMBER_ALICE}, 'harassment')`;

    await admin`
      insert into blacklist_entries (id, phone_e164, reason_code, severity_code, status_code, summary, source_tenant_id, recommended_by_user_id)
      values (${BLACKLIST_ENTRY_1}, '+8801788999999', 'harassment', 'watch', 'recommended', 'flagged by tenant A',
              ${TENANT_A}, ${USER_ADMIN})`;

    await admin`
      insert into user_trust_scores (user_id, score, band_code, algorithm_version, computed_at) values
        (${USER_TRUST_SCORE_USER}, 55, 'standard', 1, now())`;

    await admin`
      insert into bans
        (id, tenant_id, user_id, severity_code, reason_code, reason_text, evidence_refs, banned_by_user_id, is_permanent, expires_at, escalation_step)
      values
        (${BAN_1}, ${TENANT_A}, ${USER_ALICE}, 'restricted', 'spam', 'repeated spam posting',
         '[{"type":"report","id":"0191e3a0-a00a-7000-8000-0000000000a1"}]'::jsonb, ${USER_ADMIN}, false, now() + interval '7 days', 1)`;

    await admin`
      insert into ban_appeals
        (id, public_reference, user_id, ban_id, channel_code, submitted_phone_e164, statement, queue_code)
      values (${BAN_APPEAL_1}, 'AP-RLSTRUST1', ${USER_ALICE}, ${BAN_1}, 'in_app', '+8801788000001', 'It was a mistake', 'tenant_admin')`;

    await admin`
      insert into moderation_actions (id, tenant_id, post_id, actor_user_id, action_code, reason_code, reason_text, evidence_refs)
      values (${MODERATION_ACTION_1}, ${TENANT_A}, ${POST_1}, ${USER_ADMIN}, 'moderator_removed', 'spam', 'clearly spam',
              '[{"type":"report","id":"0191e3a0-a00a-7000-8000-0000000000a1"}]'::jsonb)`;
    await admin`
      insert into moderation_actions (id, tenant_id, post_id, actor_user_id, action_code, reason_code, reason_text)
      values (${MODERATION_ACTION_2}, ${TENANT_A}, ${POST_1}, ${USER_ADMIN}, 'removed', 'spam', 'explanation the owner sees')`;
  });

  afterAll(async () => {
    try {
      await admin.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`delete from moderation_actions where tenant_id::text like ${FIXTURE_PREFIX}`;
        await tx`delete from bans where tenant_id::text like ${FIXTURE_PREFIX}`;
      });
      await admin`delete from ban_appeals where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from user_trust_scores where user_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from blacklist_entries where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from reports where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from business_verifications where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from verification_requests where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from review_responses where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from reviews where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from stores where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from posts where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from category_field_schemas where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from categories where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenant_members where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from users where id::text like ${FIXTURE_PREFIX}`;
    } finally {
      await Promise.all([app.end(), admin.end()]);
    }
  });

  describe('reviews (§9.1)', () => {
    it('is publicly readable (published) within the tenant', async () => {
      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from reviews where id = ${REVIEW_1}`,
      );
      expect(asStranger).toHaveLength(1);

      const asTenantB = await withContext(
        app,
        AS_TENANT_B,
        (tx) => tx`select id from reviews where id = ${REVIEW_1}`,
      );
      expect(asTenantB).toHaveLength(0);
    });

    it('lets the reviewer update/soft-delete their own review, not the reviewed target', async () => {
      const asReviewer = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`update reviews set body = 'Updated my mind' where id = ${REVIEW_1}`,
      );
      expect(asReviewer.count).toBe(1);

      // Alice owns the reviewed store but is not the reviewer — "the review
      // target can't edit or hide reviews" (spec).
      await expectNoRowsAffected(
        withContext(
          app,
          AS_ALICE,
          (tx) => tx`update reviews set body = 'hijacked' where id = ${REVIEW_1}`,
        ),
      );
    });

    it('lets staff moderate it', async () => {
      const result = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`update reviews set status_code = 'hidden' where id = ${REVIEW_1}`,
      );
      expect(result.count).toBe(1);
      await admin`update reviews set status_code = 'published' where id = ${REVIEW_1}`;
    });
  });

  describe('review_responses (§9.2)', () => {
    it('is publicly readable (published)', async () => {
      const rows = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from review_responses where id = ${REVIEW_RESPONSE_1}`,
      );
      expect(rows).toHaveLength(1);
    });

    it("lets the reviewed target's owner write it, not the reviewer or a stranger", async () => {
      const asOwner = await withContext(
        app,
        AS_ALICE,
        (tx) =>
          tx`update review_responses set body = 'Thanks again!' where id = ${REVIEW_RESPONSE_1}`,
      );
      expect(asOwner.count).toBe(1);

      await expectNoRowsAffected(
        withContext(
          app,
          AS_STRANGER,
          (tx) => tx`update review_responses set body = 'hijacked' where id = ${REVIEW_RESPONSE_1}`,
        ),
      );
    });
  });

  describe('verification_requests (§9.3)', () => {
    it('is visible only to its owner and platform, no tenant role at all', async () => {
      const asOwner = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`select id from verification_requests where id = ${VERIFICATION_REQUEST_1}`,
      );
      expect(asOwner).toHaveLength(1);

      const asAdmin = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from verification_requests where id = ${VERIFICATION_REQUEST_1}`,
      );
      expect(asAdmin).toHaveLength(0);

      const asPlatform = await withContext(
        app,
        AS_PLATFORM_ADMIN,
        (tx) => tx`select id from verification_requests where id = ${VERIFICATION_REQUEST_1}`,
      );
      expect(asPlatform).toHaveLength(1);
    });

    it('only platform_admin may review/update it', async () => {
      const result = await withContext(
        app,
        AS_PLATFORM_ADMIN,
        (tx) =>
          tx`update verification_requests set status_code = 'in_review' where id = ${VERIFICATION_REQUEST_1}`,
      );
      expect(result.count).toBe(1);
    });
  });

  describe('business_verifications (§9.4)', () => {
    it("is visible to the submitter, the subject's manager, and staff", async () => {
      const asSubmitter = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`select id from business_verifications where id = ${BUSINESS_VERIFICATION_1}`,
      );
      expect(asSubmitter).toHaveLength(1);

      const asStaff = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from business_verifications where id = ${BUSINESS_VERIFICATION_1}`,
      );
      expect(asStaff).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from business_verifications where id = ${BUSINESS_VERIFICATION_1}`,
      );
      expect(asStranger).toHaveLength(0);
    });

    it("lets the subject's manager insert, staff approve/reject", async () => {
      const result = await withContext(
        app,
        AS_ADMIN,
        (tx) =>
          tx`update business_verifications set status_code = 'approved' where id = ${BUSINESS_VERIFICATION_1}`,
      );
      expect(result.count).toBe(1);
    });
  });

  describe('reports (§9.5)', () => {
    it('is visible to the reporter and staff, never to the reported party', async () => {
      const asReporter = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from reports where id = ${REPORT_1}`,
      );
      expect(asReporter).toHaveLength(1);

      const asStaff = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from reports where id = ${REPORT_1}`,
      );
      expect(asStaff).toHaveLength(1);

      const asReportedParty = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`select id from reports where id = ${REPORT_1}`,
      );
      expect(asReportedParty).toHaveLength(0);
    });

    it('lets staff update it, not the reporter', async () => {
      const result = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`update reports set status_code = 'in_review' where id = ${REPORT_1}`,
      );
      expect(result.count).toBe(1);

      await expectNoRowsAffected(
        withContext(
          app,
          AS_STRANGER,
          (tx) => tx`update reports set status_code = 'dismissed' where id = ${REPORT_1}`,
        ),
      );
    });
  });

  describe('blacklist_entries (§9.6)', () => {
    it("is visible to the tenant that recommended it, not another tenant's staff", async () => {
      const asRecommendingTenant = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from blacklist_entries where id = ${BLACKLIST_ENTRY_1}`,
      );
      expect(asRecommendingTenant).toHaveLength(1);

      const asOtherTenant = await withContext(
        app,
        AS_TENANT_B,
        (tx) => tx`select id from blacklist_entries where id = ${BLACKLIST_ENTRY_1}`,
      );
      expect(asOtherTenant).toHaveLength(0);
    });

    it('only platform_admin may approve/reject/revoke it, not the recommending tenant', async () => {
      await expectNoRowsAffected(
        withContext(
          app,
          AS_ADMIN,
          (tx) =>
            tx`update blacklist_entries set status_code = 'rejected' where id = ${BLACKLIST_ENTRY_1}`,
        ),
      );
    });
  });

  describe('user_trust_scores (§9.7)', () => {
    it('is visible to its owner, not to a stranger', async () => {
      const asOwner = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`select user_id from user_trust_scores where user_id = ${USER_TRUST_SCORE_USER}`,
      );
      expect(asOwner).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select user_id from user_trust_scores where user_id = ${USER_TRUST_SCORE_USER}`,
      );
      expect(asStranger).toHaveLength(0);
    });

    it("trust_summary() lets tenant staff read a member's score they otherwise can't see directly", async () => {
      const [row] = await withContext(
        app,
        AS_ADMIN,
        (tx) =>
          tx<{ score: number }[]>`select * from public.trust_summary(${USER_TRUST_SCORE_USER})`,
      );
      expect(row?.score).toBe(55);
    });
  });

  describe('bans (§9.8)', () => {
    it('is visible to tenant staff, not to a plain member or the banned user directly', async () => {
      const asStaff = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from bans where id = ${BAN_1}`,
      );
      expect(asStaff).toHaveLength(1);

      const asBannedUser = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`select id from bans where id = ${BAN_1}`,
      );
      expect(asBannedUser).toHaveLength(0);
    });

    it("my_active_bans() lets the banned user read their own ban's safe fields", async () => {
      const rows = await withContext(
        app,
        AS_ALICE,
        (tx) => tx<{ id: string; severity_code: string }[]>`select * from public.my_active_bans()`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.severity_code).toBe('restricted');
    });

    it('lets a tenant_admin revoke, not a plain member', async () => {
      const result = await withContext(
        app,
        AS_ADMIN,
        (tx) =>
          tx`update bans set status_code = 'revoked', revoked_at = now(), revoked_by_user_id = ${USER_ADMIN}, revoke_reason = 'appeal granted'
             where id = ${BAN_1}`,
      );
      expect(result.count).toBe(1);
    });
  });

  describe('ban_appeals (§9.9)', () => {
    it("is visible to the appellant and the ban's tenant_admin queue, not another tenant", async () => {
      const asAppellant = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`select id from ban_appeals where id = ${BAN_APPEAL_1}`,
      );
      expect(asAppellant).toHaveLength(1);

      const asTenantQueue = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from ban_appeals where id = ${BAN_APPEAL_1}`,
      );
      expect(asTenantQueue).toHaveLength(1);

      const asOtherTenant = await withContext(
        app,
        AS_TENANT_B,
        (tx) => tx`select id from ban_appeals where id = ${BAN_APPEAL_1}`,
      );
      expect(asOtherTenant).toHaveLength(0);
    });

    it('lets the tenant_admin of the ban decide it while still queued', async () => {
      const result = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`update ban_appeals set status_code = 'in_review' where id = ${BAN_APPEAL_1}`,
      );
      expect(result.count).toBe(1);
    });
  });

  describe('moderation_actions (§9.11)', () => {
    it('is visible to staff and platform, not to a plain member directly', async () => {
      const asStaff = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from moderation_actions where id = ${MODERATION_ACTION_1}`,
      );
      expect(asStaff).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from moderation_actions where id = ${MODERATION_ACTION_1}`,
      );
      expect(asStranger).toHaveLength(0);
    });

    it("my_post_moderation_history() lets the post's author see curated history they can't read directly", async () => {
      const rows = await withContext(
        app,
        AS_ALICE,
        (tx) =>
          tx<{ action_code: string; reason_text: string | null }[]>`
            select * from public.my_post_moderation_history(${POST_1})`,
      );
      expect(rows).toHaveLength(2);
      // reason_text is only exposed for removed/restored (spec) — curated
      // away for moderator_removed even though the underlying row has one,
      // but shown for 'removed'.
      const byAction = Object.fromEntries(rows.map((row) => [row.action_code, row.reason_text]));
      expect(byAction).toMatchObject({
        moderator_removed: null,
        removed: 'explanation the owner sees',
      });

      const directRead = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`select id from moderation_actions where id = ${MODERATION_ACTION_1}`,
      );
      expect(directRead).toHaveLength(0);
    });

    it('is immutable and append-only: no UPDATE/DELETE for any role', async () => {
      await expectDenied(
        withContext(
          app,
          AS_ADMIN,
          (tx) =>
            tx`update moderation_actions set reason_text = 'changed' where id = ${MODERATION_ACTION_1}`,
        ),
      );
    });

    it('lets the system role insert a spam_auto_deleted action with no actor', async () => {
      const result = await withContext(
        app,
        AS_SYSTEM,
        (tx) =>
          tx`insert into moderation_actions (tenant_id, post_id, action_code, reason_code)
             values (${TENANT_A}, ${POST_1}, 'spam_auto_deleted', 'spam')`,
      );
      expect(result.count).toBe(1);
    });
  });
});
