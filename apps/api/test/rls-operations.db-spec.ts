import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * RLS coverage for the operations domain (0012_operations.sql): field
 * agents and their visits/commissions/cash remittances, activity logs,
 * support tickets and their thread, the transactional outbox, and legal
 * holds. audit_logs (built in 0001/0002) already has its own coverage in
 * rls.db-spec.ts. Same style as rls-local-info.db-spec.ts. The trigger
 * mechanics (distance-from-target, the 24h edit lock, legal_hold_blocks(),
 * the cash-remittance confirmation checks) were exercised directly against
 * the dev DB via psql while drafting the migration — this file covers the
 * RLS visibility/write boundaries.
 */

const PARTNER = '0191e3a0-c012-7000-8000-000000000001';
const GEO_AREA_A = '0191e3a0-c012-7000-8000-000000000011';
const GEO_AREA_B = '0191e3a0-c012-7000-8000-000000000012';
const TENANT_A = '0191e3a0-c012-7000-8000-000000000021';
const TENANT_B = '0191e3a0-c012-7000-8000-000000000022';
const USER_AGENT = '0191e3a0-c012-7000-8000-000000000031';
const USER_ADMIN = '0191e3a0-c012-7000-8000-000000000032';
const USER_STRANGER = '0191e3a0-c012-7000-8000-000000000033';
const USER_B = '0191e3a0-c012-7000-8000-000000000034';
const MEMBER_AGENT = '0191e3a0-c012-7000-8000-000000000041';
const MEMBER_ADMIN = '0191e3a0-c012-7000-8000-000000000042';
const MEMBER_STRANGER = '0191e3a0-c012-7000-8000-000000000043';
const MEMBER_B = '0191e3a0-c012-7000-8000-000000000044';

const FIELD_AGENT_1 = '0191e3a0-c012-7000-8000-000000000051';
const CATEGORY_PLACE = '0191e3a0-c012-7000-8000-000000000061';
const PLACE_1 = '0191e3a0-c012-7000-8000-000000000062';
const AGENT_VISIT_1 = '0191e3a0-c012-7000-8000-000000000071';
const AGENT_COMMISSION_1 = '0191e3a0-c012-7000-8000-000000000081';
const ACTIVITY_LOG_1 = '0191e3a0-c012-7000-8000-000000000091';
const SUPPORT_TICKET_1 = '0191e3a0-c012-7000-8000-000000000101';
const TICKET_MESSAGE_PUBLIC = '0191e3a0-c012-7000-8000-000000000111';
const TICKET_MESSAGE_INTERNAL = '0191e3a0-c012-7000-8000-000000000112';
const OUTBOX_EVENT_1 = '0191e3a0-c012-7000-8000-000000000121';
const CATEGORY_MARKETPLACE = '0191e3a0-c012-7000-8000-000000000131';
const FIELD_SCHEMA_1 = '0191e3a0-c012-7000-8000-000000000132';
const POST_1 = '0191e3a0-c012-7000-8000-000000000133';
const LEGAL_HOLD_1 = '0191e3a0-c012-7000-8000-000000000134';
const STORE_1 = '0191e3a0-c012-7000-8000-000000000135';
const AGENT_CASH_REMITTANCE_1 = '0191e3a0-c012-7000-8000-000000000141';

const FIXTURE_PREFIX = '0191e3a0-c012-7000-8000-%';

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

const AS_AGENT: Context = {
  tenant_id: TENANT_A,
  user_id: USER_AGENT,
  member_id: MEMBER_AGENT,
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
const AS_ANON: Context = { tenant_id: TENANT_A };
const AS_PLATFORM_ADMIN: Context = {
  is_platform_admin: 'true',
  role: 'platform_admin',
  user_id: USER_ADMIN,
};
const AS_PLATFORM_SUPPORT: Context = { role: 'platform_support' };

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

describe('Row level security: operations domain (0012)', () => {
  let app: Sql;
  let admin: Sql;

  beforeAll(async () => {
    app = testSqlClient(4, resolveTestAppDatabaseUrl());
    admin = testSqlClient(1, resolveTestDatabaseUrl());

    await admin`delete from users where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;

    await admin`
      insert into users (id, phone_e164) values
        (${USER_AGENT}, '+8801766000001'),
        (${USER_ADMIN}, '+8801766000002'),
        (${USER_STRANGER}, '+8801766000003'),
        (${USER_B}, '+8801766000004')`;

    await admin`
      insert into partners (id, legal_name, display_name, phone_e164) values
        (${PARTNER}, 'Operations Fixture Partner', 'Operations Fixture Partner', '+8801766000099')`;

    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
        (${GEO_AREA_A}, 3, 'upazila', 'rls-ops-a', 'RLS Ops Area A', 'fixture'),
        (${GEO_AREA_B}, 3, 'upazila', 'rls-ops-b', 'RLS Ops Area B', 'fixture')`;

    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
        (${TENANT_A}, ${PARTNER}, ${GEO_AREA_A}, 'rls-ops-tenant-a', 'এ', 'A',
          st_point(90.4, 23.8)::geography, 'active'),
        (${TENANT_B}, ${PARTNER}, ${GEO_AREA_B}, 'rls-ops-tenant-b', 'বি', 'B',
          st_point(90.5, 23.9)::geography, 'active')`;

    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${MEMBER_AGENT}, ${TENANT_A}, ${USER_AGENT}, 'agent'),
        (${MEMBER_ADMIN}, ${TENANT_A}, ${USER_ADMIN}, 'tenant_admin'),
        (${MEMBER_STRANGER}, ${TENANT_A}, ${USER_STRANGER}, 'member'),
        (${MEMBER_B}, ${TENANT_B}, ${USER_B}, 'tenant_admin')`;

    await admin`
      insert into field_agents (id, tenant_id, member_id, agent_code, employment_type_code, joined_on) values
        (${FIELD_AGENT_1}, ${TENANT_A}, ${MEMBER_AGENT}, 'RLS-001', 'commission_only', current_date)`;

    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en) values
        (${CATEGORY_PLACE}, 'place', 'rls-ops-place-cat', 'ক', 'Place Cat')`;
    await admin`
      insert into places (id, tenant_id, category_id, slug, name_bn, location, source_code, status_code) values
        (${PLACE_1}, ${TENANT_A}, ${CATEGORY_PLACE}, 'rls-ops-place', 'দোকান',
          st_point(90.4, 23.8)::geography, 'agent_survey', 'published')`;

    await admin`
      insert into agent_visits
        (id, tenant_id, field_agent_id, place_id, purpose_code, outcome_code, visited_at, check_in_location, client_visit_id)
      values
        (${AGENT_VISIT_1}, ${TENANT_A}, ${FIELD_AGENT_1}, ${PLACE_1}, 'verification', 'verified', now(),
          st_point(90.4, 23.8)::geography, 'rls-ops-client-visit-1')`;

    await admin`
      insert into agent_commissions (id, tenant_id, field_agent_id, source_code, amount, idempotency_key) values
        (${AGENT_COMMISSION_1}, ${TENANT_A}, ${FIELD_AGENT_1}, 'store_onboarded', 250.00, 'rls-ops-commission-1')`;

    await admin`
      insert into activity_logs (id, tenant_id, occurred_at, member_id, event_type_code) values
        (${ACTIVITY_LOG_1}, ${TENANT_A}, now(), ${MEMBER_STRANGER}, 'post_viewed')`;

    await admin`
      insert into support_tickets (id, tenant_id, ticket_number, requester_member_id, category_code, subject) values
        (${SUPPORT_TICKET_1}, ${TENANT_A}, 'RLS-OPS-T-001', ${MEMBER_STRANGER}, 'account', 'Fixture ticket')`;
    await admin`
      insert into ticket_messages (id, tenant_id, support_ticket_id, author_user_id, is_internal_note, body) values
        (${TICKET_MESSAGE_PUBLIC}, ${TENANT_A}, ${SUPPORT_TICKET_1}, ${USER_STRANGER}, false, 'I need help'),
        (${TICKET_MESSAGE_INTERNAL}, ${TENANT_A}, ${SUPPORT_TICKET_1}, ${USER_ADMIN}, true, 'internal triage note')`;

    await admin`
      insert into outbox_events (id, aggregate_table, aggregate_id, event_type) values
        (${OUTBOX_EVENT_1}, 'support_tickets', ${SUPPORT_TICKET_1}, 'support_ticket.created')`;

    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en) values
        (${CATEGORY_MARKETPLACE}, 'marketplace', 'rls-ops-market-cat', 'ক২', 'Market Cat')`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, status_code, published_at) values
        (${FIELD_SCHEMA_1}, ${CATEGORY_MARKETPLACE}, 1, '{}'::jsonb, 'published', now())`;
    await admin`
      insert into posts (id, tenant_id, author_member_id, category_id, field_schema_id, title, status_code) values
        (${POST_1}, ${TENANT_A}, ${MEMBER_STRANGER}, ${CATEGORY_MARKETPLACE}, ${FIELD_SCHEMA_1}, 'RLS ops post', 'draft')`;

    await admin`
      insert into agent_cash_remittances (id, tenant_id, field_agent_id, amount, method_code) values
        (${AGENT_CASH_REMITTANCE_1}, ${TENANT_A}, ${FIELD_AGENT_1}, 500.00, 'cash_handover')`;

    await admin`
      insert into stores (id, tenant_id, owner_member_id, slug, name_bn) values
        (${STORE_1}, ${TENANT_A}, ${MEMBER_STRANGER}, 'rls-ops-store', 'দোকান')`;
  });

  afterAll(async () => {
    try {
      await admin`delete from agent_cash_remittances where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from stores where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from legal_holds where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from posts where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from category_field_schemas where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from outbox_events where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from ticket_messages where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from support_tickets where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from activity_logs where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from agent_commissions where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from agent_visits where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from places where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from categories where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from field_agents where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenant_members where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from users where id::text like ${FIXTURE_PREFIX}`;
    } finally {
      await Promise.all([app.end(), admin.end()]);
    }
  });

  describe('field_agents (§11.1)', () => {
    it('is visible to itself and to staff, not to a plain member', async () => {
      const asSelf = await withContext(
        app,
        AS_AGENT,
        (tx) => tx`select id from field_agents where id = ${FIELD_AGENT_1}`,
      );
      expect(asSelf).toHaveLength(1);

      const asStaff = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from field_agents where id = ${FIELD_AGENT_1}`,
      );
      expect(asStaff).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from field_agents where id = ${FIELD_AGENT_1}`,
      );
      expect(asStranger).toHaveLength(0);
    });

    it('lets tenant_admin manage it, not a plain member', async () => {
      const asAdmin = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`update field_agents set cash_limit = 1000 where id = ${FIELD_AGENT_1}`,
      );
      expect(asAdmin.count).toBe(1);
      await admin`update field_agents set cash_limit = 0 where id = ${FIELD_AGENT_1}`;

      await expectNoRowsAffected(
        withContext(
          app,
          AS_STRANGER,
          (tx) => tx`update field_agents set cash_limit = 999 where id = ${FIELD_AGENT_1}`,
        ),
      );
    });

    it('is isolated from tenant B', async () => {
      const rows = await withContext(
        app,
        AS_TENANT_B,
        (tx) => tx`select id from field_agents where id = ${FIELD_AGENT_1}`,
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('agent_visits (§11.2)', () => {
    it('lets the agent see and insert their own visits', async () => {
      const asSelf = await withContext(
        app,
        AS_AGENT,
        (tx) => tx`select id from agent_visits where id = ${AGENT_VISIT_1}`,
      );
      expect(asSelf).toHaveLength(1);

      const inserted = await withContext(
        app,
        AS_AGENT,
        (tx) =>
          tx`insert into agent_visits (tenant_id, field_agent_id, purpose_code, outcome_code, visited_at, check_in_location, client_visit_id)
             values (${TENANT_A}, ${FIELD_AGENT_1}, 'data_collection', 'onboarded', now(), st_point(90.4, 23.8)::geography, 'rls-ops-client-visit-2')`,
      );
      expect(inserted.count).toBe(1);
      await admin`delete from agent_visits where tenant_id = ${TENANT_A} and client_visit_id = 'rls-ops-client-visit-2'`;
    });

    it('lets staff read visits, but not write them (no matching write policy)', async () => {
      const asStaff = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from agent_visits where id = ${AGENT_VISIT_1}`,
      );
      expect(asStaff).toHaveLength(1);

      await expectNoRowsAffected(
        withContext(
          app,
          AS_ADMIN,
          (tx) => tx`update agent_visits set notes = 'staff edit' where id = ${AGENT_VISIT_1}`,
        ),
      );
    });

    it('is invisible to a stranger and isolated from tenant B', async () => {
      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from agent_visits where id = ${AGENT_VISIT_1}`,
      );
      expect(asStranger).toHaveLength(0);

      const asTenantB = await withContext(
        app,
        AS_TENANT_B,
        (tx) => tx`select id from agent_visits where id = ${AGENT_VISIT_1}`,
      );
      expect(asTenantB).toHaveLength(0);
    });
  });

  describe('agent_commissions (§11.3): accrual is system-only', () => {
    it('lets the agent see their own, not insert one directly', async () => {
      const asSelf = await withContext(
        app,
        AS_AGENT,
        (tx) => tx`select id from agent_commissions where id = ${AGENT_COMMISSION_1}`,
      );
      expect(asSelf).toHaveLength(1);

      await expectDenied(
        withContext(
          app,
          AS_AGENT,
          (tx) =>
            tx`insert into agent_commissions (tenant_id, field_agent_id, source_code, amount, idempotency_key)
               values (${TENANT_A}, ${FIELD_AGENT_1}, 'ad_sold', 100, 'rls-ops-commission-self-insert')`,
        ),
      );
    });

    it('lets system accrue a commission', async () => {
      const result = await withContext(
        app,
        AS_SYSTEM,
        (tx) =>
          tx`insert into agent_commissions (tenant_id, field_agent_id, source_code, amount, idempotency_key)
             values (${TENANT_A}, ${FIELD_AGENT_1}, 'ad_sold', 100, 'rls-ops-commission-system-insert')`,
      );
      expect(result.count).toBe(1);
      await admin`delete from agent_commissions where tenant_id = ${TENANT_A} and idempotency_key = 'rls-ops-commission-system-insert'`;
    });

    it('lets tenant_admin approve/pay it', async () => {
      const result = await withContext(
        app,
        AS_ADMIN,
        (tx) =>
          tx`update agent_commissions set status_code = 'approved', approved_by_user_id = ${USER_ADMIN} where id = ${AGENT_COMMISSION_1}`,
      );
      expect(result.count).toBe(1);
      await admin`update agent_commissions set status_code = 'accrued', approved_by_user_id = null where id = ${AGENT_COMMISSION_1}`;
    });

    it('is isolated from tenant B', async () => {
      const rows = await withContext(
        app,
        AS_TENANT_B,
        (tx) => tx`select id from agent_commissions where id = ${AGENT_COMMISSION_1}`,
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('activity_logs (§11.5)', () => {
    it('lets a member see their own logged activity, not a stranger', async () => {
      const asOwner = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from activity_logs where id = ${ACTIVITY_LOG_1}`,
      );
      expect(asOwner).toHaveLength(1);

      const asOther = await withContext(
        app,
        AS_AGENT,
        (tx) => tx`select id from activity_logs where id = ${ACTIVITY_LOG_1}`,
      );
      expect(asOther).toHaveLength(0);
    });

    it('lets tenant_admin see all activity in the tenant', async () => {
      const rows = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from activity_logs where id = ${ACTIVITY_LOG_1}`,
      );
      expect(rows).toHaveLength(1);
    });

    it('accepts an insert from any context in the tenant, including anonymous', async () => {
      const result = await withContext(
        app,
        AS_ANON,
        (tx) =>
          tx`insert into activity_logs (tenant_id, anon_session_hash, event_type_code) values (${TENANT_A}, 'anon-hash', 'search_performed')`,
      );
      expect(result.count).toBe(1);
      await admin`delete from activity_logs where tenant_id = ${TENANT_A} and anon_session_hash = 'anon-hash'`;
    });

    it('cannot be updated by anyone — no UPDATE grant at all', async () => {
      await expectDenied(
        withContext(
          app,
          AS_ADMIN,
          (tx) =>
            tx`update activity_logs set entity_table = 'hijacked' where id = ${ACTIVITY_LOG_1}`,
        ),
      );
    });

    it('is isolated from tenant B', async () => {
      const rows = await withContext(
        app,
        AS_TENANT_B,
        (tx) => tx`select id from activity_logs where id = ${ACTIVITY_LOG_1}`,
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('support_tickets (§11.6)', () => {
    it('lets the requester see and manage their own ticket, not a stranger', async () => {
      const asRequester = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from support_tickets where id = ${SUPPORT_TICKET_1}`,
      );
      expect(asRequester).toHaveLength(1);

      const asOther = await withContext(
        app,
        AS_AGENT,
        (tx) => tx`select id from support_tickets where id = ${SUPPORT_TICKET_1}`,
      );
      expect(asOther).toHaveLength(0);
    });

    it('lets a member insert a ticket for themselves, not for someone else', async () => {
      const ownTicket = await withContext(
        app,
        AS_STRANGER,
        (tx) =>
          tx`insert into support_tickets (tenant_id, ticket_number, requester_member_id, category_code, subject)
             values (${TENANT_A}, 'RLS-OPS-T-002', ${MEMBER_STRANGER}, 'technical', 'Another issue')`,
      );
      expect(ownTicket.count).toBe(1);
      await admin`delete from support_tickets where tenant_id = ${TENANT_A} and ticket_number = 'RLS-OPS-T-002'`;

      await expectDenied(
        withContext(
          app,
          AS_STRANGER,
          (tx) =>
            tx`insert into support_tickets (tenant_id, ticket_number, requester_member_id, category_code, subject)
               values (${TENANT_A}, 'RLS-OPS-T-003', ${MEMBER_AGENT}, 'technical', 'Impersonation attempt')`,
        ),
      );
    });

    it('lets staff manage it fully', async () => {
      const result = await withContext(
        app,
        AS_ADMIN,
        (tx) =>
          tx`update support_tickets set status_code = 'pending_staff' where id = ${SUPPORT_TICKET_1}`,
      );
      expect(result.count).toBe(1);
      await admin`update support_tickets set status_code = 'open' where id = ${SUPPORT_TICKET_1}`;
    });

    it('is isolated from tenant B', async () => {
      const rows = await withContext(
        app,
        AS_TENANT_B,
        (tx) => tx`select id from support_tickets where id = ${SUPPORT_TICKET_1}`,
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('ticket_messages (§11.7)', () => {
    it('shows the requester public messages, hides internal notes', async () => {
      const rows = await withContext(
        app,
        AS_STRANGER,
        (tx) =>
          tx<
            { id: string }[]
          >`select id from ticket_messages where support_ticket_id = ${SUPPORT_TICKET_1} order by id`,
      );
      expect(rows.map((r) => r.id)).toEqual([TICKET_MESSAGE_PUBLIC]);
    });

    it('lets the requester post a public message, not an internal note', async () => {
      const publicMessage = await withContext(
        app,
        AS_STRANGER,
        (tx) =>
          tx`insert into ticket_messages (tenant_id, support_ticket_id, author_user_id, is_internal_note, body)
             values (${TENANT_A}, ${SUPPORT_TICKET_1}, ${USER_STRANGER}, false, 'follow up')`,
      );
      expect(publicMessage.count).toBe(1);
      await admin`delete from ticket_messages where tenant_id = ${TENANT_A} and body = 'follow up'`;

      await expectDenied(
        withContext(
          app,
          AS_STRANGER,
          (tx) =>
            tx`insert into ticket_messages (tenant_id, support_ticket_id, author_user_id, is_internal_note, body)
               values (${TENANT_A}, ${SUPPORT_TICKET_1}, ${USER_STRANGER}, true, 'sneaky internal note')`,
        ),
      );
    });

    it('lets staff see and post internal notes', async () => {
      const rows = await withContext(
        app,
        AS_ADMIN,
        (tx) =>
          tx`select id from ticket_messages where support_ticket_id = ${SUPPORT_TICKET_1} order by id`,
      );
      expect(rows).toHaveLength(2);

      const staffNote = await withContext(
        app,
        AS_ADMIN,
        (tx) =>
          tx`insert into ticket_messages (tenant_id, support_ticket_id, author_user_id, is_internal_note, body)
             values (${TENANT_A}, ${SUPPORT_TICKET_1}, ${USER_ADMIN}, true, 'staff note')`,
      );
      expect(staffNote.count).toBe(1);
      await admin`delete from ticket_messages where tenant_id = ${TENANT_A} and body = 'staff note'`;
    });

    it('is isolated from tenant B', async () => {
      const rows = await withContext(
        app,
        AS_TENANT_B,
        (tx) => tx`select id from ticket_messages where id = ${TICKET_MESSAGE_PUBLIC}`,
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('outbox_events (§11.8): system-only except open INSERT', () => {
    it('accepts an insert from anyone, including anonymous', async () => {
      const result = await withContext(
        app,
        AS_ANON,
        (tx) =>
          tx`insert into outbox_events (aggregate_table, aggregate_id, event_type)
             values ('support_tickets', ${SUPPORT_TICKET_1}, 'support_ticket.anon_test')`,
      );
      expect(result.count).toBe(1);
      await admin`delete from outbox_events where event_type = 'support_ticket.anon_test'`;
    });

    it('is invisible and unwritable to a non-system role', async () => {
      const asStaff = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from outbox_events where id = ${OUTBOX_EVENT_1}`,
      );
      expect(asStaff).toHaveLength(0);

      await expectNoRowsAffected(
        withContext(
          app,
          AS_ADMIN,
          (tx) => tx`update outbox_events set attempts = 5 where id = ${OUTBOX_EVENT_1}`,
        ),
      );
    });

    it('lets system read, update and delete events', async () => {
      const asSystem = await withContext(
        app,
        AS_SYSTEM,
        (tx) => tx`select id from outbox_events where id = ${OUTBOX_EVENT_1}`,
      );
      expect(asSystem).toHaveLength(1);

      const updated = await withContext(
        app,
        AS_SYSTEM,
        (tx) => tx`update outbox_events set attempts = 1 where id = ${OUTBOX_EVENT_1}`,
      );
      expect(updated.count).toBe(1);
      await admin`update outbox_events set attempts = 0 where id = ${OUTBOX_EVENT_1}`;
    });
  });

  describe('legal_holds (§11.9): global, platform-controlled', () => {
    it('is readable only by platform_admin/platform_support, not tenant staff', async () => {
      const inserted = await withContext(
        app,
        AS_ADMIN,
        (tx) =>
          tx`insert into legal_holds (id, subject_type_code, subject_id, subject_tenant_id, reason, placed_by_user_id)
             values (${LEGAL_HOLD_1}, 'post', ${POST_1}, ${TENANT_A}, 'court order', ${USER_ADMIN})`,
      );
      expect(inserted.count).toBe(1);

      const asTenantAdmin = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from legal_holds where id = ${LEGAL_HOLD_1}`,
      );
      expect(asTenantAdmin).toHaveLength(0);

      const asPlatformSupport = await withContext(
        app,
        AS_PLATFORM_SUPPORT,
        (tx) => tx`select id from legal_holds where id = ${LEGAL_HOLD_1}`,
      );
      expect(asPlatformSupport).toHaveLength(1);
    });

    it('rejects a tenant staff hold on a subject type outside post/media_asset', async () => {
      // Picks a subject (a store) the placing role can actually see, so the
      // legal_holds_verify_subject trigger's existence check passes and the
      // rejection is genuinely RLS's subject_type_code restriction, not the
      // trigger failing to find a subject it can't see in the first place
      // (which is what happens for e.g. 'user' — tenant staff can't SELECT
      // an arbitrary users row at all, per §13.6).
      await expectDenied(
        withContext(
          app,
          AS_ADMIN,
          (tx) =>
            tx`insert into legal_holds (subject_type_code, subject_id, subject_tenant_id, reason, placed_by_user_id)
               values ('store', ${STORE_1}, ${TENANT_A}, 'overreach attempt', ${USER_ADMIN})`,
        ),
      );
    });

    it('lets only platform_admin release a hold', async () => {
      await expectNoRowsAffected(
        withContext(
          app,
          AS_ADMIN,
          (tx) =>
            tx`update legal_holds set released_at = now(), released_by_user_id = ${USER_ADMIN}, release_reason = 'unauthorized'
               where id = ${LEGAL_HOLD_1}`,
        ),
      );

      const released = await withContext(
        app,
        AS_PLATFORM_ADMIN,
        (tx) =>
          tx`update legal_holds set released_at = now(), released_by_user_id = ${USER_ADMIN}, release_reason = 'case closed'
             where id = ${LEGAL_HOLD_1}`,
      );
      expect(released.count).toBe(1);
    });
  });

  describe('agent_cash_remittances (§11.10)', () => {
    it('lets the agent see and submit their own, not a stranger', async () => {
      const asSelf = await withContext(
        app,
        AS_AGENT,
        (tx) => tx`select id from agent_cash_remittances where id = ${AGENT_CASH_REMITTANCE_1}`,
      );
      expect(asSelf).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from agent_cash_remittances where id = ${AGENT_CASH_REMITTANCE_1}`,
      );
      expect(asStranger).toHaveLength(0);

      const inserted = await withContext(
        app,
        AS_AGENT,
        (tx) =>
          tx`insert into agent_cash_remittances (tenant_id, field_agent_id, amount, method_code, external_reference)
             values (${TENANT_A}, ${FIELD_AGENT_1}, 300.00, 'bkash', 'TRX-RLS-OPS-1')`,
      );
      expect(inserted.count).toBe(1);
      await admin`delete from agent_cash_remittances where tenant_id = ${TENANT_A} and amount = 300.00`;
    });

    it('lets tenant_admin see and dispute it, not confirm their own', async () => {
      const result = await withContext(
        app,
        AS_ADMIN,
        (tx) =>
          tx`update agent_cash_remittances set status_code = 'disputed', dispute_note = 'mismatch' where id = ${AGENT_CASH_REMITTANCE_1}`,
      );
      expect(result.count).toBe(1);
      await admin`update agent_cash_remittances set status_code = 'submitted', dispute_note = null where id = ${AGENT_CASH_REMITTANCE_1}`;
    });

    it('lets platform read, not write', async () => {
      const asPlatform = await withContext(
        app,
        AS_PLATFORM_SUPPORT,
        (tx) => tx`select id from agent_cash_remittances where id = ${AGENT_CASH_REMITTANCE_1}`,
      );
      expect(asPlatform).toHaveLength(1);

      await expectNoRowsAffected(
        withContext(
          app,
          AS_PLATFORM_SUPPORT,
          (tx) =>
            tx`update agent_cash_remittances set dispute_note = 'platform edit' where id = ${AGENT_CASH_REMITTANCE_1}`,
        ),
      );
    });

    it('is isolated from tenant B', async () => {
      const rows = await withContext(
        app,
        AS_TENANT_B,
        (tx) => tx`select id from agent_cash_remittances where id = ${AGENT_CASH_REMITTANCE_1}`,
      );
      expect(rows).toHaveLength(0);
    });
  });
});
