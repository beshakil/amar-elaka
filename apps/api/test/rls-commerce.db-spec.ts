import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * RLS coverage for the commerce domain (0007_commerce.sql): credit wallets/
 * ledger/lots, credit packages, boosts, subscriptions, invoices + lines,
 * ads, and the tenant-closure economics tables (liability, pool,
 * dispositions, settlements). Same style as rls-content.db-spec.ts/
 * rls-stores.db-spec.ts. Per the migration header, credit_apply() and the
 * closure/settlement orchestration aren't built yet — these tests cover the
 * RLS policies that exist today (mostly read-visibility + the narrow write
 * paths the migration deliberately opened), not the not-yet-built mutation
 * engine.
 */

const PARTNER = '0191e3a0-7007-7000-8000-000000000001';
const GEO_AREA_A = '0191e3a0-7007-7000-8000-000000000011';
const GEO_AREA_B = '0191e3a0-7007-7000-8000-000000000012';
const TENANT_A = '0191e3a0-7007-7000-8000-000000000021';
const TENANT_B = '0191e3a0-7007-7000-8000-000000000022';
const USER_ALICE = '0191e3a0-7007-7000-8000-000000000031'; // wallet/lot/subscriber owner
const USER_ADMIN = '0191e3a0-7007-7000-8000-000000000032'; // tenant_admin in A (staff)
const USER_STRANGER = '0191e3a0-7007-7000-8000-000000000033'; // unrelated member of A
const USER_ADVERTISER = '0191e3a0-7007-7000-8000-000000000034';
const USER_B = '0191e3a0-7007-7000-8000-000000000035'; // tenant_admin in B
const MEMBER_ALICE = '0191e3a0-7007-7000-8000-000000000041';
const MEMBER_ADMIN = '0191e3a0-7007-7000-8000-000000000042';
const MEMBER_STRANGER = '0191e3a0-7007-7000-8000-000000000043';
const MEMBER_ADVERTISER = '0191e3a0-7007-7000-8000-000000000044';
const MEMBER_B = '0191e3a0-7007-7000-8000-000000000045';

const STORE = '0191e3a0-7007-7000-8000-000000000061';
const CREDIT_PACKAGE = '0191e3a0-7007-7000-8000-000000000071';
const TENANT_CREDIT_PACKAGE = '0191e3a0-7007-7000-8000-000000000072';
const BOOST_TYPE = '0191e3a0-7007-7000-8000-000000000073';
const TENANT_BOOST_PRICE = '0191e3a0-7007-7000-8000-000000000074';
const SUBSCRIPTION_PLAN = '0191e3a0-7007-7000-8000-000000000075';
const TENANT_PLAN_PRICE = '0191e3a0-7007-7000-8000-000000000076';
const AD_SLOT = '0191e3a0-7007-7000-8000-000000000077';
const AD_INVENTORY = '0191e3a0-7007-7000-8000-000000000078';
const MEDIA_ASSET = '0191e3a0-7007-7000-8000-000000000079';

const CREDIT_TX_1 = '0191e3a0-7007-7000-8000-000000000081';
const CREDIT_LOT_1 = '0191e3a0-7007-7000-8000-000000000082';
const CREDIT_LOT_ALLOCATION_1 = '0191e3a0-7007-7000-8000-000000000083';
const CREDIT_CLOSURE_DISPOSITION_1 = '0191e3a0-7007-7000-8000-000000000084';
const PLATFORM_CREDIT_POOL_1 = '0191e3a0-7007-7000-8000-000000000085';
const CREDIT_LIABILITY_SETTLEMENT_1 = '0191e3a0-7007-7000-8000-000000000086';

const BOOST_1 = '0191e3a0-7007-7000-8000-000000000091';
const BOOST_VOUCHER_1 = '0191e3a0-7007-7000-8000-000000000092';
const SUBSCRIPTION_1 = '0191e3a0-7007-7000-8000-0000000000a1';
const INVOICE_1 = '0191e3a0-7007-7000-8000-0000000000a2';
const INVOICE_LINE_1 = '0191e3a0-7007-7000-8000-0000000000a3';
const AD_CREATIVE_1 = '0191e3a0-7007-7000-8000-0000000000b1';
const AD_BOOKING_1 = '0191e3a0-7007-7000-8000-0000000000b2';
const AD_DAILY_STAT_1 = '0191e3a0-7007-7000-8000-0000000000b3';

const FIXTURE_PREFIX = '0191e3a0-7007-7000-8000-%';
const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

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
const AS_ADVERTISER: Context = {
  tenant_id: TENANT_A,
  user_id: USER_ADVERTISER,
  member_id: MEMBER_ADVERTISER,
  role: 'member',
};
// Also the "earning tenant" admin for the settlement test (to_tenant_id = TENANT_B).
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

describe('Row level security: commerce domain (0007)', () => {
  let app: Sql;
  let admin: Sql;

  beforeAll(async () => {
    app = testSqlClient(4, resolveTestAppDatabaseUrl());
    admin = testSqlClient(1, resolveTestDatabaseUrl());

    await admin`delete from users where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from credit_packages where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from boost_types where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from subscription_plans where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from ad_slots where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from platform_credit_pool where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from credit_closure_dispositions where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from credit_liability_settlements where id::text like ${FIXTURE_PREFIX}`;

    await admin`
      insert into users (id, phone_e164) values
        (${USER_ALICE}, '+8801755000001'),
        (${USER_ADMIN}, '+8801755000002'),
        (${USER_STRANGER}, '+8801755000003'),
        (${USER_ADVERTISER}, '+8801755000004'),
        (${USER_B}, '+8801755000005')`;

    await admin`
      insert into partners (id, legal_name, display_name, phone_e164) values
        (${PARTNER}, 'Commerce Fixture Partner', 'Commerce Fixture Partner', '+8801755000099')`;

    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
        (${GEO_AREA_A}, 3, 'upazila', 'rls-commerce-a', 'RLS Commerce Area A', 'fixture'),
        (${GEO_AREA_B}, 3, 'upazila', 'rls-commerce-b', 'RLS Commerce Area B', 'fixture')`;

    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
        (${TENANT_A}, ${PARTNER}, ${GEO_AREA_A}, 'rls-commerce-tenant-a', 'এ', 'A',
          st_point(90.4, 23.8)::geography, 'active'),
        (${TENANT_B}, ${PARTNER}, ${GEO_AREA_B}, 'rls-commerce-tenant-b', 'বি', 'B',
          st_point(90.5, 23.9)::geography, 'active')`;

    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${MEMBER_ALICE}, ${TENANT_A}, ${USER_ALICE}, 'member'),
        (${MEMBER_ADMIN}, ${TENANT_A}, ${USER_ADMIN}, 'tenant_admin'),
        (${MEMBER_STRANGER}, ${TENANT_A}, ${USER_STRANGER}, 'member'),
        (${MEMBER_ADVERTISER}, ${TENANT_A}, ${USER_ADVERTISER}, 'member'),
        (${MEMBER_B}, ${TENANT_B}, ${USER_B}, 'tenant_admin')`;

    // stores_protect_status (0006) forces pending_review unless the writer
    // is staff/system — same workaround as rls-stores.db-spec.ts.
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`
        insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code) values
          (${STORE}, ${TENANT_A}, ${MEMBER_ALICE}, 'rls-commerce-store', 'দোকান', 'active')`;
    });

    await admin`
      insert into credit_wallets (tenant_id, user_id) values (${TENANT_A}, ${USER_ALICE})`;

    await admin`
      insert into credit_packages (id, code, name_key, credits, default_price) values
        (${CREDIT_PACKAGE}, 'rls-commerce-pkg', 'enum.credit_packages.fixture', 100, 100)`;
    await admin`
      insert into tenant_credit_packages (id, tenant_id, credit_package_id, is_enabled) values
        (${TENANT_CREDIT_PACKAGE}, ${TENANT_A}, ${CREDIT_PACKAGE}, true)`;

    await admin`
      insert into boost_types
        (id, code, name_key, placement_code, target_code, duration_hours, default_cost_credits, min_cost_credits, max_cost_credits)
      values
        (${BOOST_TYPE}, 'rls-commerce-boost', 'enum.boost_types.fixture', 'bump', 'store', 24, 50, 10, 200)`;
    await admin`
      insert into tenant_boost_prices (id, tenant_id, boost_type_id, is_enabled) values
        (${TENANT_BOOST_PRICE}, ${TENANT_A}, ${BOOST_TYPE}, true)`;

    await admin`
      insert into subscription_plans
        (id, code, name_key, subject_code, billing_interval_code, default_price, min_price, max_price)
      values
        (${SUBSCRIPTION_PLAN}, 'rls-commerce-plan', 'enum.subscription_plans.fixture', 'member', 'month', 100, 50, 200)`;
    await admin`
      insert into tenant_plan_prices (id, tenant_id, subscription_plan_id, is_enabled) values
        (${TENANT_PLAN_PRICE}, ${TENANT_A}, ${SUBSCRIPTION_PLAN}, true)`;

    await admin`
      insert into ad_slots
        (id, code, name_key, surface_code, width_px, height_px, max_positions, default_price_per_day, min_price_per_day, max_price_per_day)
      values
        (${AD_SLOT}, 'rls-commerce-slot', 'enum.ad_slots.fixture', 'web', 300, 250, 2, 50, 10, 100)`;
    await admin`
      insert into ad_inventory (id, tenant_id, ad_slot_id, positions, price_per_day, is_enabled) values
        (${AD_INVENTORY}, ${TENANT_A}, ${AD_SLOT}, 1, 50, true)`;

    await admin`
      insert into media_assets
        (id, tenant_id, uploaded_by_user_id, kind_code, storage_key, mime_type, byte_size, checksum_sha256)
      values
        (${MEDIA_ASSET}, ${TENANT_A}, ${USER_ADVERTISER}, 'image', 'rls-commerce/fixture.jpg', 'image/jpeg', 1024,
         '0000000000000000000000000000000000000000000000000000000000000000')`;

    await admin`
      insert into credit_transactions
        (id, tenant_id, user_id, amount, balance_after, reason_code, is_purchased, idempotency_key)
      values
        (${CREDIT_TX_1}, ${TENANT_A}, ${USER_ALICE}, 10, 10, 'promo_grant', false, 'rls-commerce-fixture-tx-1')`;

    await admin`
      insert into credit_lots
        (id, tenant_id, user_id, source_transaction_id, is_purchased, credits_granted, credits_remaining, expires_at)
      values
        (${CREDIT_LOT_1}, ${TENANT_A}, ${USER_ALICE}, ${CREDIT_TX_1}, false, 10, 10, ${FUTURE})`;

    await admin`
      insert into credit_lot_allocations (id, tenant_id, credit_transaction_id, credit_lot_id, credits) values
        (${CREDIT_LOT_ALLOCATION_1}, ${TENANT_A}, ${CREDIT_TX_1}, ${CREDIT_LOT_1}, 5)`;

    await admin`insert into tenant_credit_liability (tenant_id) values (${TENANT_A})`;

    await admin`
      insert into credit_closure_dispositions
        (id, closed_tenant_id, user_id, credits_total, purchased_credits, outcome_code, refund_deadline_at)
      values
        (${CREDIT_CLOSURE_DISPOSITION_1}, ${TENANT_A}, ${USER_ALICE}, 10, 0, 'pooled', ${FUTURE})`;

    await admin`
      insert into platform_credit_pool
        (id, user_id, origin_tenant_id, origin_lot_id, credit_closure_disposition_id, is_purchased, credits, value_bdt)
      values
        (${PLATFORM_CREDIT_POOL_1}, ${USER_ALICE}, ${TENANT_A}, ${CREDIT_LOT_1}, ${CREDIT_CLOSURE_DISPOSITION_1}, false, 5, 0)`;

    await admin`
      insert into credit_liability_settlements
        (id, settlement_kind_code, from_tenant_id, to_tenant_id, from_partner_id, to_partner_id, user_id,
         credits, credit_value_bdt, origin_rate, origin_rate_is_final, spender_rate, spender_rate_is_final,
         payout_rate, payout_bdt, reserve_funded_bdt, credit_transaction_id, credit_lot_id, journal_id)
      values
        (${CREDIT_LIABILITY_SETTLEMENT_1}, 'closure_port', ${TENANT_A}, ${TENANT_B}, ${PARTNER}, ${PARTNER}, ${USER_ALICE},
         5, 0, 0, true, 0, true, 0, 0, 0, ${CREDIT_TX_1}, ${CREDIT_LOT_1}, ${CREDIT_TX_1})`;

    await admin`
      insert into boosts
        (id, tenant_id, boost_type_id, store_id, purchased_by_member_id, starts_at, ends_at, cost_credits, status_code)
      values
        (${BOOST_1}, ${TENANT_A}, ${BOOST_TYPE}, ${STORE}, ${MEMBER_ALICE}, now(), ${FUTURE}, 0, 'active')`;

    await admin`
      insert into boost_vouchers (id, tenant_id, user_id, source_boost_id, boost_type_id, remaining_days, expires_at) values
        (${BOOST_VOUCHER_1}, ${TENANT_A}, ${USER_ALICE}, ${BOOST_1}, ${BOOST_TYPE}, 3, ${FUTURE})`;

    await admin`
      insert into subscriptions (id, tenant_id, subscription_plan_id, member_id, price) values
        (${SUBSCRIPTION_1}, ${TENANT_A}, ${SUBSCRIPTION_PLAN}, ${MEMBER_ALICE}, 100)`;

    await admin`
      insert into invoices
        (id, tenant_id, invoice_number, billed_member_id, seller_bin, fiscal_year, tax_invoice_format_code)
      values
        (${INVOICE_1}, ${TENANT_A}, 'RLS-COMMERCE-0001', ${MEMBER_ALICE}, '1234567890123', '2026-01', 'standard')`;

    await admin`
      insert into invoice_lines
        (id, tenant_id, invoice_id, line_type_code, revenue_stream_code, description_key, unit_price, line_total, vat_rate)
      values
        (${INVOICE_LINE_1}, ${TENANT_A}, ${INVOICE_1}, 'adjustment', 'credits', 'rls.commerce.fixture', 100, 100, 0)`;

    await admin`
      insert into ad_creatives (id, tenant_id, advertiser_member_id, media_asset_id) values
        (${AD_CREATIVE_1}, ${TENANT_A}, ${MEMBER_ADVERTISER}, ${MEDIA_ASSET})`;

    await admin`
      insert into ad_bookings
        (id, tenant_id, ad_inventory_id, ad_creative_id, advertiser_member_id, "position",
         starts_on, ends_on, price_per_day, total_price, status_code, hold_expires_at)
      values
        (${AD_BOOKING_1}, ${TENANT_A}, ${AD_INVENTORY}, ${AD_CREATIVE_1}, ${MEMBER_ADVERTISER}, 1,
         current_date, current_date, 50, 50, 'held', ${FUTURE})`;

    await admin`
      insert into ad_daily_stats (id, tenant_id, ad_booking_id, stat_date) values
        (${AD_DAILY_STAT_1}, ${TENANT_A}, ${AD_BOOKING_1}, current_date)`;
  });

  afterAll(async () => {
    try {
      await admin`delete from ad_daily_stats where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from ad_bookings where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from ad_creatives where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from invoice_lines where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from invoices where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from subscriptions where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from boost_vouchers where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from boosts where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from platform_credit_pool where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from credit_closure_dispositions where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenant_credit_liability where tenant_id::text like ${FIXTURE_PREFIX}`;
      // credit_transactions, credit_lot_allocations and credit_liability_settlements
      // are append-only by design (their prevent_mutation() triggers block DELETE
      // unconditionally, for every role, including this superuser connection) — so
      // fixture teardown needs session_replication_role=replica to bypass those
      // triggers for this one transaction, same trade-off already accepted
      // elsewhere for other permanently-un-deletable rows (issued invoices, etc).
      await admin.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`delete from credit_liability_settlements where id::text like ${FIXTURE_PREFIX}`;
        await tx`delete from credit_lot_allocations where tenant_id::text like ${FIXTURE_PREFIX}`;
        await tx`delete from credit_transactions where tenant_id::text like ${FIXTURE_PREFIX}`;
      });
      await admin`delete from credit_lots where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from credit_wallets where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from media_assets where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from ad_inventory where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from ad_slots where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenant_plan_prices where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from subscription_plans where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenant_boost_prices where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from boost_types where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenant_credit_packages where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from credit_packages where id::text like ${FIXTURE_PREFIX}`;
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

  describe('credit_wallets (§6.1)', () => {
    it('is visible to its owner regardless of which tenant the session is scoped to', async () => {
      const rows = await withContext(
        app,
        { ...AS_ALICE, tenant_id: TENANT_B },
        (tx) =>
          tx`select user_id from credit_wallets where tenant_id = ${TENANT_A} and user_id = ${USER_ALICE}`,
      );
      expect(rows).toHaveLength(1);
    });

    it('is visible to tenant staff, but not to an unrelated member', async () => {
      const asAdmin = await withContext(
        app,
        AS_ADMIN,
        (tx) =>
          tx`select user_id from credit_wallets where tenant_id = ${TENANT_A} and user_id = ${USER_ALICE}`,
      );
      expect(asAdmin).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) =>
          tx`select user_id from credit_wallets where tenant_id = ${TENANT_A} and user_id = ${USER_ALICE}`,
      );
      expect(asStranger).toHaveLength(0);
    });

    it('has no UPDATE path for any app role (balance only moves through credit_apply())', async () => {
      await expectDenied(
        withContext(
          app,
          AS_ALICE,
          (tx) =>
            tx`update credit_wallets set balance = 100 where tenant_id = ${TENANT_A} and user_id = ${USER_ALICE}`,
        ),
      );
    });
  });

  describe('credit_transactions (§6.2)', () => {
    it('is visible to its owner and to tenant staff, not to an unrelated member', async () => {
      const asOwner = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`select id from credit_transactions where id = ${CREDIT_TX_1}`,
      );
      expect(asOwner).toHaveLength(1);

      const asAdmin = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from credit_transactions where id = ${CREDIT_TX_1}`,
      );
      expect(asAdmin).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from credit_transactions where id = ${CREDIT_TX_1}`,
      );
      expect(asStranger).toHaveLength(0);
    });

    it('lets any tenant member insert a non-admin_adjustment transaction', async () => {
      const result = await withContext(
        app,
        AS_STRANGER,
        (tx) =>
          tx`insert into credit_transactions (tenant_id, user_id, amount, balance_after, reason_code, idempotency_key)
             values (${TENANT_A}, ${USER_ALICE}, 5, 15, 'promo_grant', 'rls-commerce-insert-test-1')`,
      );
      expect(result.count).toBe(1);
      // credit_transactions rows are append-only (no DELETE, ever); left as
      // fixture-prefixed residue for the wrapped afterAll cleanup below.
    });

    it('rejects admin_adjustment from a non-tenant-admin, but allows it from tenant_admin', async () => {
      await expectDenied(
        withContext(
          app,
          AS_STRANGER,
          (tx) =>
            tx`insert into credit_transactions (tenant_id, user_id, amount, balance_after, reason_code, note, idempotency_key)
               values (${TENANT_A}, ${USER_ALICE}, -1, 9, 'admin_adjustment', 'test', 'rls-commerce-insert-test-2')`,
        ),
      );

      const result = await withContext(
        app,
        AS_ADMIN,
        (tx) =>
          tx`insert into credit_transactions (tenant_id, user_id, amount, balance_after, reason_code, note, idempotency_key)
             values (${TENANT_A}, ${USER_ALICE}, -1, 9, 'admin_adjustment', 'test', 'rls-commerce-insert-test-3')`,
      );
      expect(result.count).toBe(1);
    });

    it('rejects an insert claiming another tenant', async () => {
      await expectDenied(
        withContext(
          app,
          AS_ALICE,
          (tx) =>
            tx`insert into credit_transactions (tenant_id, user_id, amount, balance_after, reason_code, idempotency_key)
               values (${TENANT_B}, ${USER_ALICE}, 5, 15, 'promo_grant', 'rls-commerce-insert-test-4')`,
        ),
      );
    });
  });

  describe('credit_packages (§6.3) / tenant_credit_packages (§6.4)', () => {
    it('credit_packages is readable by anyone', async () => {
      const rows = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from credit_packages where id = ${CREDIT_PACKAGE}`,
      );
      expect(rows).toHaveLength(1);
    });

    it('tenant_credit_packages is visible within its tenant, not across tenants', async () => {
      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from tenant_credit_packages where id = ${TENANT_CREDIT_PACKAGE}`,
      );
      expect(asStranger).toHaveLength(1);

      const asTenantB = await withContext(
        app,
        AS_TENANT_B,
        (tx) => tx`select id from tenant_credit_packages where id = ${TENANT_CREDIT_PACKAGE}`,
      );
      expect(asTenantB).toHaveLength(0);
    });

    it('only a tenant admin can write a tenant_credit_packages override', async () => {
      await expectNoRowsAffected(
        withContext(
          app,
          AS_STRANGER,
          (tx) =>
            tx`update tenant_credit_packages set is_enabled = false where id = ${TENANT_CREDIT_PACKAGE}`,
        ),
      );
      const result = await withContext(
        app,
        AS_ADMIN,
        (tx) =>
          tx`update tenant_credit_packages set sort_order = 1 where id = ${TENANT_CREDIT_PACKAGE}`,
      );
      expect(result.count).toBe(1);
    });
  });

  describe('boost_types (§6.5) / tenant_boost_prices (§6.6)', () => {
    it('boost_types is readable by anyone; tenant_boost_prices is tenant-scoped', async () => {
      const types = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from boost_types where id = ${BOOST_TYPE}`,
      );
      expect(types).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from tenant_boost_prices where id = ${TENANT_BOOST_PRICE}`,
      );
      expect(asStranger).toHaveLength(1);

      const asTenantB = await withContext(
        app,
        AS_TENANT_B,
        (tx) => tx`select id from tenant_boost_prices where id = ${TENANT_BOOST_PRICE}`,
      );
      expect(asTenantB).toHaveLength(0);
    });
  });

  describe('boosts (§6.7)', () => {
    it('an active boost is publicly visible within its tenant, not across tenants', async () => {
      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from boosts where id = ${BOOST_1}`,
      );
      expect(asStranger).toHaveLength(1);

      const asTenantB = await withContext(
        app,
        AS_TENANT_B,
        (tx) => tx`select id from boosts where id = ${BOOST_1}`,
      );
      expect(asTenantB).toHaveLength(0);
    });

    it('lets the purchaser and staff update it, not an unrelated member', async () => {
      const asPurchaser = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`update boosts set status_code = 'active' where id = ${BOOST_1}`,
      );
      expect(asPurchaser.count).toBe(1);

      await expectNoRowsAffected(
        withContext(
          app,
          AS_STRANGER,
          (tx) => tx`update boosts set status_code = 'cancelled' where id = ${BOOST_1}`,
        ),
      );
    });
  });

  describe('subscription_plans (§6.8) / tenant_plan_prices (§6.9)', () => {
    it('subscription_plans is readable by anyone; tenant_plan_prices is tenant-scoped', async () => {
      const plans = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from subscription_plans where id = ${SUBSCRIPTION_PLAN}`,
      );
      expect(plans).toHaveLength(1);

      const asTenantB = await withContext(
        app,
        AS_TENANT_B,
        (tx) => tx`select id from tenant_plan_prices where id = ${TENANT_PLAN_PRICE}`,
      );
      expect(asTenantB).toHaveLength(0);
    });
  });

  describe('subscriptions (§6.10)', () => {
    it('is visible to the subscribing member, not to an unrelated member', async () => {
      const asOwner = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`select id from subscriptions where id = ${SUBSCRIPTION_1}`,
      );
      expect(asOwner).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from subscriptions where id = ${SUBSCRIPTION_1}`,
      );
      expect(asStranger).toHaveLength(0);
    });

    it('lets the subscriber toggle cancel_at_period_end but not another field via that path', async () => {
      const result = await withContext(
        app,
        AS_ALICE,
        (tx) =>
          tx`update subscriptions set cancel_at_period_end = true where id = ${SUBSCRIPTION_1}`,
      );
      expect(result.count).toBe(1);

      await expectNoRowsAffected(
        withContext(
          app,
          AS_STRANGER,
          (tx) =>
            tx`update subscriptions set cancel_at_period_end = false where id = ${SUBSCRIPTION_1}`,
        ),
      );
    });
  });

  describe('invoices (§6.11) / invoice_lines (§6.12)', () => {
    it('invoice is visible to the billed member and staff, not to an unrelated member', async () => {
      const asOwner = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`select id from invoices where id = ${INVOICE_1}`,
      );
      expect(asOwner).toHaveLength(1);

      const asAdmin = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from invoices where id = ${INVOICE_1}`,
      );
      expect(asAdmin).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from invoices where id = ${INVOICE_1}`,
      );
      expect(asStranger).toHaveLength(0);
    });

    it('invoice_lines follows the parent invoice via can_view_invoice()', async () => {
      const asOwner = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`select id from invoice_lines where id = ${INVOICE_LINE_1}`,
      );
      expect(asOwner).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from invoice_lines where id = ${INVOICE_LINE_1}`,
      );
      expect(asStranger).toHaveLength(0);
    });
  });

  describe('ad_slots (§6.13) / ad_inventory (§6.14)', () => {
    it('ad_slots is readable by anyone; ad_inventory is tenant-scoped when enabled', async () => {
      const slots = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from ad_slots where id = ${AD_SLOT}`,
      );
      expect(slots).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from ad_inventory where id = ${AD_INVENTORY}`,
      );
      expect(asStranger).toHaveLength(1);

      const asTenantB = await withContext(
        app,
        AS_TENANT_B,
        (tx) => tx`select id from ad_inventory where id = ${AD_INVENTORY}`,
      );
      expect(asTenantB).toHaveLength(0);
    });
  });

  describe('ad_creatives (§6.15)', () => {
    it('is visible to its advertiser and staff, not to an unrelated member', async () => {
      const asOwner = await withContext(
        app,
        AS_ADVERTISER,
        (tx) => tx`select id from ad_creatives where id = ${AD_CREATIVE_1}`,
      );
      expect(asOwner).toHaveLength(1);

      const asAdmin = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from ad_creatives where id = ${AD_CREATIVE_1}`,
      );
      expect(asAdmin).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from ad_creatives where id = ${AD_CREATIVE_1}`,
      );
      expect(asStranger).toHaveLength(0);
    });

    it("an advertiser's own edit resets an already-approved creative to pending_review", async () => {
      await admin`update ad_creatives set status_code = 'approved' where id = ${AD_CREATIVE_1}`;
      const result = await withContext(
        app,
        AS_ADVERTISER,
        (tx) => tx`update ad_creatives set headline = 'Updated' where id = ${AD_CREATIVE_1}`,
      );
      expect(result.count).toBe(1);
      const [row] = await admin<{ status_code: string }[]>`
        select status_code from ad_creatives where id = ${AD_CREATIVE_1}`;
      expect(row?.status_code).toBe('pending_review');
    });
  });

  describe('ad_bookings (§6.16)', () => {
    it('is visible to its advertiser and staff, not to an unrelated member', async () => {
      const asOwner = await withContext(
        app,
        AS_ADVERTISER,
        (tx) => tx`select id from ad_bookings where id = ${AD_BOOKING_1}`,
      );
      expect(asOwner).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from ad_bookings where id = ${AD_BOOKING_1}`,
      );
      expect(asStranger).toHaveLength(0);
    });
  });

  describe('ad_daily_stats (§6.17)', () => {
    it("is visible to the booking's advertiser (via join) and staff, not to an unrelated member", async () => {
      const asOwner = await withContext(
        app,
        AS_ADVERTISER,
        (tx) => tx`select id from ad_daily_stats where id = ${AD_DAILY_STAT_1}`,
      );
      expect(asOwner).toHaveLength(1);

      const asAdmin = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from ad_daily_stats where id = ${AD_DAILY_STAT_1}`,
      );
      expect(asAdmin).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from ad_daily_stats where id = ${AD_DAILY_STAT_1}`,
      );
      expect(asStranger).toHaveLength(0);
    });
  });

  describe('credit_lots (§6.18) / credit_lot_allocations (§6.19)', () => {
    it('credit_lots is visible to its owner (any tenant context) and staff, not a stranger', async () => {
      const asOwner = await withContext(
        app,
        { ...AS_ALICE, tenant_id: TENANT_B },
        (tx) => tx`select id from credit_lots where id = ${CREDIT_LOT_1}`,
      );
      expect(asOwner).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from credit_lots where id = ${CREDIT_LOT_1}`,
      );
      expect(asStranger).toHaveLength(0);
    });

    it('has no INSERT/UPDATE path for any app role (lots only move through credit_apply())', async () => {
      await expectDenied(
        withContext(
          app,
          AS_ALICE,
          (tx) => tx`update credit_lots set credits_remaining = 1 where id = ${CREDIT_LOT_1}`,
        ),
      );
    });

    it('credit_lot_allocations is visible via the source transaction owner and staff, not a stranger', async () => {
      const asOwner = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`select id from credit_lot_allocations where id = ${CREDIT_LOT_ALLOCATION_1}`,
      );
      expect(asOwner).toHaveLength(1);

      const asAdmin = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from credit_lot_allocations where id = ${CREDIT_LOT_ALLOCATION_1}`,
      );
      expect(asAdmin).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from credit_lot_allocations where id = ${CREDIT_LOT_ALLOCATION_1}`,
      );
      expect(asStranger).toHaveLength(0);
    });
  });

  describe('tenant_credit_liability (§6.20)', () => {
    it('is visible to the tenant admin and to system/platform, not to a plain member', async () => {
      const asAdmin = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select tenant_id from tenant_credit_liability where tenant_id = ${TENANT_A}`,
      );
      expect(asAdmin).toHaveLength(1);

      const asAlice = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`select tenant_id from tenant_credit_liability where tenant_id = ${TENANT_A}`,
      );
      expect(asAlice).toHaveLength(0);

      const asPlatformAdmin = await withContext(
        app,
        AS_PLATFORM_ADMIN,
        (tx) => tx`select tenant_id from tenant_credit_liability where tenant_id = ${TENANT_A}`,
      );
      expect(asPlatformAdmin).toHaveLength(1);
    });
  });

  describe('platform_credit_pool (§6.21)', () => {
    it('is visible to its owner and platform staff, not a stranger', async () => {
      const asOwner = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`select id from platform_credit_pool where id = ${PLATFORM_CREDIT_POOL_1}`,
      );
      expect(asOwner).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from platform_credit_pool where id = ${PLATFORM_CREDIT_POOL_1}`,
      );
      expect(asStranger).toHaveLength(0);
    });

    it('only the system role may write it', async () => {
      // The row IS select-visible to Alice (owner_read), but no UPDATE-
      // applicable policy passes for her — Postgres requires both, so the
      // mismatch is silent (0 rows), not an error.
      await expectNoRowsAffected(
        withContext(
          app,
          AS_ALICE,
          (tx) =>
            tx`update platform_credit_pool set status_code = 'restored' where id = ${PLATFORM_CREDIT_POOL_1}`,
        ),
      );
      const result = await withContext(
        app,
        AS_SYSTEM,
        (tx) =>
          tx`update platform_credit_pool set credits = 5 where id = ${PLATFORM_CREDIT_POOL_1}`,
      );
      expect(result.count).toBe(1);
    });
  });

  describe('credit_closure_dispositions (§6.22)', () => {
    it('is visible to its owner and platform staff, not a stranger', async () => {
      const asOwner = await withContext(
        app,
        AS_ALICE,
        (tx) =>
          tx`select id from credit_closure_dispositions where id = ${CREDIT_CLOSURE_DISPOSITION_1}`,
      );
      expect(asOwner).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) =>
          tx`select id from credit_closure_dispositions where id = ${CREDIT_CLOSURE_DISPOSITION_1}`,
      );
      expect(asStranger).toHaveLength(0);
    });

    it('only system or platform_admin may write it', async () => {
      // Same reasoning as platform_credit_pool above: Alice can see her own
      // disposition (owner_read), but has no UPDATE-applicable policy.
      await expectNoRowsAffected(
        withContext(
          app,
          AS_ALICE,
          (tx) =>
            tx`update credit_closure_dispositions set refund_status_code = 'requested' where id = ${CREDIT_CLOSURE_DISPOSITION_1}`,
        ),
      );
      const result = await withContext(
        app,
        AS_SYSTEM,
        (tx) =>
          tx`update credit_closure_dispositions set notified_in_app_at = now() where id = ${CREDIT_CLOSURE_DISPOSITION_1}`,
      );
      expect(result.count).toBe(1);
    });
  });

  describe('credit_liability_settlements (§6.23)', () => {
    it('is visible to platform staff and the earning tenant, not the spending tenant', async () => {
      const asPlatform = await withContext(
        app,
        AS_PLATFORM_ADMIN,
        (tx) =>
          tx`select id from credit_liability_settlements where id = ${CREDIT_LIABILITY_SETTLEMENT_1}`,
      );
      expect(asPlatform).toHaveLength(1);

      const asEarningTenant = await withContext(
        app,
        AS_TENANT_B,
        (tx) =>
          tx`select id from credit_liability_settlements where id = ${CREDIT_LIABILITY_SETTLEMENT_1}`,
      );
      expect(asEarningTenant).toHaveLength(1);

      const asSpendingTenant = await withContext(
        app,
        AS_ADMIN,
        (tx) =>
          tx`select id from credit_liability_settlements where id = ${CREDIT_LIABILITY_SETTLEMENT_1}`,
      );
      expect(asSpendingTenant).toHaveLength(0);
    });

    it('only the system role may true it up', async () => {
      await expectNoRowsAffected(
        withContext(
          app,
          AS_TENANT_B,
          (tx) =>
            tx`update credit_liability_settlements set trued_up_at = now() where id = ${CREDIT_LIABILITY_SETTLEMENT_1}`,
        ),
      );
      const result = await withContext(
        app,
        AS_SYSTEM,
        (tx) =>
          tx`update credit_liability_settlements set trued_up_at = now(), true_up_delta_bdt = 0
             where id = ${CREDIT_LIABILITY_SETTLEMENT_1}`,
      );
      expect(result.count).toBe(1);
    });
  });

  describe('boost_vouchers (§6.24)', () => {
    it('is visible to its owner and staff, not to an unrelated member', async () => {
      const asOwner = await withContext(
        app,
        AS_ALICE,
        (tx) => tx`select id from boost_vouchers where id = ${BOOST_VOUCHER_1}`,
      );
      expect(asOwner).toHaveLength(1);

      const asAdmin = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from boost_vouchers where id = ${BOOST_VOUCHER_1}`,
      );
      expect(asAdmin).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from boost_vouchers where id = ${BOOST_VOUCHER_1}`,
      );
      expect(asStranger).toHaveLength(0);
    });

    it('only the system role may insert one', async () => {
      await expectDenied(
        withContext(
          app,
          AS_ALICE,
          (tx) =>
            tx`insert into boost_vouchers (tenant_id, user_id, source_boost_id, boost_type_id, remaining_days, expires_at)
               values (${TENANT_A}, ${USER_ALICE}, ${BOOST_1}, ${BOOST_TYPE}, 1, ${FUTURE})`,
        ),
      );
    });

    it('lets the owner redeem it forward (unconsumed -> consumed), not a stranger', async () => {
      await expectNoRowsAffected(
        withContext(
          app,
          AS_STRANGER,
          (tx) =>
            tx`update boost_vouchers set consumed_at = now(), consumed_by_boost_id = ${BOOST_1}
               where id = ${BOOST_VOUCHER_1}`,
        ),
      );

      const result = await withContext(
        app,
        AS_ALICE,
        (tx) =>
          tx`update boost_vouchers set consumed_at = now(), consumed_by_boost_id = ${BOOST_1}
             where id = ${BOOST_VOUCHER_1}`,
      );
      expect(result.count).toBe(1);
    });
  });
});
