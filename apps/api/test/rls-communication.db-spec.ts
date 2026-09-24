import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * RLS coverage for the communication domain (0009_communication.sql):
 * conversations, conversation_participants, messages, notification
 * templates/inbox/delivery log, per-user notification preferences, user
 * blocks, lead events + their daily rollup, and saved searches. Same style
 * as rls-payments.db-spec.ts. The genuinely novel mechanism here — the
 * ae_rls_bypass-owned SECURITY DEFINER helpers (is_conversation_participant,
 * is_blocked_between) — was already exercised directly against the dev DB
 * via psql while drafting the migration; this file re-covers the same
 * ground through the normal app connection so it's protected by the
 * automated suite too, plus the rest of the domain's RLS boundaries.
 */

const PARTNER = '0191e3a0-9009-7000-8000-000000000001';
const GEO_AREA_A = '0191e3a0-9009-7000-8000-000000000011';
const GEO_AREA_B = '0191e3a0-9009-7000-8000-000000000012';
const TENANT_A = '0191e3a0-9009-7000-8000-000000000021';
const TENANT_B = '0191e3a0-9009-7000-8000-000000000022';
const USER_ALICE = '0191e3a0-9009-7000-8000-000000000031'; // buyer, conversation creator
const USER_BOB = '0191e3a0-9009-7000-8000-000000000032'; // seller, other participant
const USER_STRANGER = '0191e3a0-9009-7000-8000-000000000033';
const USER_ADMIN = '0191e3a0-9009-7000-8000-000000000034'; // tenant_admin (staff)
const USER_B = '0191e3a0-9009-7000-8000-000000000035';
const MEMBER_ALICE = '0191e3a0-9009-7000-8000-000000000041';
const MEMBER_BOB = '0191e3a0-9009-7000-8000-000000000042';
const MEMBER_STRANGER = '0191e3a0-9009-7000-8000-000000000043';
const MEMBER_ADMIN = '0191e3a0-9009-7000-8000-000000000044';
const MEMBER_B = '0191e3a0-9009-7000-8000-000000000045';

const CONVERSATION_1 = '0191e3a0-9009-7000-8000-000000000051';
const MESSAGE_1 = '0191e3a0-9009-7000-8000-000000000052';
const STORE_1 = '0191e3a0-9009-7000-8000-000000000061';

const NOTIFICATION_TEMPLATE_1 = '0191e3a0-9009-7000-8000-000000000071';
const NOTIFICATION_1 = '0191e3a0-9009-7000-8000-000000000072';
const NOTIFICATION_DELIVERY_1 = '0191e3a0-9009-7000-8000-000000000073';

const USER_BLOCK_1 = '0191e3a0-9009-7000-8000-000000000081'; // Bob blocks Alice

const LEAD_EVENT_1 = '0191e3a0-9009-7000-8000-000000000091'; // not scrubbed, target = Alice
const LEAD_EVENT_2 = '0191e3a0-9009-7000-8000-000000000092'; // scrubbed
const LEAD_DAILY_STAT_1 = '0191e3a0-9009-7000-8000-0000000000a1'; // not scrubbed, store target
const LEAD_DAILY_STAT_2 = '0191e3a0-9009-7000-8000-0000000000a2'; // scrubbed

const SAVED_SEARCH_1 = '0191e3a0-9009-7000-8000-0000000000b1';

const FIXTURE_PREFIX = '0191e3a0-9009-7000-8000-%';
const POINT = 'SRID=4326;POINT(90.4 23.8)';

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
const AS_BOB: Context = {
  tenant_id: TENANT_A,
  user_id: USER_BOB,
  member_id: MEMBER_BOB,
  role: 'member',
};
const AS_STRANGER: Context = {
  tenant_id: TENANT_A,
  user_id: USER_STRANGER,
  member_id: MEMBER_STRANGER,
  role: 'member',
};
const AS_ADMIN: Context = {
  tenant_id: TENANT_A,
  user_id: USER_ADMIN,
  member_id: MEMBER_ADMIN,
  role: 'tenant_admin',
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

describe('Row level security: communication domain (0009)', () => {
  let app: Sql;
  let admin: Sql;

  beforeAll(async () => {
    app = testSqlClient(4, resolveTestAppDatabaseUrl());
    admin = testSqlClient(1, resolveTestDatabaseUrl());

    await admin`delete from users where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from notification_templates where id::text like ${FIXTURE_PREFIX}`;

    await admin`
      insert into users (id, phone_e164) values
        (${USER_ALICE}, '+8801799000001'),
        (${USER_BOB}, '+8801799000002'),
        (${USER_STRANGER}, '+8801799000003'),
        (${USER_ADMIN}, '+8801799000004'),
        (${USER_B}, '+8801799000005')`;

    await admin`
      insert into partners (id, legal_name, display_name, phone_e164) values
        (${PARTNER}, 'Communication Fixture Partner', 'Communication Fixture Partner', '+8801799000099')`;

    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
        (${GEO_AREA_A}, 3, 'upazila', 'rls-comm-a', 'RLS Comm Area A', 'fixture'),
        (${GEO_AREA_B}, 3, 'upazila', 'rls-comm-b', 'RLS Comm Area B', 'fixture')`;

    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
        (${TENANT_A}, ${PARTNER}, ${GEO_AREA_A}, 'rls-comm-tenant-a', 'এ', 'A',
          st_point(90.4, 23.8)::geography, 'active'),
        (${TENANT_B}, ${PARTNER}, ${GEO_AREA_B}, 'rls-comm-tenant-b', 'বি', 'B',
          st_point(90.5, 23.9)::geography, 'active')`;

    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${MEMBER_ALICE}, ${TENANT_A}, ${USER_ALICE}, 'member'),
        (${MEMBER_BOB}, ${TENANT_A}, ${USER_BOB}, 'member'),
        (${MEMBER_STRANGER}, ${TENANT_A}, ${USER_STRANGER}, 'member'),
        (${MEMBER_ADMIN}, ${TENANT_A}, ${USER_ADMIN}, 'tenant_admin'),
        (${MEMBER_B}, ${TENANT_B}, ${USER_B}, 'tenant_admin')`;

    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`
        insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code) values
          (${STORE_1}, ${TENANT_A}, ${MEMBER_ALICE}, 'rls-comm-store', 'দোকান', 'active')`;
    });

    await admin`
      insert into conversations (id, tenant_id, kind_code, created_by_member_id) values
        (${CONVERSATION_1}, ${TENANT_A}, 'direct', ${MEMBER_ALICE})`;
    await admin`
      insert into conversation_participants (tenant_id, conversation_id, member_id, role_code) values
        (${TENANT_A}, ${CONVERSATION_1}, ${MEMBER_ALICE}, 'buyer'),
        (${TENANT_A}, ${CONVERSATION_1}, ${MEMBER_BOB}, 'seller')`;
    await admin`
      insert into messages (id, tenant_id, conversation_id, sender_member_id, body, client_message_id) values
        (${MESSAGE_1}, ${TENANT_A}, ${CONVERSATION_1}, ${MEMBER_ALICE}, 'hello', 'rls-comm-client-msg-1')`;

    await admin`
      insert into notification_templates (id, type_code, channel_code, locale, body_template) values
        (${NOTIFICATION_TEMPLATE_1}, 'new_message', 'in_app', 'en', 'You have a new message from {{sender}}')`;
    await admin`
      insert into notifications (id, user_id, type_code) values
        (${NOTIFICATION_1}, ${USER_ALICE}, 'new_message')`;
    await admin`
      insert into notification_deliveries (id, notification_id, user_id, purpose_code, channel_code, recipient_masked, provider_code)
      values (${NOTIFICATION_DELIVERY_1}, ${NOTIFICATION_1}, ${USER_ALICE}, 'notification', 'in_app', 'masked', 'fixture-provider')`;

    await admin`
      insert into lead_events (id, tenant_id, channel_code, source_code, target_member_id, subject_scrubbed) values
        (${LEAD_EVENT_1}, ${TENANT_A}, 'chat_started', 'post_detail', ${MEMBER_ALICE}, false),
        (${LEAD_EVENT_2}, ${TENANT_A}, 'chat_started', 'post_detail', ${MEMBER_ALICE}, true)`;
    await admin`
      insert into lead_daily_stats (id, tenant_id, stat_date, store_id, channel_code, event_count, subject_scrubbed) values
        (${LEAD_DAILY_STAT_1}, ${TENANT_A}, current_date, ${STORE_1}, 'chat_started', 3, false),
        (${LEAD_DAILY_STAT_2}, ${TENANT_A}, current_date, ${STORE_1}, 'whatsapp_click', 2, true)`;

    await admin`
      insert into saved_searches (id, user_id, name, center) values
        (${SAVED_SEARCH_1}, ${USER_ALICE}, 'Cows nearby', ${POINT}::geography)`;
  });

  afterAll(async () => {
    try {
      await admin`delete from saved_searches where user_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from lead_daily_stats where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from lead_events where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from user_blocks where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from notification_deliveries where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from notifications where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from notification_templates where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from messages where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from conversation_participants where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from conversations where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from stores where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenant_members where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from users where id::text like ${FIXTURE_PREFIX}`;
    } finally {
      await Promise.all([app.end(), admin.end()]);
    }
  });

  describe('conversations (§8.1)', () => {
    it('is visible to participants, not to an unrelated member', async () => {
      const asAlice = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`select id from conversations where id = ${CONVERSATION_1}`,
      );
      expect(asAlice).toHaveLength(1);

      const asBob = await withContext(
        app,
        AS_BOB,
        (tx) => tx`select id from conversations where id = ${CONVERSATION_1}`,
      );
      expect(asBob).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from conversations where id = ${CONVERSATION_1}`,
      );
      expect(asStranger).toHaveLength(0);
    });

    it("is invisible across tenants, even to that other tenant's own staff", async () => {
      const asTenantB = await withContext(
        app,
        AS_TENANT_B,
        (tx) => tx`select id from conversations where id = ${CONVERSATION_1}`,
      );
      expect(asTenantB).toHaveLength(0);
    });

    it('lets a member create a conversation as themselves, not on behalf of another member', async () => {
      const result = await withContext(
        app,
        AS_STRANGER,
        (tx) =>
          tx`insert into conversations (tenant_id, kind_code, created_by_member_id)
             values (${TENANT_A}, 'direct', ${MEMBER_STRANGER})`,
      );
      expect(result.count).toBe(1);

      await expectDenied(
        withContext(
          app,
          AS_STRANGER,
          (tx) =>
            tx`insert into conversations (tenant_id, kind_code, created_by_member_id)
               values (${TENANT_A}, 'direct', ${MEMBER_ALICE})`,
        ),
      );
    });

    it('a participant alone cannot lock it, and staff currently has no path to either (Q13, see migration header)', async () => {
      // Alice can see the row (participant), but the only UPDATE-applicable
      // policy is staff-only — silent 0 rows, not an error.
      await expectNoRowsAffected(
        withContext(
          app,
          AS_ALICE,
          (tx) => tx`update conversations set is_locked = true where id = ${CONVERSATION_1}`,
        ),
      );
      // The staff_lock policy exists (WITH CHECK app_is_staff()), but staff
      // who aren't participants have no SELECT-applicable policy at all
      // (staff_open_conversation(), which would grant it, is deferred to
      // 0010 — it needs a linked `reports` row) — so it's also silent 0 rows
      // for now, not a success, until that's wired up.
      await expectNoRowsAffected(
        withContext(
          app,
          AS_ADMIN,
          (tx) => tx`update conversations set is_locked = true where id = ${CONVERSATION_1}`,
        ),
      );
    });
  });

  describe('conversation_participants (§8.2)', () => {
    it('shows the whole roster to a participant (not just their own row), nothing to a stranger', async () => {
      const asAlice = await withContext(
        app,
        AS_ALICE,
        (tx) =>
          tx<
            { member_id: string }[]
          >`select member_id from conversation_participants where conversation_id = ${CONVERSATION_1}`,
      );
      expect(asAlice).toHaveLength(2);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) =>
          tx`select member_id from conversation_participants where conversation_id = ${CONVERSATION_1}`,
      );
      expect(asStranger).toHaveLength(0);
    });

    it('lets a participant update only their own row', async () => {
      const result = await withContext(
        app,
        AS_ALICE,
        (tx) =>
          tx`update conversation_participants set is_muted = true
             where conversation_id = ${CONVERSATION_1} and member_id = ${MEMBER_ALICE}`,
      );
      expect(result.count).toBe(1);

      await expectNoRowsAffected(
        withContext(
          app,
          AS_ALICE,
          (tx) =>
            tx`update conversation_participants set is_muted = true
               where conversation_id = ${CONVERSATION_1} and member_id = ${MEMBER_BOB}`,
        ),
      );
    });

    it('lets the system add a new participant', async () => {
      const result = await withContext(
        app,
        AS_SYSTEM,
        (tx) =>
          tx`insert into conversation_participants (tenant_id, conversation_id, member_id, role_code)
             values (${TENANT_A}, ${CONVERSATION_1}, ${MEMBER_ADMIN}, 'store_staff')`,
      );
      expect(result.count).toBe(1);
      await admin`delete from conversation_participants where conversation_id = ${CONVERSATION_1} and member_id = ${MEMBER_ADMIN}`;
    });
  });

  describe('messages (§8.3)', () => {
    it('is visible to participants, not to an unrelated member', async () => {
      const asBob = await withContext(
        app,
        AS_BOB,
        (tx) => tx`select id from messages where id = ${MESSAGE_1}`,
      );
      expect(asBob).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from messages where id = ${MESSAGE_1}`,
      );
      expect(asStranger).toHaveLength(0);
    });

    it('lets a participant send a message, not a non-participant', async () => {
      const result = await withContext(
        app,
        AS_BOB,
        (tx) =>
          tx`insert into messages (tenant_id, conversation_id, sender_member_id, body, client_message_id)
             values (${TENANT_A}, ${CONVERSATION_1}, ${MEMBER_BOB}, 'hi back', 'rls-comm-client-msg-2')`,
      );
      expect(result.count).toBe(1);

      await expectDenied(
        withContext(
          app,
          AS_STRANGER,
          (tx) =>
            tx`insert into messages (tenant_id, conversation_id, sender_member_id, body, client_message_id)
               values (${TENANT_A}, ${CONVERSATION_1}, ${MEMBER_STRANGER}, 'butting in', 'rls-comm-client-msg-3')`,
        ),
      );
    });

    it('rejects a message to someone who has blocked the sender', async () => {
      // Bob blocks Alice for the duration of this test only — Alice can't
      // see that row directly (blocked user has no access), but the block
      // still stops her from messaging Bob.
      const blockId = '0191e3a0-9009-7000-8000-000000000082';
      await admin`insert into user_blocks (id, blocker_user_id, blocked_user_id) values (${blockId}, ${USER_BOB}, ${USER_ALICE})`;
      try {
        await expectDenied(
          withContext(
            app,
            AS_ALICE,
            (tx) =>
              tx`insert into messages (tenant_id, conversation_id, sender_member_id, body, client_message_id)
                 values (${TENANT_A}, ${CONVERSATION_1}, ${MEMBER_ALICE}, 'let me back in', 'rls-comm-client-msg-4')`,
          ),
        );
      } finally {
        await admin`delete from user_blocks where id = ${blockId}`;
      }
    });

    it('lets the sender edit/soft-delete their own message, not another participant', async () => {
      const result = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`update messages set body = 'edited', edited_at = now() where id = ${MESSAGE_1}`,
      );
      expect(result.count).toBe(1);

      await expectNoRowsAffected(
        withContext(
          app,
          AS_BOB,
          (tx) => tx`update messages set deleted_at = now() where id = ${MESSAGE_1}`,
        ),
      );
    });

    it('hides a deleted message from other participants but not from its sender', async () => {
      await admin`update messages set deleted_at = now() where id = ${MESSAGE_1}`;

      const asSender = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`select id from messages where id = ${MESSAGE_1}`,
      );
      expect(asSender).toHaveLength(1);

      const asOther = await withContext(
        app,
        AS_BOB,
        (tx) => tx`select id from messages where id = ${MESSAGE_1}`,
      );
      expect(asOther).toHaveLength(0);

      await admin`update messages set deleted_at = null where id = ${MESSAGE_1}`;
    });
  });

  describe('notification_templates (§8.4)', () => {
    it('is readable only by platform/system, not by a tenant_admin (not client data)', async () => {
      const asAdmin = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from notification_templates where id = ${NOTIFICATION_TEMPLATE_1}`,
      );
      expect(asAdmin).toHaveLength(0);

      const asSystem = await withContext(
        app,
        AS_SYSTEM,
        (tx) => tx`select id from notification_templates where id = ${NOTIFICATION_TEMPLATE_1}`,
      );
      expect(asSystem).toHaveLength(1);
    });

    it('only platform_admin may write it', async () => {
      // The row IS select-visible to a system session (platform_read), but
      // the only UPDATE-applicable policy requires is_platform_admin() —
      // silent 0 rows, not an error.
      await expectNoRowsAffected(
        withContext(
          app,
          AS_SYSTEM,
          (tx) =>
            tx`update notification_templates set is_active = false where id = ${NOTIFICATION_TEMPLATE_1}`,
        ),
      );
      const result = await withContext(
        app,
        AS_PLATFORM_ADMIN,
        (tx) =>
          tx`update notification_templates set version = 2 where id = ${NOTIFICATION_TEMPLATE_1}`,
      );
      expect(result.count).toBe(1);
    });
  });

  describe('notifications (§8.5)', () => {
    it('is visible and updatable by its owner only', async () => {
      const asOwner = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`select id from notifications where id = ${NOTIFICATION_1}`,
      );
      expect(asOwner).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from notifications where id = ${NOTIFICATION_1}`,
      );
      expect(asStranger).toHaveLength(0);

      const updateResult = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`update notifications set read_at = now() where id = ${NOTIFICATION_1}`,
      );
      expect(updateResult.count).toBe(1);
    });

    it('only the system role may insert one', async () => {
      await expectDenied(
        withContext(
          app,
          AS_ALICE,
          (tx) =>
            tx`insert into notifications (user_id, type_code) values (${USER_ALICE}, 'new_message')`,
        ),
      );
      const result = await withContext(
        app,
        AS_SYSTEM,
        (tx) =>
          tx`insert into notifications (user_id, type_code) values (${USER_ALICE}, 'new_message')`,
      );
      expect(result.count).toBe(1);
      await admin`delete from notifications where user_id = ${USER_ALICE} and id <> ${NOTIFICATION_1}`;
    });
  });

  describe('notification_deliveries (§8.6)', () => {
    it('is system-only: no other role, not even the recipient, can read it', async () => {
      const asSystem = await withContext(
        app,
        AS_SYSTEM,
        (tx) => tx`select id from notification_deliveries where id = ${NOTIFICATION_DELIVERY_1}`,
      );
      expect(asSystem).toHaveLength(1);

      const asOwner = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`select id from notification_deliveries where id = ${NOTIFICATION_DELIVERY_1}`,
      );
      expect(asOwner).toHaveLength(0);
    });
  });

  describe('user_notification_preferences (§8.7)', () => {
    it('is G-OWNER: full CRUD for the owner, nothing for anyone else', async () => {
      const insertResult = await withContext(
        app,
        AS_ALICE,
        (tx) =>
          tx`insert into user_notification_preferences (user_id, type_code, channel_code, is_enabled)
             values (${USER_ALICE}, 'boost_expiring', 'sms', false)`,
      );
      expect(insertResult.count).toBe(1);

      const asOwner = await withContext(
        app,
        AS_ALICE,
        (tx) =>
          tx`select is_enabled from user_notification_preferences where user_id = ${USER_ALICE} and type_code = 'boost_expiring'`,
      );
      expect(asOwner).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) =>
          tx`select is_enabled from user_notification_preferences where user_id = ${USER_ALICE} and type_code = 'boost_expiring'`,
      );
      expect(asStranger).toHaveLength(0);

      await admin`delete from user_notification_preferences where user_id = ${USER_ALICE} and type_code = 'boost_expiring'`;
    });
  });

  describe('user_blocks (§8.10)', () => {
    beforeAll(async () => {
      await admin`insert into user_blocks (id, blocker_user_id, blocked_user_id) values (${USER_BLOCK_1}, ${USER_BOB}, ${USER_ALICE})`;
    });

    afterAll(async () => {
      await admin`delete from user_blocks where id = ${USER_BLOCK_1}`;
    });

    it('is visible to the blocker; the blocked user has no access; platform can see it', async () => {
      const asBlocker = await withContext(
        app,
        AS_BOB,
        (tx) => tx`select id from user_blocks where id = ${USER_BLOCK_1}`,
      );
      expect(asBlocker).toHaveLength(1);

      const asBlocked = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`select id from user_blocks where id = ${USER_BLOCK_1}`,
      );
      expect(asBlocked).toHaveLength(0);

      const asPlatform = await withContext(
        app,
        AS_PLATFORM_ADMIN,
        (tx) => tx`select id from user_blocks where id = ${USER_BLOCK_1}`,
      );
      expect(asPlatform).toHaveLength(1);
    });

    it('is_blocked_between() detects the block in the direction the blocked user cannot see directly', async () => {
      const [row] = await withContext(
        app,
        AS_ALICE,
        (tx) =>
          tx<
            { blocked: boolean }[]
          >`select public.is_blocked_between(${USER_ALICE}, ${USER_BOB}) as blocked`,
      );
      expect(row?.blocked).toBe(true);
    });
  });

  describe('lead_events (§8.8)', () => {
    it('lets anyone in the tenant insert one', async () => {
      const result = await withContext(
        app,
        AS_STRANGER,
        (tx) =>
          tx`insert into lead_events (tenant_id, channel_code, source_code, target_member_id)
             values (${TENANT_A}, 'call_click', 'post_detail', ${MEMBER_ALICE})`,
      );
      expect(result.count).toBe(1);
      await admin`delete from lead_events where tenant_id = ${TENANT_A} and channel_code = 'call_click'`;
    });

    it('is visible to staff only when not scrubbed; the target member has no direct access', async () => {
      const asAdmin = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from lead_events where id = ${LEAD_EVENT_1}`,
      );
      expect(asAdmin).toHaveLength(1);

      const asAdminScrubbed = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from lead_events where id = ${LEAD_EVENT_2}`,
      );
      expect(asAdminScrubbed).toHaveLength(0);

      const asTarget = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`select id from lead_events where id = ${LEAD_EVENT_1}`,
      );
      expect(asTarget).toHaveLength(0);

      const asPlatform = await withContext(
        app,
        AS_PLATFORM_ADMIN,
        (tx) => tx`select id from lead_events where id = ${LEAD_EVENT_2}`,
      );
      expect(asPlatform).toHaveLength(1);
    });
  });

  describe('lead_daily_stats (§8.9)', () => {
    it("is visible to the target's owner and staff only when not scrubbed", async () => {
      const asOwner = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`select id from lead_daily_stats where id = ${LEAD_DAILY_STAT_1}`,
      );
      expect(asOwner).toHaveLength(1);

      const asOwnerScrubbed = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`select id from lead_daily_stats where id = ${LEAD_DAILY_STAT_2}`,
      );
      expect(asOwnerScrubbed).toHaveLength(0);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from lead_daily_stats where id = ${LEAD_DAILY_STAT_1}`,
      );
      expect(asStranger).toHaveLength(0);
    });

    it('only the system role may write it', async () => {
      await expectNoRowsAffected(
        withContext(
          app,
          AS_ADMIN,
          (tx) => tx`update lead_daily_stats set event_count = 99 where id = ${LEAD_DAILY_STAT_1}`,
        ),
      );
      const result = await withContext(
        app,
        AS_SYSTEM,
        (tx) => tx`update lead_daily_stats set event_count = 4 where id = ${LEAD_DAILY_STAT_1}`,
      );
      expect(result.count).toBe(1);
    });
  });

  describe('saved_searches (§8.11)', () => {
    it('is G-OWNER: visible/writable by its owner, not by a stranger', async () => {
      const asOwner = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`select id from saved_searches where id = ${SAVED_SEARCH_1}`,
      );
      expect(asOwner).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from saved_searches where id = ${SAVED_SEARCH_1}`,
      );
      expect(asStranger).toHaveLength(0);

      const result = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`update saved_searches set is_active = false where id = ${SAVED_SEARCH_1}`,
      );
      expect(result.count).toBe(1);
      await admin`update saved_searches set is_active = true where id = ${SAVED_SEARCH_1}`;
    });

    it('the matching job (system) can also read and write it', async () => {
      const asSystem = await withContext(
        app,
        AS_SYSTEM,
        (tx) => tx`select id from saved_searches where id = ${SAVED_SEARCH_1}`,
      );
      expect(asSystem).toHaveLength(1);

      const result = await withContext(
        app,
        AS_SYSTEM,
        (tx) => tx`update saved_searches set last_alerted_at = now() where id = ${SAVED_SEARCH_1}`,
      );
      expect(result.count).toBe(1);
    });
  });
});
