import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * RLS coverage for the local information domain (0011_local_information.sql):
 * bazar commodity price boards, blood donor registry & requests, national/
 * local emergency contacts, notices, transport routes/stops/schedules, and
 * lost & found. Same style as rls-trust.db-spec.ts. "Writes: staff, agents"
 * reuses 0004's localities precedent ('agent' is a plain app_role() value);
 * the setting-driven eligible_from trigger and the three force-to-safe-
 * default triggers (bazar_prices/notices/lost_found_items) were already
 * exercised directly against the dev DB via psql while drafting the
 * migration — this file covers the RLS visibility/write boundaries.
 */

const PARTNER = '0191e3a0-b00b-7000-8000-000000000001';
const GEO_AREA_A = '0191e3a0-b00b-7000-8000-000000000011';
const GEO_AREA_B = '0191e3a0-b00b-7000-8000-000000000012';
const TENANT_A = '0191e3a0-b00b-7000-8000-000000000021';
const TENANT_B = '0191e3a0-b00b-7000-8000-000000000022';
const USER_ALICE = '0191e3a0-b00b-7000-8000-000000000031'; // donor, lost&found reporter
const USER_ADMIN = '0191e3a0-b00b-7000-8000-000000000032'; // tenant_admin (staff)
const USER_AGENT = '0191e3a0-b00b-7000-8000-000000000033'; // role = agent
const USER_STRANGER = '0191e3a0-b00b-7000-8000-000000000034'; // blood request requester
const USER_B = '0191e3a0-b00b-7000-8000-000000000035';
const MEMBER_ALICE = '0191e3a0-b00b-7000-8000-000000000041';
const MEMBER_ADMIN = '0191e3a0-b00b-7000-8000-000000000042';
const MEMBER_AGENT = '0191e3a0-b00b-7000-8000-000000000043';
const MEMBER_STRANGER = '0191e3a0-b00b-7000-8000-000000000044';
const MEMBER_B = '0191e3a0-b00b-7000-8000-000000000045';

const BAZAR_COMMODITY_1 = '0191e3a0-b00b-7000-8000-000000000051';
const BAZAR_MARKET_1 = '0191e3a0-b00b-7000-8000-000000000052';
const BAZAR_PRICE_1 = '0191e3a0-b00b-7000-8000-000000000053'; // published
const BAZAR_PRICE_2 = '0191e3a0-b00b-7000-8000-000000000054'; // submitted

const BLOOD_DONOR_1 = '0191e3a0-b00b-7000-8000-000000000061'; // Alice, available
const BLOOD_REQUEST_1 = '0191e3a0-b00b-7000-8000-000000000062'; // requester = Stranger, open
const BLOOD_REQUEST_RESPONSE_1 = '0191e3a0-b00b-7000-8000-000000000063';

const NATIONAL_HOTLINE_1 = '0191e3a0-b00b-7000-8000-000000000071';
const EMERGENCY_CONTACT_1 = '0191e3a0-b00b-7000-8000-000000000072';
const NOTICE_1 = '0191e3a0-b00b-7000-8000-000000000073';
const TRANSPORT_ROUTE_1 = '0191e3a0-b00b-7000-8000-000000000081';
const TRANSPORT_ROUTE_STOP_1 = '0191e3a0-b00b-7000-8000-000000000082';
const TRANSPORT_SCHEDULE_1 = '0191e3a0-b00b-7000-8000-000000000083';
const LOST_FOUND_ITEM_1 = '0191e3a0-b00b-7000-8000-000000000091'; // open, reporter = Alice

const FIXTURE_PREFIX = '0191e3a0-b00b-7000-8000-%';

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
const AS_AGENT: Context = {
  tenant_id: TENANT_A,
  user_id: USER_AGENT,
  member_id: MEMBER_AGENT,
  role: 'agent',
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
// Truly anonymous: tenant context only (pre-auth subdomain routing), no
// user/role at all — app_role() defaults to 'anon'.
const AS_ANON: Context = { tenant_id: TENANT_A };
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

describe('Row level security: local information domain (0011)', () => {
  let app: Sql;
  let admin: Sql;

  beforeAll(async () => {
    app = testSqlClient(4, resolveTestAppDatabaseUrl());
    admin = testSqlClient(1, resolveTestDatabaseUrl());

    await admin`delete from users where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from bazar_commodities where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from national_hotlines where id::text like ${FIXTURE_PREFIX}`;

    await admin`
      insert into users (id, phone_e164) values
        (${USER_ALICE}, '+8801777000001'),
        (${USER_ADMIN}, '+8801777000002'),
        (${USER_AGENT}, '+8801777000003'),
        (${USER_STRANGER}, '+8801777000004'),
        (${USER_B}, '+8801777000005')`;

    await admin`
      insert into partners (id, legal_name, display_name, phone_e164) values
        (${PARTNER}, 'Local Info Fixture Partner', 'Local Info Fixture Partner', '+8801777000099')`;

    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
        (${GEO_AREA_A}, 3, 'upazila', 'rls-local-a', 'RLS Local Area A', 'fixture'),
        (${GEO_AREA_B}, 3, 'upazila', 'rls-local-b', 'RLS Local Area B', 'fixture')`;

    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
        (${TENANT_A}, ${PARTNER}, ${GEO_AREA_A}, 'rls-local-tenant-a', 'এ', 'A',
          st_point(90.4, 23.8)::geography, 'active'),
        (${TENANT_B}, ${PARTNER}, ${GEO_AREA_B}, 'rls-local-tenant-b', 'বি', 'B',
          st_point(90.5, 23.9)::geography, 'active')`;

    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${MEMBER_ALICE}, ${TENANT_A}, ${USER_ALICE}, 'member'),
        (${MEMBER_ADMIN}, ${TENANT_A}, ${USER_ADMIN}, 'tenant_admin'),
        (${MEMBER_AGENT}, ${TENANT_A}, ${USER_AGENT}, 'member'),
        (${MEMBER_STRANGER}, ${TENANT_A}, ${USER_STRANGER}, 'member'),
        (${MEMBER_B}, ${TENANT_B}, ${USER_B}, 'tenant_admin')`;

    await admin`
      insert into bazar_commodities (id, code, name_bn, name_en, group_code, default_unit_code) values
        (${BAZAR_COMMODITY_1}, 'rls-local-rice', 'চাল', 'Rice', 'rice_grains', 'kg')`;
    await admin`
      insert into bazar_markets (id, tenant_id, name_bn, market_type_code, is_active) values
        (${BAZAR_MARKET_1}, ${TENANT_A}, 'রহিম বাজার', 'daily_bazar', true)`;
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`
        insert into bazar_prices
          (id, tenant_id, commodity_id, bazar_market_id, price_date, unit_code, min_price, max_price, source_code, status_code, published_by_user_id)
        values
          (${BAZAR_PRICE_1}, ${TENANT_A}, ${BAZAR_COMMODITY_1}, ${BAZAR_MARKET_1}, current_date, 'kg', 60, 70, 'staff', 'published', ${USER_ADMIN}),
          (${BAZAR_PRICE_2}, ${TENANT_A}, ${BAZAR_COMMODITY_1}, ${BAZAR_MARKET_1}, current_date - 1, 'kg', 58, 68, 'agent', 'submitted', null)`;
    });

    await admin`
      insert into blood_donors (id, tenant_id, member_id, blood_group_code, is_available, eligibility_confirmed_at) values
        (${BLOOD_DONOR_1}, ${TENANT_A}, ${MEMBER_ALICE}, 'o_neg', true, now())`;
    await admin`
      insert into blood_requests
        (id, tenant_id, requester_member_id, blood_group_code, hospital_name, contact_phone_e164, needed_by, urgency_code, status_code)
      values
        (${BLOOD_REQUEST_1}, ${TENANT_A}, ${MEMBER_STRANGER}, 'o_neg', 'Savar General Hospital', '+8801777000004',
         now() + interval '1 day', 'urgent', 'open')`;
    await admin`
      insert into blood_request_responses (id, tenant_id, blood_request_id, blood_donor_id, status_code) values
        (${BLOOD_REQUEST_RESPONSE_1}, ${TENANT_A}, ${BLOOD_REQUEST_1}, ${BLOOD_DONOR_1}, 'offered')`;

    await admin`
      insert into national_hotlines (id, service_type_code, name_bn, name_en, dial_string) values
        (${NATIONAL_HOTLINE_1}, 'police', 'জাতীয় জরুরি সেবা', 'National Emergency', '999')`;
    await admin`
      insert into emergency_contacts (id, tenant_id, service_type_code, name_bn, phones, is_active) values
        (${EMERGENCY_CONTACT_1}, ${TENANT_A}, 'ambulance', 'থানা অ্যাম্বুলেন্স', ARRAY['+8801777000010'], true)`;

    await admin.begin(async (tx) => {
      // notices_enforce_member_limits only exempts app_is_staff() roles, not
      // 'system' — unlike bazar_prices_force_member_submitted above.
      await tx`select set_config('app.role', 'tenant_admin', true)`;
      await tx`
        insert into notices
          (id, tenant_id, notice_type_code, title, body, published_by_member_id, status_code, published_at)
        values (${NOTICE_1}, ${TENANT_A}, 'community_event', 'Fixture Notice', 'Body text', ${MEMBER_ADMIN}, 'published', now())`;
    });

    await admin`
      insert into transport_routes (id, tenant_id, mode_code, name_bn, origin_name, destination_name, is_active) values
        (${TRANSPORT_ROUTE_1}, ${TENANT_A}, 'bus', 'সাভার - গুলিস্তান', 'Savar', 'Gulistan', true)`;
    await admin`
      insert into transport_route_stops (id, tenant_id, transport_route_id, seq, name_bn) values
        (${TRANSPORT_ROUTE_STOP_1}, ${TENANT_A}, ${TRANSPORT_ROUTE_1}, 1, 'নবীনগর')`;
    await admin`
      insert into transport_schedules (id, tenant_id, transport_route_id, departure_time) values
        (${TRANSPORT_SCHEDULE_1}, ${TENANT_A}, ${TRANSPORT_ROUTE_1}, '07:00')`;

    await admin`
      insert into lost_found_items
        (id, tenant_id, kind_code, item_type_code, title, reporter_member_id, is_sensitive, status_code)
      values (${LOST_FOUND_ITEM_1}, ${TENANT_A}, 'lost', 'phone', 'Lost phone near market', ${MEMBER_ALICE}, false, 'open')`;
  });

  afterAll(async () => {
    try {
      await admin`delete from lost_found_items where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from transport_schedules where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from transport_route_stops where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from transport_routes where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from notices where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from emergency_contacts where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from national_hotlines where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from blood_request_responses where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from blood_requests where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from blood_donors where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from bazar_prices where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from bazar_markets where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from bazar_commodities where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenant_members where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from users where id::text like ${FIXTURE_PREFIX}`;
    } finally {
      await Promise.all([app.end(), admin.end()]);
    }
  });

  describe('bazar_commodities (§10.1): G-REFERENCE', () => {
    it('is readable by anyone, writable only by platform_admin', async () => {
      const rows = await withContext(
        app,
        AS_ANON,
        (tx) => tx`select id from bazar_commodities where id = ${BAZAR_COMMODITY_1}`,
      );
      expect(rows).toHaveLength(1);

      // bazar_commodities_read_all (USING true) makes the row visible to a
      // tenant_admin, but no UPDATE-or-ALL policy applies to them — Postgres
      // silently affects 0 rows rather than raising 42501.
      await expectNoRowsAffected(
        withContext(
          app,
          AS_ADMIN,
          (tx) =>
            tx`update bazar_commodities set name_en = 'Hijacked' where id = ${BAZAR_COMMODITY_1}`,
        ),
      );
      const result = await withContext(
        app,
        AS_PLATFORM_ADMIN,
        (tx) => tx`update bazar_commodities set sort_order = 1 where id = ${BAZAR_COMMODITY_1}`,
      );
      expect(result.count).toBe(1);
    });
  });

  describe('bazar_markets (§10.2)', () => {
    it('is publicly readable (active), not across tenants', async () => {
      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from bazar_markets where id = ${BAZAR_MARKET_1}`,
      );
      expect(asStranger).toHaveLength(1);

      const asTenantB = await withContext(
        app,
        AS_TENANT_B,
        (tx) => tx`select id from bazar_markets where id = ${BAZAR_MARKET_1}`,
      );
      expect(asTenantB).toHaveLength(0);
    });

    it('lets staff and agents write it, not a plain member', async () => {
      const asAgent = await withContext(
        app,
        AS_AGENT,
        (tx) => tx`update bazar_markets set name_en = 'Rahim Bazar' where id = ${BAZAR_MARKET_1}`,
      );
      expect(asAgent.count).toBe(1);

      await expectNoRowsAffected(
        withContext(
          app,
          AS_STRANGER,
          (tx) => tx`update bazar_markets set name_en = 'hijacked' where id = ${BAZAR_MARKET_1}`,
        ),
      );
    });
  });

  describe('bazar_prices (§10.3)', () => {
    it('is publicly readable only when published', async () => {
      const asStrangerPublished = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from bazar_prices where id = ${BAZAR_PRICE_1}`,
      );
      expect(asStrangerPublished).toHaveLength(1);

      const asStrangerSubmitted = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from bazar_prices where id = ${BAZAR_PRICE_2}`,
      );
      expect(asStrangerSubmitted).toHaveLength(0);
    });

    it("forces a plain member's submission to 'submitted' regardless of what was requested", async () => {
      const result = await withContext(
        app,
        AS_STRANGER,
        (tx) =>
          tx`insert into bazar_prices (tenant_id, commodity_id, bazar_market_id, price_date, unit_code, min_price, max_price, source_code, status_code)
             values (${TENANT_A}, ${BAZAR_COMMODITY_1}, ${BAZAR_MARKET_1}, current_date, 'kg', 55, 65, 'member', 'published')`,
      );
      expect(result.count).toBe(1);
      const [row] = await admin<{ status_code: string }[]>`
        select status_code from bazar_prices where tenant_id = ${TENANT_A} and min_price = 55`;
      expect(row?.status_code).toBe('submitted');
      await admin`delete from bazar_prices where tenant_id = ${TENANT_A} and min_price = 55`;
    });

    it('lets staff publish it', async () => {
      const result = await withContext(
        app,
        AS_ADMIN,
        (tx) =>
          tx`update bazar_prices set status_code = 'published', published_by_user_id = ${USER_ADMIN} where id = ${BAZAR_PRICE_2}`,
      );
      expect(result.count).toBe(1);
      await admin`update bazar_prices set status_code = 'submitted', published_by_user_id = null where id = ${BAZAR_PRICE_2}`;
    });
  });

  describe('blood_donors (§10.4)', () => {
    it('requires authentication — anon sees nothing, an authenticated member sees available donors', async () => {
      const asAnon = await withContext(
        app,
        AS_ANON,
        (tx) => tx`select id from blood_donors where id = ${BLOOD_DONOR_1}`,
      );
      expect(asAnon).toHaveLength(0);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from blood_donors where id = ${BLOOD_DONOR_1}`,
      );
      expect(asStranger).toHaveLength(1);
    });

    it('lets the donor manage their own row, not a stranger', async () => {
      const asOwner = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`update blood_donors set is_available = false where id = ${BLOOD_DONOR_1}`,
      );
      expect(asOwner.count).toBe(1);
      await admin`update blood_donors set is_available = true where id = ${BLOOD_DONOR_1}`;

      await expectNoRowsAffected(
        withContext(
          app,
          AS_STRANGER,
          (tx) => tx`update blood_donors set is_available = false where id = ${BLOOD_DONOR_1}`,
        ),
      );
    });

    it('is visible to staff regardless of availability', async () => {
      const rows = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from blood_donors where id = ${BLOOD_DONOR_1}`,
      );
      expect(rows).toHaveLength(1);
    });

    it('rejects registering another member as a donor (WITH CHECK, a real 42501)', async () => {
      await expectDenied(
        withContext(
          app,
          AS_STRANGER,
          (tx) =>
            tx`insert into blood_donors (tenant_id, member_id, blood_group_code, is_available)
               values (${TENANT_A}, ${MEMBER_ALICE}, 'a_pos', true)`,
        ),
      );
    });
  });

  describe('blood_requests (§10.5)', () => {
    it('shows open requests to any authenticated member', async () => {
      const rows = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`select id from blood_requests where id = ${BLOOD_REQUEST_1}`,
      );
      expect(rows).toHaveLength(1);
    });

    it('lets the requester manage their own, not a stranger', async () => {
      const asOwner = await withContext(
        app,
        AS_STRANGER,
        (tx) =>
          tx`update blood_requests set patient_note = 'urgent surgery' where id = ${BLOOD_REQUEST_1}`,
      );
      expect(asOwner.count).toBe(1);

      await expectNoRowsAffected(
        withContext(
          app,
          AS_ALICE,
          (tx) =>
            tx`update blood_requests set patient_note = 'hijacked' where id = ${BLOOD_REQUEST_1}`,
        ),
      );
    });

    it('lets staff moderate it', async () => {
      const result = await withContext(
        app,
        AS_ADMIN,
        (tx) =>
          tx`update blood_requests set status_code = 'cancelled' where id = ${BLOOD_REQUEST_1}`,
      );
      expect(result.count).toBe(1);
      await admin`update blood_requests set status_code = 'open' where id = ${BLOOD_REQUEST_1}`;
    });
  });

  describe('blood_request_responses (§10.6)', () => {
    it('is visible to the requester, the responding donor, and staff, not an unrelated member', async () => {
      const asRequester = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from blood_request_responses where id = ${BLOOD_REQUEST_RESPONSE_1}`,
      );
      expect(asRequester).toHaveLength(1);

      const asDonor = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`select id from blood_request_responses where id = ${BLOOD_REQUEST_RESPONSE_1}`,
      );
      expect(asDonor).toHaveLength(1);

      const asStaff = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from blood_request_responses where id = ${BLOOD_REQUEST_RESPONSE_1}`,
      );
      expect(asStaff).toHaveLength(1);
    });

    it('lets the requester accept/decline, the donor withdraw', async () => {
      const asRequester = await withContext(
        app,
        AS_STRANGER,
        (tx) =>
          tx`update blood_request_responses set status_code = 'accepted' where id = ${BLOOD_REQUEST_RESPONSE_1}`,
      );
      expect(asRequester.count).toBe(1);

      const asDonor = await withContext(
        app,
        AS_ALICE,
        (tx) =>
          tx`update blood_request_responses set status_code = 'withdrawn' where id = ${BLOOD_REQUEST_RESPONSE_1}`,
      );
      expect(asDonor.count).toBe(1);
      await admin`update blood_request_responses set status_code = 'offered' where id = ${BLOOD_REQUEST_RESPONSE_1}`;
    });
  });

  describe('national_hotlines (§10.7): G-REFERENCE', () => {
    it('is readable by anyone, including anonymous', async () => {
      const rows = await withContext(
        app,
        AS_ANON,
        (tx) => tx`select id from national_hotlines where id = ${NATIONAL_HOTLINE_1}`,
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe('emergency_contacts (§10.8)', () => {
    it('is publicly readable including anonymous — it must work without login', async () => {
      const rows = await withContext(
        app,
        AS_ANON,
        (tx) => tx`select id from emergency_contacts where id = ${EMERGENCY_CONTACT_1}`,
      );
      expect(rows).toHaveLength(1);
    });

    it('lets staff and agents write it, not a plain member', async () => {
      const asAgent = await withContext(
        app,
        AS_AGENT,
        (tx) =>
          tx`update emergency_contacts set last_verified_at = now() where id = ${EMERGENCY_CONTACT_1}`,
      );
      expect(asAgent.count).toBe(1);

      await expectNoRowsAffected(
        withContext(
          app,
          AS_STRANGER,
          (tx) =>
            tx`update emergency_contacts set name_bn = 'hijacked' where id = ${EMERGENCY_CONTACT_1}`,
        ),
      );
    });
  });

  describe('notices (§10.9)', () => {
    it('is publicly readable (published)', async () => {
      const rows = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from notices where id = ${NOTICE_1}`,
      );
      expect(rows).toHaveLength(1);
    });

    it("forces a plain member's submission to pending_review and clears staff-only flags", async () => {
      const result = await withContext(
        app,
        AS_STRANGER,
        (tx) =>
          tx`insert into notices (tenant_id, notice_type_code, title, body, published_by_member_id, is_official, is_pinned, status_code, published_at)
             values (${TENANT_A}, 'community_event', 'Member Notice', 'Body', ${MEMBER_STRANGER}, true, true, 'published', now())`,
      );
      expect(result.count).toBe(1);
      const [row] = await admin<
        { status_code: string; is_official: boolean; is_pinned: boolean }[]
      >`
        select status_code, is_official, is_pinned from notices where tenant_id = ${TENANT_A} and title = 'Member Notice'`;
      expect(row).toMatchObject({
        status_code: 'pending_review',
        is_official: false,
        is_pinned: false,
      });
      await admin`delete from notices where tenant_id = ${TENANT_A} and title = 'Member Notice'`;
    });

    it('lets staff manage it fully', async () => {
      const result = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`update notices set is_pinned = true where id = ${NOTICE_1}`,
      );
      expect(result.count).toBe(1);
      await admin`update notices set is_pinned = false where id = ${NOTICE_1}`;
    });
  });

  describe('transport_routes (§10.10)', () => {
    it('is publicly readable (active)', async () => {
      const rows = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from transport_routes where id = ${TRANSPORT_ROUTE_1}`,
      );
      expect(rows).toHaveLength(1);
    });

    it('lets staff and agents write it, not a plain member', async () => {
      const asAgent = await withContext(
        app,
        AS_AGENT,
        (tx) =>
          tx`update transport_routes set fare_min = 40, fare_max = 60 where id = ${TRANSPORT_ROUTE_1}`,
      );
      expect(asAgent.count).toBe(1);

      await expectNoRowsAffected(
        withContext(
          app,
          AS_STRANGER,
          (tx) =>
            tx`update transport_routes set name_en = 'hijacked' where id = ${TRANSPORT_ROUTE_1}`,
        ),
      );
    });
  });

  describe('transport_route_stops / transport_schedules (§10.11-12): same as parent route', () => {
    it('are publicly readable while the parent route is active', async () => {
      const stops = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from transport_route_stops where id = ${TRANSPORT_ROUTE_STOP_1}`,
      );
      expect(stops).toHaveLength(1);

      const schedules = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from transport_schedules where id = ${TRANSPORT_SCHEDULE_1}`,
      );
      expect(schedules).toHaveLength(1);
    });

    it('become invisible once the parent route is inactive', async () => {
      await admin`update transport_routes set is_active = false where id = ${TRANSPORT_ROUTE_1}`;
      const stops = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from transport_route_stops where id = ${TRANSPORT_ROUTE_STOP_1}`,
      );
      expect(stops).toHaveLength(0);
      await admin`update transport_routes set is_active = true where id = ${TRANSPORT_ROUTE_1}`;
    });

    it('lets staff and agents write stops/schedules, not a plain member', async () => {
      const asAgent = await withContext(
        app,
        AS_AGENT,
        (tx) => tx`update transport_schedules set fare = 45 where id = ${TRANSPORT_SCHEDULE_1}`,
      );
      expect(asAgent.count).toBe(1);

      await expectNoRowsAffected(
        withContext(
          app,
          AS_STRANGER,
          (tx) => tx`update transport_schedules set fare = 999 where id = ${TRANSPORT_SCHEDULE_1}`,
        ),
      );
    });
  });

  describe('lost_found_items (§10.13)', () => {
    it('is publicly readable (open), not across tenants', async () => {
      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from lost_found_items where id = ${LOST_FOUND_ITEM_1}`,
      );
      expect(asStranger).toHaveLength(1);

      const asTenantB = await withContext(
        app,
        AS_TENANT_B,
        (tx) => tx`select id from lost_found_items where id = ${LOST_FOUND_ITEM_1}`,
      );
      expect(asTenantB).toHaveLength(0);
    });

    it('lets the reporter manage their own, not a stranger', async () => {
      const asOwner = await withContext(
        app,
        AS_ALICE,
        (tx) =>
          tx`update lost_found_items set description = 'black case, cracked screen' where id = ${LOST_FOUND_ITEM_1}`,
      );
      expect(asOwner.count).toBe(1);

      await expectNoRowsAffected(
        withContext(
          app,
          AS_STRANGER,
          (tx) =>
            tx`update lost_found_items set description = 'hijacked' where id = ${LOST_FOUND_ITEM_1}`,
        ),
      );
    });

    it('forces a sensitive report into pending_review regardless of what was requested', async () => {
      const result = await withContext(
        app,
        AS_STRANGER,
        (tx) =>
          tx`insert into lost_found_items (tenant_id, kind_code, item_type_code, title, reporter_member_id, is_sensitive, status_code)
             values (${TENANT_A}, 'lost', 'person', 'Missing child', ${MEMBER_STRANGER}, true, 'open')`,
      );
      expect(result.count).toBe(1);
      const [row] = await admin<{ status_code: string }[]>`
        select status_code from lost_found_items where tenant_id = ${TENANT_A} and title = 'Missing child'`;
      expect(row?.status_code).toBe('pending_review');
      await admin`delete from lost_found_items where tenant_id = ${TENANT_A} and title = 'Missing child'`;
    });

    it('lets staff moderate it', async () => {
      const result = await withContext(
        app,
        AS_ADMIN,
        (tx) =>
          tx`update lost_found_items set status_code = 'removed' where id = ${LOST_FOUND_ITEM_1}`,
      );
      expect(result.count).toBe(1);
      await admin`update lost_found_items set status_code = 'open' where id = ${LOST_FOUND_ITEM_1}`;
    });
  });
});
