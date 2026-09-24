import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * RLS coverage for the payments & revenue domain (0008_payments_revenue.sql):
 * payments, payment_events, refunds, the revenue-share scheme/slab pricing
 * tables, tenant_revenue_overrides, the settlement calendar and per-tenant
 * statements, the settlement ledger, payouts, tenant_final_settlement, and
 * platform_share_rate_backfills. Same style as rls-commerce.db-spec.ts. The
 * genuinely novel triggers (deferred journal-balance check, settlement/
 * refund tenant-consistency, immutability) were already exercised directly
 * against the dev DB via psql while drafting the migration; this file is
 * about the RLS visibility/write boundaries specifically.
 */

const PARTNER = '0191e3a0-8008-7000-8000-000000000001';
const GEO_AREA_A = '0191e3a0-8008-7000-8000-000000000011';
const GEO_AREA_B = '0191e3a0-8008-7000-8000-000000000012';
const TENANT_A = '0191e3a0-8008-7000-8000-000000000021';
const TENANT_B = '0191e3a0-8008-7000-8000-000000000022';
const USER_PAYER = '0191e3a0-8008-7000-8000-000000000031';
const USER_ADMIN = '0191e3a0-8008-7000-8000-000000000032';
const USER_STRANGER = '0191e3a0-8008-7000-8000-000000000033';
const USER_B = '0191e3a0-8008-7000-8000-000000000034';
const MEMBER_PAYER = '0191e3a0-8008-7000-8000-000000000041';
const MEMBER_ADMIN = '0191e3a0-8008-7000-8000-000000000042';
const MEMBER_STRANGER = '0191e3a0-8008-7000-8000-000000000043';
const MEMBER_B = '0191e3a0-8008-7000-8000-000000000044';

const INVOICE_A = '0191e3a0-8008-7000-8000-000000000051';
const PAYMENT_TENANT = '0191e3a0-8008-7000-8000-000000000061';
const PAYMENT_CASH = '0191e3a0-8008-7000-8000-000000000062';
const PAYMENT_PLATFORM = '0191e3a0-8008-7000-8000-000000000063';
const PAYMENT_EVENT_1 = '0191e3a0-8008-7000-8000-000000000071';
const REFUND_1 = '0191e3a0-8008-7000-8000-000000000081';

const SCHEME_1 = '0191e3a0-8008-7000-8000-000000000091';
const SLAB_1 = '0191e3a0-8008-7000-8000-000000000092';
const OVERRIDE_1 = '0191e3a0-8008-7000-8000-0000000000a1';
const PERIOD_1 = '0191e3a0-8008-7000-8000-0000000000b1';
const SETTLEMENT_1 = '0191e3a0-8008-7000-8000-0000000000c1';
const PAYOUT_ACCOUNT_1 = '0191e3a0-8008-7000-8000-0000000000d1';
const PAYOUT_1 = '0191e3a0-8008-7000-8000-0000000000d2';
const JOURNAL_1 = '0191e3a0-8008-7000-8000-0000000000e0';
const LEDGER_1 = '0191e3a0-8008-7000-8000-0000000000e1';
const LEDGER_2 = '0191e3a0-8008-7000-8000-0000000000e2';
const FINAL_SETTLEMENT_1 = '0191e3a0-8008-7000-8000-0000000000f1';
const BACKFILL_1 = '0191e3a0-8008-7000-8000-000000000101';

const FIXTURE_PREFIX = '0191e3a0-8008-7000-8000-%';

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

const AS_PAYER: Context = {
  tenant_id: TENANT_A,
  user_id: USER_PAYER,
  member_id: MEMBER_PAYER,
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
const AS_PLATFORM_FINANCE: Context = { role: 'platform_finance' };

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

describe('Row level security: payments & revenue domain (0008)', () => {
  let app: Sql;
  let admin: Sql;

  beforeAll(async () => {
    app = testSqlClient(4, resolveTestAppDatabaseUrl());
    admin = testSqlClient(1, resolveTestDatabaseUrl());

    await admin`delete from users where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from revenue_share_schemes where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from settlement_periods where id::text like ${FIXTURE_PREFIX}`;
    // Ad-hoc rows inserted by individual tests get a real generated id (not
    // fixture-prefixed), so match payments/refunds via their idempotency_key
    // instead — every one used in this file starts with 'rls-payments-'.
    await admin`delete from refunds where idempotency_key LIKE 'rls-payments-%'`;
    await admin`delete from payment_events where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from payments where idempotency_key LIKE 'rls-payments-%'`;

    await admin`
      insert into users (id, phone_e164) values
        (${USER_PAYER}, '+8801766000001'),
        (${USER_ADMIN}, '+8801766000002'),
        (${USER_STRANGER}, '+8801766000003'),
        (${USER_B}, '+8801766000004')`;

    await admin`
      insert into partners (id, legal_name, display_name, phone_e164) values
        (${PARTNER}, 'Payments Fixture Partner', 'Payments Fixture Partner', '+8801766000099')`;

    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
        (${GEO_AREA_A}, 3, 'upazila', 'rls-payments-a', 'RLS Payments Area A', 'fixture'),
        (${GEO_AREA_B}, 3, 'upazila', 'rls-payments-b', 'RLS Payments Area B', 'fixture')`;

    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
        (${TENANT_A}, ${PARTNER}, ${GEO_AREA_A}, 'rls-payments-tenant-a', 'এ', 'A',
          st_point(90.4, 23.8)::geography, 'active'),
        (${TENANT_B}, ${PARTNER}, ${GEO_AREA_B}, 'rls-payments-tenant-b', 'বি', 'B',
          st_point(90.5, 23.9)::geography, 'active')`;

    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${MEMBER_PAYER}, ${TENANT_A}, ${USER_PAYER}, 'member'),
        (${MEMBER_ADMIN}, ${TENANT_A}, ${USER_ADMIN}, 'tenant_admin'),
        (${MEMBER_STRANGER}, ${TENANT_A}, ${USER_STRANGER}, 'member'),
        (${MEMBER_B}, ${TENANT_B}, ${USER_B}, 'tenant_admin')`;

    await admin`
      insert into invoices (id, tenant_id, invoice_number, billed_member_id, seller_bin, fiscal_year, tax_invoice_format_code)
      values (${INVOICE_A}, ${TENANT_A}, 'RLS-PAYMENTS-0001', ${MEMBER_PAYER}, '1234567890123', '2026-01', 'standard')`;

    await admin`
      insert into payments (id, tenant_id, invoice_id, payer_user_id, provider_code, amount, idempotency_key) values
        (${PAYMENT_TENANT}, ${TENANT_A}, ${INVOICE_A}, ${USER_PAYER}, 'bkash', 100.00, 'rls-payments-fixture-1'),
        (${PAYMENT_CASH}, ${TENANT_A}, ${INVOICE_A}, ${USER_PAYER}, 'cash_agent', 50.00, 'rls-payments-fixture-2')`;
    await admin`
      insert into payments (id, tenant_id, payer_user_id, provider_code, amount, idempotency_key) values
        (${PAYMENT_PLATFORM}, null, ${USER_PAYER}, 'sslcommerz', 25.00, 'rls-payments-fixture-3')`;

    await admin`
      insert into payment_events (id, payment_id, provider_code, direction_code, event_type, payload) values
        (${PAYMENT_EVENT_1}, ${PAYMENT_TENANT}, 'bkash', 'inbound_webhook', 'payment.success', '{}')`;

    await admin`
      insert into refunds (id, payment_id, amount, reason_code, due_by, requested_by_user_id, idempotency_key) values
        (${REFUND_1}, ${PAYMENT_TENANT}, 10.00, 'goodwill', now() + interval '10 days', ${USER_PAYER}, 'rls-payments-refund-1')`;

    await admin`
      insert into revenue_share_schemes (id, code, name, effective_from) values
        (${SCHEME_1}, 'rls-payments-scheme', 'RLS Payments Scheme', '2026-01-01')`;
    await admin`
      insert into revenue_share_slabs (id, scheme_id, lower_bound, partner_share_pct) values
        (${SLAB_1}, ${SCHEME_1}, 0, 70)`;
    await admin`
      insert into tenant_revenue_overrides (id, tenant_id, flat_partner_share_pct, effective_from, reason, approved_by_user_id) values
        (${OVERRIDE_1}, ${TENANT_A}, 90, '2026-01-01', 'launch incentive', ${USER_ADMIN})`;

    await admin`
      insert into settlement_periods (id, period_start, period_end) values
        (${PERIOD_1}, '2026-02-01', '2026-02-28')`;
    await admin`
      insert into settlements (id, tenant_id, settlement_period_id, partner_id) values
        (${SETTLEMENT_1}, ${TENANT_A}, ${PERIOD_1}, ${PARTNER})`;

    await admin`
      insert into partner_payout_accounts
        (id, partner_id, method_code, account_name, account_number_ciphertext, account_number_last4, bank_name)
      values (${PAYOUT_ACCOUNT_1}, ${PARTNER}, 'bank_transfer', 'Fixture Account', 'ciphertext', '1234', 'Fixture Bank')`;
    await admin`
      insert into payouts
        (id, tenant_id, settlement_id, partner_payout_account_id, amount, method_code, initiated_by_user_id)
      values (${PAYOUT_1}, ${TENANT_A}, ${SETTLEMENT_1}, ${PAYOUT_ACCOUNT_1}, 70.00, 'bank_transfer', ${USER_ADMIN})`;

    await admin`
      insert into settlement_ledger_entries
        (id, tenant_id, journal_id, partner_id, account_code, amount, occurred_at, idempotency_key)
      values
        (${LEDGER_1}, ${TENANT_A}, ${JOURNAL_1}, ${PARTNER}, 'customer_receipts', 100.00, now(), 'rls-payments-ledger-1'),
        (${LEDGER_2}, ${TENANT_A}, ${JOURNAL_1}, ${PARTNER}, 'platform_revenue', -100.00, now(), 'rls-payments-ledger-2')`;

    await admin`
      insert into tenant_final_settlement (id, tenant_id, partner_id, closure_type_code, cutoff_at) values
        (${FINAL_SETTLEMENT_1}, ${TENANT_A}, ${PARTNER}, 'termination', now())`;

    await admin`
      insert into platform_share_rate_backfills
        (id, tenant_id, settlement_period_id, credit_basis_bdt, ledger_platform_share_bdt, blended_rate_exact,
         platform_share_rate_final, allocated_platform_share_bdt, transactions_updated)
      values (${BACKFILL_1}, ${TENANT_A}, ${PERIOD_1}, 1000.00, 300.00, 0.3, 0.30000000, 300.00, 5)`;
  });

  afterAll(async () => {
    try {
      await admin`delete from platform_share_rate_backfills where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenant_final_settlement where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`delete from settlement_ledger_entries where tenant_id::text like ${FIXTURE_PREFIX}`;
      });
      await admin`delete from payouts where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from partner_payout_accounts where id::text like ${FIXTURE_PREFIX}`;
      // The "becomes immutable once approved" test sets approved_at on
      // SETTLEMENT_1, which blocks a plain DELETE (settlements_a_prevent_
      // mutation_after_approval fires for every role, including this
      // superuser connection) — same session_replication_role=replica
      // workaround as 0007's immutable-table cleanup.
      await admin.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`delete from settlements where tenant_id::text like ${FIXTURE_PREFIX}`;
      });
      await admin`delete from settlement_periods where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenant_revenue_overrides where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from revenue_share_slabs where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from revenue_share_schemes where id::text like ${FIXTURE_PREFIX}`;
      // Ad-hoc rows inserted by individual tests get a real generated id (not
      // fixture-prefixed), so match payments/refunds via their idempotency_key
      // instead — every one used in this file starts with 'rls-payments-'.
      await admin`delete from refunds where idempotency_key LIKE 'rls-payments-%'`;
      await admin`delete from payment_events where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from payments where idempotency_key LIKE 'rls-payments-%'`;
      await admin`delete from invoices where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenant_members where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from users where id::text like ${FIXTURE_PREFIX}`;
    } finally {
      await Promise.all([app.end(), admin.end()]);
    }
  });

  describe('payments (§7.1)', () => {
    it('is visible to its payer regardless of session tenant context, not to an unrelated user', async () => {
      const asPayer = await withContext(
        app,
        { ...AS_PAYER, tenant_id: TENANT_B },
        (tx) => tx`select id from payments where id = ${PAYMENT_TENANT}`,
      );
      expect(asPayer).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from payments where id = ${PAYMENT_TENANT}`,
      );
      expect(asStranger).toHaveLength(0);
    });

    it('is visible to tenant staff and platform/system, not across tenants', async () => {
      const asAdmin = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from payments where id = ${PAYMENT_TENANT}`,
      );
      expect(asAdmin).toHaveLength(1);

      const asSystem = await withContext(
        app,
        AS_SYSTEM,
        (tx) => tx`select id from payments where id = ${PAYMENT_TENANT}`,
      );
      expect(asSystem).toHaveLength(1);

      const asTenantB = await withContext(
        app,
        AS_TENANT_B,
        (tx) => tx`select id from payments where id = ${PAYMENT_TENANT}`,
      );
      expect(asTenantB).toHaveLength(0);
    });

    it('lets an authenticated user insert their own payment, not one claiming another payer', async () => {
      const result = await withContext(
        app,
        AS_PAYER,
        (tx) =>
          tx`insert into payments (tenant_id, invoice_id, payer_user_id, provider_code, amount, idempotency_key)
             values (${TENANT_A}, ${INVOICE_A}, ${USER_PAYER}, 'nagad', 15.00, 'rls-payments-insert-test-1')`,
      );
      expect(result.count).toBe(1);

      await expectDenied(
        withContext(
          app,
          AS_PAYER,
          (tx) =>
            tx`insert into payments (tenant_id, invoice_id, payer_user_id, provider_code, amount, idempotency_key)
               values (${TENANT_A}, ${INVOICE_A}, ${USER_STRANGER}, 'nagad', 15.00, 'rls-payments-insert-test-2')`,
        ),
      );
    });

    it('lets tenant staff record a cash/bank payment, not a plain member', async () => {
      const result = await withContext(
        app,
        AS_ADMIN,
        (tx) =>
          tx`insert into payments (tenant_id, invoice_id, payer_user_id, provider_code, amount, idempotency_key)
             values (${TENANT_A}, ${INVOICE_A}, ${USER_PAYER}, 'cash_agent', 20.00, 'rls-payments-insert-test-3')`,
      );
      expect(result.count).toBe(1);

      await expectDenied(
        withContext(
          app,
          AS_STRANGER,
          (tx) =>
            tx`insert into payments (tenant_id, invoice_id, payer_user_id, provider_code, amount, idempotency_key)
               values (${TENANT_A}, ${INVOICE_A}, ${USER_PAYER}, 'cash_agent', 20.00, 'rls-payments-insert-test-4')`,
        ),
      );
    });

    it('lets platform_finance insert a platform-level payment, not a tenant_admin', async () => {
      const result = await withContext(
        app,
        AS_PLATFORM_FINANCE,
        (tx) =>
          tx`insert into payments (tenant_id, payer_user_id, provider_code, amount, idempotency_key)
             values (null, ${USER_PAYER}, 'sslcommerz', 5.00, 'rls-payments-insert-test-5')`,
      );
      expect(result.count).toBe(1);

      await expectDenied(
        withContext(
          app,
          AS_ADMIN,
          (tx) =>
            tx`insert into payments (tenant_id, payer_user_id, provider_code, amount, idempotency_key)
               values (null, ${USER_PAYER}, 'sslcommerz', 5.00, 'rls-payments-insert-test-6')`,
        ),
      );
    });

    it('lets system update any payment, and a tenant_admin confirm a cash/bank one', async () => {
      const asSystem = await withContext(
        app,
        AS_SYSTEM,
        (tx) =>
          tx`update payments set status_code = 'succeeded', succeeded_at = now() where id = ${PAYMENT_TENANT}`,
      );
      expect(asSystem.count).toBe(1);

      const asAdmin = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`update payments set status_code = 'succeeded' where id = ${PAYMENT_CASH}`,
      );
      expect(asAdmin.count).toBe(1);

      await expectNoRowsAffected(
        withContext(
          app,
          AS_STRANGER,
          (tx) => tx`update payments set status_code = 'cancelled' where id = ${PAYMENT_TENANT}`,
        ),
      );
    });
  });

  describe('payment_events (§7.2)', () => {
    it('is system-only: no other role, not even platform_admin, can read or write it', async () => {
      const asSystem = await withContext(
        app,
        AS_SYSTEM,
        (tx) => tx`select id from payment_events where id = ${PAYMENT_EVENT_1}`,
      );
      expect(asSystem).toHaveLength(1);

      const asAdmin = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from payment_events where id = ${PAYMENT_EVENT_1}`,
      );
      expect(asAdmin).toHaveLength(0);

      const asPlatformAdmin = await withContext(
        app,
        AS_PLATFORM_ADMIN,
        (tx) => tx`select id from payment_events where id = ${PAYMENT_EVENT_1}`,
      );
      expect(asPlatformAdmin).toHaveLength(0);

      await expectDenied(
        withContext(
          app,
          AS_ADMIN,
          (tx) =>
            tx`insert into payment_events (provider_code, direction_code, event_type, payload)
               values ('bkash', 'poll', 'poll.check', '{}')`,
        ),
      );
    });
  });

  describe('refunds (§7.3)', () => {
    it("follows the underlying payment's own RLS: its payer sees it, a stranger doesn't", async () => {
      const asPayer = await withContext(
        app,
        AS_PAYER,
        (tx) => tx`select id from refunds where id = ${REFUND_1}`,
      );
      expect(asPayer).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from refunds where id = ${REFUND_1}`,
      );
      expect(asStranger).toHaveLength(0);
    });

    it("lets the payment's tenant_admin insert a refund, not another tenant's admin", async () => {
      const result = await withContext(
        app,
        AS_ADMIN,
        (tx) =>
          tx`insert into refunds (payment_id, amount, reason_code, due_by, requested_by_user_id, idempotency_key)
             values (${PAYMENT_TENANT}, 5.00, 'goodwill', now() + interval '10 days', ${USER_ADMIN}, 'rls-payments-refund-insert-1')`,
      );
      expect(result.count).toBe(1);

      await expectDenied(
        withContext(
          app,
          AS_TENANT_B,
          (tx) =>
            tx`insert into refunds (payment_id, amount, reason_code, due_by, requested_by_user_id, idempotency_key)
               values (${PAYMENT_TENANT}, 5.00, 'goodwill', now() + interval '10 days', ${USER_B}, 'rls-payments-refund-insert-2')`,
        ),
      );
    });

    it('lets the tenant_admin update it, not an unrelated member', async () => {
      const result = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`update refunds set note = 'reviewed' where id = ${REFUND_1}`,
      );
      expect(result.count).toBe(1);

      await expectNoRowsAffected(
        withContext(
          app,
          AS_STRANGER,
          (tx) => tx`update refunds set note = 'hijacked' where id = ${REFUND_1}`,
        ),
      );
    });
  });

  describe('revenue_share_schemes (§7.4) / revenue_share_slabs (§7.5)', () => {
    it('is readable by any tenant_admin (transparency), not a plain member', async () => {
      const schemeAsAdmin = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from revenue_share_schemes where id = ${SCHEME_1}`,
      );
      expect(schemeAsAdmin).toHaveLength(1);

      const schemeAsOtherTenantAdmin = await withContext(
        app,
        AS_TENANT_B,
        (tx) => tx`select id from revenue_share_schemes where id = ${SCHEME_1}`,
      );
      expect(schemeAsOtherTenantAdmin).toHaveLength(1);

      const schemeAsStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from revenue_share_schemes where id = ${SCHEME_1}`,
      );
      expect(schemeAsStranger).toHaveLength(0);

      const slabAsAdmin = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from revenue_share_slabs where id = ${SLAB_1}`,
      );
      expect(slabAsAdmin).toHaveLength(1);
    });

    it('only platform_admin may write either table', async () => {
      // The row IS select-visible to any tenant_admin, but no UPDATE-
      // applicable policy passes for them — silent 0 rows, not an error.
      await expectNoRowsAffected(
        withContext(
          app,
          AS_ADMIN,
          (tx) => tx`update revenue_share_schemes set name = 'Hijacked' where id = ${SCHEME_1}`,
        ),
      );
      const result = await withContext(
        app,
        AS_PLATFORM_ADMIN,
        (tx) => tx`update revenue_share_schemes set name = 'Updated' where id = ${SCHEME_1}`,
      );
      expect(result.count).toBe(1);
    });
  });

  describe('tenant_revenue_overrides (§7.6)', () => {
    it("is visible to that tenant's admin, not another tenant's admin", async () => {
      const asAdmin = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from tenant_revenue_overrides where id = ${OVERRIDE_1}`,
      );
      expect(asAdmin).toHaveLength(1);

      const asTenantB = await withContext(
        app,
        AS_TENANT_B,
        (tx) => tx`select id from tenant_revenue_overrides where id = ${OVERRIDE_1}`,
      );
      expect(asTenantB).toHaveLength(0);
    });

    it('only platform may write it, not the tenant admin', async () => {
      await expectNoRowsAffected(
        withContext(
          app,
          AS_ADMIN,
          (tx) =>
            tx`update tenant_revenue_overrides set reason = 'hijacked' where id = ${OVERRIDE_1}`,
        ),
      );
      const result = await withContext(
        app,
        AS_PLATFORM_ADMIN,
        (tx) =>
          tx`update tenant_revenue_overrides set reason = 'contract renegotiated' where id = ${OVERRIDE_1}`,
      );
      expect(result.count).toBe(1);
    });
  });

  describe('settlement_periods (§7.7)', () => {
    it('is readable by any tenant_admin and platform/system, writable only by platform/system', async () => {
      const asAdmin = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from settlement_periods where id = ${PERIOD_1}`,
      );
      expect(asAdmin).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from settlement_periods where id = ${PERIOD_1}`,
      );
      expect(asStranger).toHaveLength(0);

      await expectNoRowsAffected(
        withContext(
          app,
          AS_ADMIN,
          (tx) => tx`update settlement_periods set status_code = 'closing' where id = ${PERIOD_1}`,
        ),
      );
      const result = await withContext(
        app,
        AS_SYSTEM,
        (tx) => tx`update settlement_periods set status_code = 'closing' where id = ${PERIOD_1}`,
      );
      expect(result.count).toBe(1);
    });
  });

  describe('settlements (§7.8)', () => {
    it("is visible to that tenant's admin, not another tenant's admin or a plain member", async () => {
      const asAdmin = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from settlements where id = ${SETTLEMENT_1}`,
      );
      expect(asAdmin).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from settlements where id = ${SETTLEMENT_1}`,
      );
      expect(asStranger).toHaveLength(0);

      const asTenantB = await withContext(
        app,
        AS_TENANT_B,
        (tx) => tx`select id from settlements where id = ${SETTLEMENT_1}`,
      );
      expect(asTenantB).toHaveLength(0);
    });

    it('lets the tenant admin dispute it, and platform/system fully manage it', async () => {
      const asAdmin = await withContext(
        app,
        AS_ADMIN,
        (tx) =>
          tx`update settlements set dispute_note = 'numbers look wrong', disputed_at = now() where id = ${SETTLEMENT_1}`,
      );
      expect(asAdmin.count).toBe(1);

      const asSystem = await withContext(
        app,
        AS_SYSTEM,
        (tx) => tx`update settlements set status_code = 'calculated' where id = ${SETTLEMENT_1}`,
      );
      expect(asSystem.count).toBe(1);
    });

    it('becomes immutable once approved', async () => {
      await admin`update settlements set approved_at = now() where id = ${SETTLEMENT_1}`;
      const error =
        await admin`update settlements set dispute_note = 'too late' where id = ${SETTLEMENT_1}`.then(
          () => undefined,
          (caught: unknown) => caught as { message?: string },
        );
      expect(error?.message).toContain('cannot modify an approved settlement');
    });
  });

  describe('payouts (§7.10)', () => {
    it("is visible to that tenant's admin, not a plain member", async () => {
      const asAdmin = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from payouts where id = ${PAYOUT_1}`,
      );
      expect(asAdmin).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from payouts where id = ${PAYOUT_1}`,
      );
      expect(asStranger).toHaveLength(0);
    });

    it('only platform_finance (or platform_admin) may write it, not the tenant admin', async () => {
      await expectNoRowsAffected(
        withContext(
          app,
          AS_ADMIN,
          (tx) => tx`update payouts set status_code = 'sent' where id = ${PAYOUT_1}`,
        ),
      );
      const result = await withContext(
        app,
        AS_PLATFORM_FINANCE,
        (tx) => tx`update payouts set status_code = 'sent', sent_at = now() where id = ${PAYOUT_1}`,
      );
      expect(result.count).toBe(1);
    });
  });

  describe('settlement_ledger_entries (§7.9)', () => {
    it("is visible to that tenant's admin, not a plain member", async () => {
      const asAdmin = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from settlement_ledger_entries where id = ${LEDGER_1}`,
      );
      expect(asAdmin).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from settlement_ledger_entries where id = ${LEDGER_1}`,
      );
      expect(asStranger).toHaveLength(0);
    });

    it('only platform/system may write it, not the tenant admin', async () => {
      await expectDenied(
        withContext(
          app,
          AS_ADMIN,
          (tx) =>
            tx`insert into settlement_ledger_entries (tenant_id, journal_id, partner_id, account_code, amount, occurred_at, idempotency_key)
               values (${TENANT_A}, ${JOURNAL_1}, ${PARTNER}, 'adjustments', 1, now(), 'rls-payments-ledger-insert-test')`,
        ),
      );
    });
  });

  describe('tenant_final_settlement (§7.11)', () => {
    it("is visible to that tenant's admin and platform, not a plain member", async () => {
      const asAdmin = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from tenant_final_settlement where id = ${FINAL_SETTLEMENT_1}`,
      );
      expect(asAdmin).toHaveLength(1);

      const asPlatformAdmin = await withContext(
        app,
        AS_PLATFORM_ADMIN,
        (tx) => tx`select id from tenant_final_settlement where id = ${FINAL_SETTLEMENT_1}`,
      );
      expect(asPlatformAdmin).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from tenant_final_settlement where id = ${FINAL_SETTLEMENT_1}`,
      );
      expect(asStranger).toHaveLength(0);
    });

    it('system may calculate it, platform_finance/platform_admin may approve, tenant admin cannot write', async () => {
      const asSystem = await withContext(
        app,
        AS_SYSTEM,
        (tx) =>
          tx`update tenant_final_settlement set status_code = 'calculated', calculated_at = now() where id = ${FINAL_SETTLEMENT_1}`,
      );
      expect(asSystem.count).toBe(1);

      await expectNoRowsAffected(
        withContext(
          app,
          AS_ADMIN,
          (tx) =>
            tx`update tenant_final_settlement set status_code = 'approved' where id = ${FINAL_SETTLEMENT_1}`,
        ),
      );
    });
  });

  describe('platform_share_rate_backfills (§7.12)', () => {
    it("is visible to that tenant's admin and platform, not a plain member", async () => {
      const asAdmin = await withContext(
        app,
        AS_ADMIN,
        (tx) => tx`select id from platform_share_rate_backfills where id = ${BACKFILL_1}`,
      );
      expect(asAdmin).toHaveLength(1);

      const asStranger = await withContext(
        app,
        AS_STRANGER,
        (tx) => tx`select id from platform_share_rate_backfills where id = ${BACKFILL_1}`,
      );
      expect(asStranger).toHaveLength(0);
    });

    it('only the system role may write it', async () => {
      await expectNoRowsAffected(
        withContext(
          app,
          AS_ADMIN,
          (tx) =>
            tx`update platform_share_rate_backfills set true_ups_posted = 1 where id = ${BACKFILL_1}`,
        ),
      );
      const result = await withContext(
        app,
        AS_SYSTEM,
        (tx) =>
          tx`update platform_share_rate_backfills set true_ups_posted = 1 where id = ${BACKFILL_1}`,
      );
      expect(result.count).toBe(1);
    });
  });
});
