import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * Local information services (0060, ADR 064), at the database: RLS of the
 * new tables (cross-tenant blocked), and the functions that are their only
 * write paths — the radius readers across areas, the donor contact cap, the
 * urgent-request matcher, expiry, the takedown and the bazar fast entry.
 */

const P = '0191e3a0-b00c-7000-8000-';
const PARTNER = `${P}000000000001`;
const GEO_A = `${P}000000000011`;
const GEO_B = `${P}000000000012`;
const TENANT_A = `${P}000000000021`;
const TENANT_B = `${P}000000000022`;
const U = (n: number) => `${P}0000000001${String(n).padStart(2, '0')}`;
const M = (n: number) => `${P}0000000002${String(n).padStart(2, '0')}`;
const D = (n: number) => `${P}0000000003${String(n).padStart(2, '0')}`;
const R = (n: number) => `${P}0000000004${String(n).padStart(2, '0')}`;
const E = (n: number) => `${P}0000000005${String(n).padStart(2, '0')}`;

// Users: 1 Alice (A, donor o_neg), 2 Bob (B, donor o_pos), 3 Carol (A, paused),
// 4 Dave (A, in the donation gap), 5 Erin (B, far away), 6 Frank (A, alerts
// off), 7 Gina (A, never in window), 8 Stranger (A, requester), 9 Admin (A),
// 10 Agent (A), 11 Admin B.
const USERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const TENANT_OF: Record<number, string> = {
  1: TENANT_A,
  2: TENANT_B,
  3: TENANT_A,
  4: TENANT_A,
  5: TENANT_B,
  6: TENANT_A,
  7: TENANT_A,
  8: TENANT_A,
  9: TENANT_A,
  10: TENANT_A,
  11: TENANT_B,
};
const NEVER_WINDOW = 'never_fixture';
const FIXTURE = `${P}%`;

type Context = Partial<
  Record<'tenant_id' | 'user_id' | 'member_id' | 'role' | 'is_platform_admin', string>
>;
const as = (n: number, role = 'member'): Context => ({
  tenant_id: TENANT_OF[n]!,
  user_id: U(n),
  member_id: M(n),
  role,
});
const ANON_A: Context = { tenant_id: TENANT_A };
const SYSTEM: Context = { role: 'system', is_platform_admin: 'true' };

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

async function sqlError(promise: Promise<unknown>): Promise<{ code?: string; detail?: string }> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught as { code?: string; detail?: string },
  );
  if (!error) throw new Error('expected the statement to be rejected, but it succeeded');
  return error;
}

const origin = (lng: number, lat: number) => `SRID=4326;POINT(${lng} ${lat})`;

describe('Local information services (0060)', () => {
  let app: Sql;
  let admin: Sql;

  async function cleanup(): Promise<void> {
    await admin.begin(async (tx) => {
      // moderation_actions is append-only (trigger); teardown bypasses it.
      await tx`set local session_replication_role = replica`;
      await tx`delete from moderation_actions where tenant_id::text like ${FIXTURE}`;
    });
    await admin`delete from blood_request_alerts where tenant_id::text like ${FIXTURE}`;
    await admin`delete from blood_donor_contacts where tenant_id::text like ${FIXTURE}`;
    await admin`delete from lead_events where tenant_id::text like ${FIXTURE}`;
    await admin`delete from blood_requests where tenant_id::text like ${FIXTURE}`;
    await admin`delete from blood_donors where tenant_id::text like ${FIXTURE}`;
    await admin`delete from bazar_prices where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_bazar_items where tenant_id::text like ${FIXTURE}`;
    await admin`delete from bazar_board_sponsors where tenant_id::text like ${FIXTURE}`;
    await admin`delete from emergency_contacts where tenant_id::text like ${FIXTURE}`;
    await admin`delete from user_profiles where user_id::text like ${FIXTURE}`;
    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_settings where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
    await admin`delete from donor_contact_windows where code = ${NEVER_WINDOW}`;
  }

  beforeAll(async () => {
    app = testSqlClient(4, resolveTestAppDatabaseUrl());
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanup();

    for (const n of USERS) {
      await admin`insert into users (id, phone_e164) values (${U(n)}, ${`+88017880000${String(n).padStart(2, '0')}`})`;
      await admin`insert into user_profiles (user_id, display_name) values (${U(n)}, ${`Fixture ${n}`})`;
    }
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Info Services Partner', 'Info Services Partner', '+8801788000099')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
        (${GEO_A}, 3, 'upazila', 'info-svc-a', 'Info Area A', 'fixture'),
        (${GEO_B}, 3, 'upazila', 'info-svc-b', 'Info Area B', 'fixture')`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
        (${TENANT_A}, ${PARTNER}, ${GEO_A}, 'info-svc-a', 'এ', 'A', st_point(90.40, 23.80)::geography, 'active'),
        (${TENANT_B}, ${PARTNER}, ${GEO_B}, 'info-svc-b', 'বি', 'B', st_point(90.43, 23.80)::geography, 'active')`;
    for (const n of USERS) {
      const role = n === 9 || n === 11 ? 'tenant_admin' : 'member';
      await admin`insert into tenant_members (id, tenant_id, user_id, role_code) values (${M(n)}, ${TENANT_OF[n]!}, ${U(n)}, ${role})`;
    }
    // Area A caps donor contacts at 2 a day and alerts at 1 a day; B keeps the defaults.
    // blood_donor_alerts_per_day is platform-scoped: only platform staff may override it.
    await withContext(
      admin,
      { role: 'platform_admin', is_platform_admin: 'true' },
      (tx) => tx`
      insert into tenant_settings (tenant_id, setting_overrides) values
        (${TENANT_A}, '{"blood_donor_daily_contact_cap": 2, "blood_donor_alerts_per_day": 1}'::jsonb),
        (${TENANT_B}, '{}'::jsonb)`,
    );
    await admin`
      insert into donor_contact_windows (code, label_key, sort_order, starts_at, ends_at)
      values (${NEVER_WINDOW}, 'enum.donor_contact_windows.any', 999, '03:00', '03:00')`;

    const donors: [number, string, number, number, Record<string, unknown>][] = [
      [1, 'o_neg', 90.401, 23.801, {}],
      [2, 'o_pos', 90.42, 23.8, {}],
      [3, 'o_neg', 90.402, 23.8, { is_available: false }],
      [4, 'o_neg', 90.403, 23.8, { gap: true }],
      [5, 'o_neg', 91.5, 24.5, {}],
      [6, 'o_neg', 90.404, 23.8, { alerts_enabled: false }],
      [7, 'o_neg', 90.405, 23.8, { contact_window_code: NEVER_WINDOW }],
    ];
    for (const [n, group, lng, lat, opts] of donors) {
      await admin`
        insert into blood_donors
          (id, tenant_id, member_id, blood_group_code, approx_location, is_available, alerts_enabled,
           contact_window_code, contact_preference_code, last_donated_on, eligibility_confirmed_at)
        values
          (${D(n)}, ${TENANT_OF[n]!}, ${M(n)}, ${group}, ${origin(lng, lat)}::geography,
           ${opts.is_available !== false}, ${opts.alerts_enabled !== false},
           ${(opts.contact_window_code as string | undefined) ?? 'any'},
           ${n === 1 ? 'reveal_on_request' : 'in_app_only'},
           ${opts.gap ? new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10) : null}::date, now())`;
    }

    await admin`
      insert into emergency_contacts (id, tenant_id, service_type_code, name_bn, phones, location, is_active) values
        (${E(1)}, ${TENANT_A}, 'hospital', 'এ হাসপাতাল', '{+8801788000201}', ${origin(90.401, 23.8)}::geography, true),
        (${E(2)}, ${TENANT_B}, 'fire_service', 'বি ফায়ার', '{16163}', ${origin(90.43, 23.8)}::geography, true),
        (${E(3)}, ${TENANT_B}, 'police', 'দূরের থানা', '{+8801788000203}', ${origin(91.5, 24.5)}::geography, true),
        (${E(4)}, ${TENANT_A}, 'ambulance', 'এ অ্যাম্বুলেন্স', '{+8801788000204}', null, true),
        (${E(5)}, ${TENANT_B}, 'ambulance', 'বি অ্যাম্বুলেন্স (বিন্দু নেই)', '{+8801788000205}', null, true)`;
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await Promise.all([app.end(), admin.end()]);
    }
  });

  // ---- emergency ------------------------------------------------------------

  describe('emergency_contacts_near', () => {
    it('lists contacts near the viewer from every area, plus the area’s own without a point', async () => {
      const rows = await withContext(
        app,
        ANON_A,
        (tx) => tx<{ id: string }[]>`
          select id from public.emergency_contacts_near(${origin(90.4, 23.8)}::geography, 15, ${TENANT_A}, 100)
          where id::text like ${FIXTURE}`,
      );
      expect(rows.map((r) => r.id).sort()).toEqual([E(1), E(2), E(4)].sort());
    });

    it('seeds the national hotlines (999 first)', async () => {
      const rows = await withContext(
        app,
        ANON_A,
        (tx) => tx<{ dial_string: string }[]>`
          select dial_string from national_hotlines where is_active order by sort_order limit 1`,
      );
      expect(rows[0]?.dial_string).toBe('999');
    });
  });

  // ---- blood donors ---------------------------------------------------------

  describe('blood_donors', () => {
    it('snaps a donor’s point to the grid', async () => {
      const [row] = await admin<{ x: number }[]>`
        select st_x(approx_location::geometry) as x from blood_donors where id = ${D(1)}`;
      expect(row!.x).not.toBeCloseTo(90.401, 6);
    });

    it('finds available, eligible donors across areas; never paused, in the gap, far, or oneself', async () => {
      const rows = await withContext(
        app,
        as(8),
        (tx) => tx<{ id: string; distance_m: number }[]>`
          select id, distance_m from public.blood_donors_near(
            ${origin(90.4, 23.8)}::geography, 10, '{o_neg,o_pos}'::text[], null, null, 50)
          where id::text like ${FIXTURE}`,
      );
      const ids = rows.map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining([D(1), D(2), D(6), D(7)]));
      expect(ids).not.toContain(D(3));
      expect(ids).not.toContain(D(4));
      expect(ids).not.toContain(D(5));
      // Rounded to the 500 m grid: no exact distance leaks.
      for (const r of rows) expect(r.distance_m % 500).toBe(0);

      const asAlice = await withContext(
        app,
        as(1),
        (tx) => tx<{ id: string }[]>`
          select id from public.blood_donors_near(
            ${origin(90.4, 23.8)}::geography, 10, '{o_neg}'::text[], null, null, 50)`,
      );
      expect(asAlice.map((r) => r.id)).not.toContain(D(1));
    });

    it('refuses a signed-out caller', async () => {
      const error = await sqlError(
        withContext(
          app,
          ANON_A,
          (tx) => tx`select id from public.blood_donors_near(
            ${origin(90.4, 23.8)}::geography, 10, null, null, null, 10)`,
        ),
      );
      expect(error.code).toBe('42501');
    });

    it('returns the number only for a donor who shares it', async () => {
      const [alice] = await withContext(
        app,
        as(8),
        (tx) => tx<{ phone_e164: string | null }[]>`
          select phone_e164 from public.blood_donor_contact_target(${D(1)})`,
      );
      expect(alice!.phone_e164).toBe('+8801788000001');
      const [frank] = await withContext(
        app,
        as(8),
        (tx) => tx<{ phone_e164: string | null }[]>`
          select phone_e164 from public.blood_donor_contact_target(${D(6)})`,
      );
      expect(frank!.phone_e164).toBeNull();
    });

    it('records contacts and leads, refuses past the donor’s daily cap and self', async () => {
      const contact = (n: number) =>
        withContext(
          app,
          as(n),
          (tx) =>
            tx`select public.blood_donor_record_contact(${D(1)}, 'call_click', null, 'viewer-key')`,
        );
      await contact(8);
      await contact(9);
      const capped = await sqlError(contact(10));
      expect(capped).toMatchObject({ code: 'AE901', detail: 'cap' });

      const self = await sqlError(contact(1));
      expect(self.code).toBe('AE901');

      const [leads] = await admin<{ n: number }[]>`
        select count(*)::int as n from lead_events
        where target_member_id = ${M(1)} and source_code = 'blood_donor_list'`;
      expect(leads!.n).toBe(2);
    });

    it('shows a donor who contacted them — and nobody else', async () => {
      const own = await withContext(
        app,
        as(1),
        (tx) => tx`select id from blood_donor_contacts where blood_donor_id = ${D(1)}`,
      );
      expect(own).toHaveLength(2);
      const other = await withContext(
        app,
        as(8),
        (tx) => tx`select id from blood_donor_contacts where blood_donor_id = ${D(1)}`,
      );
      expect(other).toHaveLength(0);
      const tenantB = await withContext(
        app,
        as(11, 'tenant_admin'),
        (tx) => tx`select id from blood_donor_contacts where blood_donor_id = ${D(1)}`,
      );
      expect(tenantB).toHaveLength(0);
      const staffA = await withContext(
        app,
        as(9, 'tenant_admin'),
        (tx) => tx`select id from blood_donor_contacts where blood_donor_id = ${D(1)}`,
      );
      expect(staffA).toHaveLength(2);
    });

    it('never lets the app write a contact row directly', async () => {
      const error = await sqlError(
        withContext(
          app,
          as(8),
          (tx) => tx`
            insert into blood_donor_contacts (tenant_id, blood_donor_id, channel_code)
            values (${TENANT_A}, ${D(1)}, 'call_click')`,
        ),
      );
      expect(error.code).toBe('42501');
    });
  });

  // ---- urgent requests ------------------------------------------------------

  describe('blood requests', () => {
    async function request(id: string, group: string, neededBy: string): Promise<void> {
      await admin`
        insert into blood_requests
          (id, tenant_id, requester_member_id, blood_group_code, hospital_name, contact_phone_e164,
           needed_by, urgency_code, location)
        values (${id}, ${TENANT_A}, ${M(8)}, ${group}, 'Fixture Hospital', '+8801788000008',
                ${neededBy}::timestamptz, 'critical', ${origin(90.4, 23.8)}::geography)`;
    }

    beforeAll(async () => {
      await request(R(1), 'o_pos', new Date(Date.now() + 86_400_000).toISOString());
      await request(R(2), 'o_pos', new Date(Date.now() + 86_400_000).toISOString());
      await request(R(3), 'o_neg', new Date(Date.now() - 10 * 3_600_000).toISOString());
      await request(R(4), 'o_neg', new Date(Date.now() - 1 * 3_600_000).toISOString());
    });

    it('alerts compatible, listable donors with alerts on and in their window — once', async () => {
      const first = await withContext(
        app,
        SYSTEM,
        (tx) => tx<{ donor_user_id: string }[]>`
          select donor_user_id from public.blood_request_alert_donors(${R(1)})`,
      );
      const users = first.map((r) => r.donor_user_id).sort();
      // O+ takes O- and O+: Alice (A) and Bob (B). Not paused Carol, gap Dave,
      // far Erin, alerts-off Frank, out-of-window Gina, nor the requester.
      expect(users).toEqual([U(1), U(2)].sort());

      const again = await withContext(
        app,
        SYSTEM,
        (tx) => tx`select donor_user_id from public.blood_request_alert_donors(${R(1)})`,
      );
      expect(again).toHaveLength(0);
    });

    it('respects the per-donor daily alert cap of their own area', async () => {
      const second = await withContext(
        app,
        SYSTEM,
        (tx) => tx<{ donor_user_id: string }[]>`
          select donor_user_id from public.blood_request_alert_donors(${R(2)})`,
      );
      // Area A allows 1 alert a day (Alice had hers); area B allows 2 (Bob gets this one).
      expect(second.map((r) => r.donor_user_id)).toEqual([U(2)]);
    });

    it('is for the system only', async () => {
      const error = await sqlError(
        withContext(
          app,
          as(9, 'tenant_admin'),
          (tx) => tx`select * from public.blood_request_alert_donors(${R(2)})`,
        ),
      );
      expect(error.code).toBe('42501');
    });

    it('closes requests past needed-by plus the grace hours, not before', async () => {
      await withContext(app, SYSTEM, (tx) => tx`select public.expire_blood_requests(100)`);
      const rows = await admin<{ id: string; status_code: string }[]>`
        select id, status_code from blood_requests where id in (${R(3)}, ${R(4)}) order by id`;
      expect(rows).toEqual([
        { id: R(3), status_code: 'expired' },
        { id: R(4), status_code: 'open' },
      ]);
    });

    it('takes a request down with its moderation action (staff only)', async () => {
      const member = await sqlError(
        withContext(
          app,
          as(8),
          (tx) => tx`select public.remove_blood_request(${R(4)}, 'fake_blood_request', 'Fake')`,
        ),
      );
      expect(member.code).toBe('42501');

      await withContext(
        app,
        as(9, 'tenant_admin'),
        (tx) =>
          tx`select public.remove_blood_request(${R(4)}, 'fake_blood_request', 'Reported as fake')`,
      );
      const [row] = await admin<
        { status_code: string }[]
      >`select status_code from blood_requests where id = ${R(4)}`;
      expect(row!.status_code).toBe('removed');
      const actions = await admin`
        select id from moderation_actions where blood_request_id = ${R(4)} and action_code = 'blood_request_removed'`;
      expect(actions).toHaveLength(1);
    });

    it('lets the requester name their own open request when contacting a donor, not someone else’s', async () => {
      const error = await sqlError(
        withContext(
          app,
          as(10),
          (tx) =>
            tx`select public.blood_donor_record_contact(${D(2)}, 'donor_request', ${R(1)}, 'k')`,
        ),
      );
      expect(error).toMatchObject({ code: 'AE901', detail: 'request' });
    });
  });

  // ---- bazar ----------------------------------------------------------------

  describe('bazar', () => {
    const today = () =>
      admin<{ d: string }[]>`select public.tenant_local_today(${TENANT_A})::text as d`.then(
        (r) => r[0]!.d,
      );
    const commodity = (code: string) =>
      admin<{ id: string }[]>`select id from bazar_commodities where code = ${code}`.then(
        (r) => r[0]!.id,
      );

    it('uses every active commodity until the area picks its own', async () => {
      const all = await withContext(
        app,
        ANON_A,
        (tx) => tx`select commodity_id from public.bazar_catalogue(${TENANT_A})`,
      );
      expect(all.length).toBeGreaterThan(10);

      const onion = await commodity('onion');
      await withContext(
        app,
        as(9, 'tenant_admin'),
        (tx) =>
          tx`insert into tenant_bazar_items (commodity_id, unit_code, sort_order) values (${onion}, 'kg', 10)`,
      );
      const own = await withContext(
        app,
        ANON_A,
        (tx) => tx<{ commodity_id: string }[]>`
        select commodity_id from public.bazar_catalogue(${TENANT_A})`,
      );
      expect(own.map((r) => r.commodity_id)).toEqual([onion]);
    });

    it('keeps an area’s board and sponsor to itself', async () => {
      await withContext(
        app,
        as(9, 'tenant_admin'),
        (tx) =>
          tx`insert into bazar_board_sponsors (name_bn, starts_on) values ('স্পনসর', current_date)`,
      );
      const asB = await withContext(app, as(11, 'tenant_admin'), async (tx) => [
        ...(await tx`select id from tenant_bazar_items where tenant_id = ${TENANT_A}`),
        ...(await tx`select id from bazar_board_sponsors where tenant_id = ${TENANT_A}`),
      ]);
      expect(asB).toHaveLength(0);
      const memberWrite = await sqlError(
        withContext(
          app,
          as(8),
          (tx) =>
            tx`insert into bazar_board_sponsors (name_bn, starts_on) values ('x', current_date)`,
        ),
      );
      expect(memberWrite.code).toBe('42501');
    });

    it('publishes the fast entry for agents, correcting a second save in place', async () => {
      const onion = await commodity('onion');
      const d = await today();
      const enter = (ctx: Context, date: string, items: unknown[]) =>
        withContext(
          app,
          ctx,
          (tx) =>
            tx`select public.bazar_enter_prices(${date}::date, ${JSON.stringify(items)}::text::jsonb) as n`,
        );
      const item = (min: string, max: string, id = onion) => ({
        commodity_id: id,
        unit_code: 'kg',
        min_price: min,
        max_price: max,
      });

      await enter(as(10, 'agent'), d, [item('60', '65')]);
      await enter(as(10, 'agent'), d, [item('62', '66')]);
      const rows = await admin<{ min_price: string; source_code: string; status_code: string }[]>`
        select min_price::text, source_code, status_code from bazar_prices
        where tenant_id = ${TENANT_A} and commodity_id = ${onion} and price_date = ${d}::date`;
      expect(rows).toEqual([
        { min_price: '62.00', source_code: 'agent', status_code: 'published' },
      ]);

      expect(await sqlError(enter(as(8), d, [item('1', '2')]))).toMatchObject({
        code: 'AE903',
        detail: 'role',
      });
      const old = await admin<{ d: string }[]>`select (${d}::date - 5)::text as d`;
      expect(await sqlError(enter(as(10, 'agent'), old[0]!.d, [item('1', '2')]))).toMatchObject({
        code: 'AE903',
        detail: 'date',
      });
      const potato = await commodity('potato');
      expect(await sqlError(enter(as(10, 'agent'), d, [item('1', '2', potato)]))).toMatchObject({
        code: 'AE903',
        detail: 'item',
      });
      expect(await sqlError(enter(as(10, 'agent'), d, [item('5', '2')]))).toMatchObject({
        code: 'AE903',
        detail: 'price',
      });
    });
  });
});
