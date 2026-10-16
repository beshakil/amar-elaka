import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * The info engine at the database (0061, ADR 065): the outage report
 * threshold, member limits on notices and lost & found (moderation for every
 * member report — 0011 let a reporter open their own), the one moderation
 * decision, versioned gov services, next departures, the 24-hour flag, the
 * agri board, the expiry job, and RLS across areas.
 */

const P = '0191e3a0-b00d-7000-8000-';
const FIXTURE = `${P}%`;
const PARTNER = `${P}000000000001`;
const GEO_A = `${P}000000000011`;
const GEO_B = `${P}000000000012`;
const TENANT_A = `${P}000000000021`;
const TENANT_B = `${P}000000000022`;
const LOCALITY_A = `${P}000000000031`;
const U = (n: number) => `${P}0000000001${String(n).padStart(2, '0')}`;
const M = (n: number) => `${P}0000000002${String(n).padStart(2, '0')}`;
const ROUTE = `${P}000000000041`;
const PLACE_24 = `${P}000000000051`;
const PLACE_DAY = `${P}000000000052`;
// Users 1–4: members of A; 5: A's admin; 6: A's field agent; 7: B's admin.
const TENANT_OF: Record<number, string> = {
  1: TENANT_A,
  2: TENANT_A,
  3: TENANT_A,
  4: TENANT_A,
  5: TENANT_A,
  6: TENANT_A,
  7: TENANT_B,
};
const ROLE_OF: Record<number, string> = { 5: 'tenant_admin', 6: 'agent', 7: 'tenant_admin' };

type Context = Partial<
  Record<'tenant_id' | 'user_id' | 'member_id' | 'role' | 'is_platform_admin', string>
>;
const as = (n: number): Context => ({
  tenant_id: TENANT_OF[n]!,
  user_id: U(n),
  member_id: M(n),
  role: ROLE_OF[n] ?? 'member',
});
const SYSTEM: Context = { role: 'system', is_platform_admin: 'true' };
const ANON_A: Context = { tenant_id: TENANT_A };
const pt = (lng: number, lat: number) => `SRID=4326;POINT(${lng} ${lat})`;

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

describe('Info engine (0061)', () => {
  let app: Sql;
  let admin: Sql;

  async function cleanup(): Promise<void> {
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const t of [
        'moderation_actions',
        'reports',
        'media_attachments',
        'notices',
        'lost_found_items',
        'outage_reports',
        'utility_outages',
        'gov_service_versions',
        'gov_services',
        'transport_schedules',
        'transport_route_stops',
        'transport_routes',
        'place_hours',
        'place_revisions',
        'places',
        'bazar_prices',
        'localities',
        'tenant_members',
        'tenant_settings',
      ]) {
        await tx.unsafe(`delete from ${t} where tenant_id::text like $1`, [FIXTURE]);
      }
      await tx`delete from tenants where id::text like ${FIXTURE}`;
      await tx`delete from categories where id::text like ${FIXTURE}`;
      await tx`delete from partners where id::text like ${FIXTURE}`;
      await tx`delete from geo_areas where id::text like ${FIXTURE}`;
      await tx`delete from user_profiles where user_id::text like ${FIXTURE}`;
      await tx`delete from users where id::text like ${FIXTURE}`;
    });
  }

  beforeAll(async () => {
    app = testSqlClient(4, resolveTestAppDatabaseUrl());
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanup();
    for (const n of Object.keys(TENANT_OF).map(Number)) {
      await admin`insert into users (id, phone_e164) values (${U(n)}, ${`+88017990000${String(n).padStart(2, '0')}`})`;
      await admin`insert into user_profiles (user_id, display_name) values (${U(n)}, ${`Info ${n}`})`;
    }
    await admin`insert into partners (id, legal_name, display_name, phone_e164)
                values (${PARTNER}, 'Engine Partner', 'Engine Partner', '+8801799000099')`;
    await admin`insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
      (${GEO_A}, 3, 'upazila', 'engine-a', 'Engine A', 'fixture'),
      (${GEO_B}, 3, 'upazila', 'engine-b', 'Engine B', 'fixture')`;
    await admin`insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
      (${TENANT_A}, ${PARTNER}, ${GEO_A}, 'engine-a', 'এ', 'A', st_point(90.40, 23.80)::geography, 'active'),
      (${TENANT_B}, ${PARTNER}, ${GEO_B}, 'engine-b', 'বি', 'B', st_point(90.43, 23.80)::geography, 'active')`;
    for (const n of Object.keys(TENANT_OF).map(Number)) {
      await admin`insert into tenant_members (id, tenant_id, user_id, role_code)
                  values (${M(n)}, ${TENANT_OF[n]!}, ${U(n)}, ${ROLE_OF[n] ?? 'member'})`;
    }
    await admin`insert into localities (id, tenant_id, name_bn, center)
                values (${LOCALITY_A}, ${TENANT_A}, 'উত্তর পাড়া', ${pt(90.401, 23.801)}::geography)`;
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await Promise.all([app.end(), admin.end()]);
    }
  });

  // ---- outages ----------------------------------------------------------------

  describe('outage reports', () => {
    const report = (n: number) =>
      withContext(
        app,
        as(n),
        (tx) => tx<{ reporters: number; locality_id: string | null }[]>`
        select locality_id, reporters from public.report_outage('electricity', ${pt(90.4011, 23.8011)}::geography)`,
      );
    const clusters = () =>
      withContext(
        app,
        ANON_A,
        (tx) => tx<{ tenant_id: string; reporters: number }[]>`
        select tenant_id, reporters from public.outage_report_clusters(${pt(90.43, 23.8)}::geography, 10)
        where tenant_id::text like ${FIXTURE}`,
      );

    it('files a report under the nearest locality and counts a repeat once', async () => {
      const [first] = await report(1);
      expect(first).toMatchObject({ locality_id: LOCALITY_A, reporters: 1 });
      const [again] = await report(1);
      expect(again!.reporters).toBe(1);
      expect(await clusters()).toHaveLength(0);
    });

    it('shows an area only from outage_report_min_reports different people, to viewers of any area', async () => {
      await report(2);
      expect(await clusters()).toHaveLength(0);
      await report(3);
      expect(await clusters()).toEqual([{ tenant_id: TENANT_A, reporters: 3 }]);
    });

    it('never shows who reported, and refuses a signed-out caller', async () => {
      const others = await withContext(
        app,
        as(4),
        (tx) => tx`select id from outage_reports where tenant_id = ${TENANT_A}`,
      );
      expect(others).toHaveLength(0);
      const error = await sqlError(
        withContext(
          app,
          ANON_A,
          (tx) => tx`select * from public.report_outage('electricity', null)`,
        ),
      );
      expect(error.code).toBe('42501');
    });

    it('lets the area team schedule outages, not members or another area', async () => {
      const insert = (n: number) =>
        withContext(
          app,
          as(n),
          (tx) => tx`
          insert into utility_outages (tenant_id, utility_code, starts_at, ends_at)
          values (${TENANT_A}, 'gas', now() - interval '1 hour', now() + interval '2 hours')`,
        );
      await insert(6);
      expect((await sqlError(insert(1))).code).toBe('42501');
      expect((await sqlError(insert(7))).code).toBe('42501');
      const near = await withContext(
        app,
        ANON_A,
        (tx) => tx`
        select id from public.utility_outages_near(${pt(90.43, 23.8)}::geography, 10, 50)
        where tenant_id = ${TENANT_A}`,
      );
      expect(near).toHaveLength(1);
    });
  });

  // ---- notices -------------------------------------------------------------------

  describe('notices', () => {
    const insert = (n: number, type: string) =>
      withContext(
        app,
        as(n),
        (tx) => tx<{ id: string; status_code: string }[]>`
        insert into notices (notice_type_code, title, body, published_by_member_id, status_code)
        values (${type}, ${`Notice ${type} ${n}`}, 'body', ${M(n)}, 'published')
        returning id, status_code`,
      );

    it('lets a member post only community types, and holds them for review', async () => {
      expect(await sqlError(insert(1, 'government'))).toMatchObject({
        code: 'AE910',
        detail: 'type',
      });
      const [row] = await insert(1, 'obituary');
      expect(row!.status_code).toBe('pending_review');
    });

    it('publishes the area team’s notices at once, a field agent’s included', async () => {
      const [agent] = await insert(6, 'weather_alert');
      expect(agent!.status_code).toBe('published');
      const [staff] = await insert(5, 'union_parishad');
      expect(staff!.status_code).toBe('published');
    });

    it('approves with an expiry and an audit row; members cannot decide', async () => {
      const [pending] = await admin<{ id: string }[]>`
        select id from notices where tenant_id = ${TENANT_A} and status_code = 'pending_review' limit 1`;
      const member = await sqlError(
        withContext(
          app,
          as(2),
          (tx) =>
            tx`select public.decide_info_item('notice', ${pending!.id}, 'approve', 'meets_guidelines', null)`,
        ),
      );
      expect(member.code).toBe('42501');
      await withContext(
        app,
        as(5),
        (tx) =>
          tx`select public.decide_info_item('notice', ${pending!.id}, 'approve', 'meets_guidelines', null)`,
      );
      const [row] = await admin<{ status_code: string; expires_at: Date | null }[]>`
        select status_code, expires_at from notices where id = ${pending!.id}`;
      expect(row!.status_code).toBe('published');
      // notice_obituary_expiry_days (3) from now.
      expect(row!.expires_at!.getTime() - Date.now()).toBeGreaterThan(2.9 * 86_400_000);
      expect(row!.expires_at!.getTime() - Date.now()).toBeLessThan(3.1 * 86_400_000);
      const actions =
        await admin`select id from moderation_actions where notice_id = ${pending!.id} and action_code = 'info_approved'`;
      expect(actions).toHaveLength(1);
    });

    it('needs a reason to remove', async () => {
      const [published] = await admin<{ id: string }[]>`
        select id from notices where tenant_id = ${TENANT_A} and notice_type_code = 'weather_alert'`;
      const error = await sqlError(
        withContext(
          app,
          as(5),
          (tx) =>
            tx`select public.decide_info_item('notice', ${published!.id}, 'remove', 'spam', '')`,
        ),
      );
      expect(error).toMatchObject({ code: 'AE914', detail: 'reason' });
    });

    it('keeps a live notice after a report: same status and expiry, the review recorded', async () => {
      const [live] = await admin<{ id: string; expires_at: Date | null }[]>`
        select id, expires_at from notices where tenant_id = ${TENANT_A} and notice_type_code = 'weather_alert'`;
      await withContext(
        app,
        as(5),
        (tx) =>
          tx`select public.decide_info_item('notice', ${live!.id}, 'approve', 'meets_guidelines', null)`,
      );
      const [row] = await admin<{ status_code: string; expires_at: Date | null }[]>`
        select status_code, expires_at from notices where id = ${live!.id}`;
      expect(row).toEqual({ status_code: 'published', expires_at: live!.expires_at });
      const actions =
        await admin`select id from moderation_actions where notice_id = ${live!.id} and action_code = 'info_approved'`;
      expect(actions).toHaveLength(1);
      // Rejecting is only for what is still waiting.
      const error = await sqlError(
        withContext(
          app,
          as(5),
          (tx) =>
            tx`select public.decide_info_item('notice', ${live!.id}, 'reject', 'spam', 'not real')`,
        ),
      );
      expect(error).toMatchObject({ code: 'AE914', detail: 'state' });
    });

    it('lists published notices near the viewer, across areas', async () => {
      const rows = await withContext(
        app,
        as(7),
        (tx) => tx<{ tenant_id: string }[]>`
        select tenant_id from public.notices_near(${pt(90.43, 23.8)}::geography, 10, null, 50)
        where tenant_id::text like ${FIXTURE}`,
      );
      expect(rows.length).toBeGreaterThanOrEqual(3);
      expect(new Set(rows.map((r) => r.tenant_id))).toEqual(new Set([TENANT_A]));
    });
  });

  // ---- lost & found ------------------------------------------------------------------

  describe('lost & found', () => {
    let item: string;

    beforeAll(async () => {
      const [row] = await withContext(
        app,
        as(1),
        (tx) => tx<{ id: string; status_code: string }[]>`
        insert into lost_found_items (tenant_id, kind_code, item_type_code, title, reporter_member_id, status_code)
        values (${TENANT_A}, 'lost', 'wallet', 'Brown wallet', ${M(1)}, 'open')
        returning id, status_code`,
      );
      item = row!.id;
      expect(row!.status_code).toBe('pending_review');
    });

    it('never lets a reporter open their own report (the 0011 gap)', async () => {
      const error = await sqlError(
        withContext(
          app,
          as(1),
          (tx) => tx`update lost_found_items set status_code = 'open' where id = ${item}`,
        ),
      );
      expect(error).toMatchObject({ code: 'AE911', detail: 'status' });
    });

    it('opens on approval; an edit goes back to review; the reporter may resolve', async () => {
      await withContext(
        app,
        as(5),
        (tx) =>
          tx`select public.decide_info_item('lost_found', ${item}, 'approve', 'meets_guidelines', null)`,
      );
      const status = async () =>
        (
          await admin<
            { status_code: string }[]
          >`select status_code from lost_found_items where id = ${item}`
        )[0]!.status_code;
      expect(await status()).toBe('open');
      await withContext(
        app,
        as(1),
        (tx) => tx`update lost_found_items set title = 'Black wallet' where id = ${item}`,
      );
      expect(await status()).toBe('pending_review');
      await withContext(
        app,
        as(5),
        (tx) =>
          tx`select public.decide_info_item('lost_found', ${item}, 'approve', 'meets_guidelines', null)`,
      );
      await withContext(
        app,
        as(1),
        (tx) => tx`update lost_found_items set status_code = 'resolved' where id = ${item}`,
      );
      expect(await status()).toBe('resolved');
    });
  });

  // ---- transport, places, gov services, agri ---------------------------------------------

  describe('transport', () => {
    beforeAll(async () => {
      await admin`insert into transport_routes (id, tenant_id, mode_code, name_bn, origin_name, destination_name)
                  values (${ROUTE}, ${TENANT_A}, 'bus', 'এ – ঢাকা', 'এ', 'ঢাকা')`;
      // Every day at 00:00 and at 23:59 (local): the next departure is always one of them.
      await admin`insert into transport_schedules (tenant_id, transport_route_id, departure_time)
                  values (${TENANT_A}, ${ROUTE}, '00:00'), (${TENANT_A}, ${ROUTE}, '23:59')`;
    });

    it('gives the next departures from now in the area’s own time, today then tomorrow', async () => {
      const rows = await withContext(
        app,
        ANON_A,
        (tx) => tx<{ departs_at: Date }[]>`
        select departs_at from public.transport_next_departures(${ROUTE}, now(), 3)`,
      );
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const r of rows) expect(r.departs_at.getTime()).toBeGreaterThan(Date.now() - 1000);
      const sorted = [...rows].sort((a, b) => a.departs_at.getTime() - b.departs_at.getTime());
      expect(rows).toEqual(sorted);
    });

    it('lists the route near the viewer from another area', async () => {
      const rows = await withContext(
        app,
        as(7),
        (tx) => tx`
        select id from public.transport_routes_near(${pt(90.43, 23.8)}::geography, 10, 'bus', 50) where id = ${ROUTE}`,
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe('directory', () => {
    const CATEGORY = `${P}000000000061`;

    beforeAll(async () => {
      await admin`insert into categories (id, kind_code, slug, name_bn, name_en)
                  values (${CATEGORY}, 'place', 'engine-pharmacy', 'ফার্মেসি', 'Pharmacy')`;
      await admin.begin(async (tx) => {
        await tx`select set_config('app.role', 'system', true)`;
        for (const [id, slug] of [
          [PLACE_24, 'engine-24h'],
          [PLACE_DAY, 'engine-day'],
        ] as const) {
          await tx`insert into places (id, tenant_id, category_id, slug, name_bn, location, status_code, source_code)
                   values (${id}, ${TENANT_A}, ${CATEGORY}, ${slug}, ${slug}, ${pt(90.4005, 23.8005)}::geography,
                           'published', 'user_submitted')`;
        }
        for (let d = 1; d <= 7; d++) {
          await tx`insert into place_hours (tenant_id, place_id, iso_day_of_week, opens_at, closes_at, closes_next_day)
                   values (${TENANT_A}, ${PLACE_24}, ${d}, '00:00', '00:00', true),
                          (${TENANT_A}, ${PLACE_DAY}, ${d}, '09:00', '21:00', false)`;
        }
      });
    });

    it('flags the place open around the clock, and filters by it', async () => {
      const near = (only24h: boolean) =>
        withContext(
          app,
          as(7),
          (tx) => tx<{ id: string; is_24h: boolean }[]>`
          select id, is_24h from public.directory_places_near(${pt(90.43, 23.8)}::geography, 10, '{engine-pharmacy}',
                                                              null, null, ${only24h}, null, null, 50)
          order by id`,
        );
      expect(await near(false)).toEqual([
        { id: PLACE_24, is_24h: true },
        { id: PLACE_DAY, is_24h: false },
      ]);
      expect(await near(true)).toEqual([{ id: PLACE_24, is_24h: true }]);
    });
  });

  describe('gov services', () => {
    const publish = (n: number, id: string | null, name: string) =>
      withContext(
        app,
        as(n),
        (tx) => tx<{ service_id: string; version_no: number }[]>`
        select service_id, version_no from public.gov_service_publish(${id}, 'birth-certificate', 'certificate',
          ${JSON.stringify({ name_bn: name, office_name: 'ইউনিয়ন পরিষদ', documents: ['টিকার কার্ড'] })}::text::jsonb)`,
      );

    it('keeps every save as a new version, for the area team only', async () => {
      const [first] = await publish(6, null, 'জন্ম নিবন্ধন');
      expect(first!.version_no).toBe(1);
      const [second] = await publish(5, first!.service_id, 'জন্ম নিবন্ধন সনদ');
      expect(second!.version_no).toBe(2);
      const versions =
        await admin`select version_no from gov_service_versions where gov_service_id = ${first!.service_id}`;
      expect(versions).toHaveLength(2);
      expect((await sqlError(publish(1, null, 'x'))).code).toBe('AE913');
      const edit = await sqlError(
        withContext(
          app,
          as(5),
          (tx) =>
            tx`update gov_service_versions set name_bn = 'x' where gov_service_id = ${first!.service_id}`,
        ),
      );
      expect(edit.code).toBe('42501');
    });

    it('is the area’s own board', async () => {
      const otherArea = await withContext(
        app,
        as(7),
        (tx) => tx`select id from gov_services where tenant_id = ${TENANT_A}`,
      );
      expect(otherArea).toHaveLength(0);
    });
  });

  describe('the agri board', () => {
    it('keeps input prices off the bazar board and on the agri board', async () => {
      const codes = async (board: string) =>
        (
          await withContext(
            app,
            ANON_A,
            (tx) => tx<{ code: string }[]>`
            select code from public.bazar_catalogue_for(${TENANT_A}, ${board})`,
          )
        ).map((r) => r.code);
      expect(await codes('bazar')).not.toContain('urea');
      expect(await codes('agri')).toContain('urea');
      expect(await codes('agri')).not.toContain('onion');
    });

    it('accepts an input price in the fast entry', async () => {
      const [urea] = await admin<
        { id: string }[]
      >`select id from bazar_commodities where code = 'urea'`;
      const [today] = await admin<
        { d: string }[]
      >`select public.tenant_local_today(${TENANT_A})::text as d`;
      const items = [{ commodity_id: urea!.id, unit_code: 'kg', min_price: '27', max_price: '27' }];
      const [row] = await withContext(
        app,
        as(6),
        (tx) => tx<{ n: number }[]>`
        select public.bazar_enter_prices(${today!.d}::date, ${JSON.stringify(items)}::text::jsonb) as n`,
      );
      expect(row!.n).toBe(1);
    });
  });

  // ---- the expiry job -----------------------------------------------------------------

  describe('the map', () => {
    it('shows open lost & found, government offices and outages on now in the info layer', async () => {
      const [item] = await withContext(
        app,
        { ...SYSTEM, tenant_id: TENANT_A },
        (tx) => tx<{ id: string }[]>`
        insert into lost_found_items (tenant_id, kind_code, item_type_code, title, location, reporter_member_id,
                                      contact_via_code, contact_phone_e164, status_code, expires_at)
        values (${TENANT_A}, 'lost', 'pet', 'map cat', ${pt(90.402, 23.802)}::geography, ${M(1)},
                'phone', '+8801700000001', 'open', now() + interval '1 day')
        returning id`,
      );
      const [office] = await withContext(
        app,
        as(5),
        (tx) => tx<{ service_id: string }[]>`
        select service_id from public.gov_service_publish(null, 'map-office', 'land',
          ${JSON.stringify({ name_bn: 'ভূমি অফিস', office_name: 'উপজেলা ভূমি অফিস', lat: 23.803, lng: 90.403 })}::text::jsonb)`,
      );
      const [outage] = await withContext(
        app,
        as(5),
        (tx) => tx<{ id: string }[]>`
        insert into utility_outages (utility_code, locality_id, starts_at, ends_at)
        values ('electricity', ${LOCALITY_A}, now() - interval '1 hour', now() + interval '1 hour')
        returning id`,
      );
      const rows = await withContext(
        app,
        ANON_A,
        (tx) => tx<{ id: string; info_kind: string; kind: string; name_bn: string | null }[]>`
        select id, info_kind, kind, name_bn
        from public.map_features(90.39, 23.79, 90.41, 23.81, 17, '{info}'::text[], null, false, 23.8, 90.4, 100,
                                 '{lost_found,gov_offices,outages}'::text[])`,
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(item!.id)).toMatchObject({
        info_kind: 'lost_found',
        kind: 'lost_found',
        name_bn: 'map cat',
      });
      expect(byId.get(office!.service_id)).toMatchObject({
        info_kind: 'gov_office',
        kind: 'gov_offices',
      });
      expect(byId.get(outage!.id)).toMatchObject({
        info_kind: 'outage',
        kind: 'outages',
        name_bn: 'উত্তর পাড়া',
      });
    });
  });

  describe('expire_info_items', () => {
    it('ends notices, archives lost & found and ends outages past their time (the system only)', async () => {
      await admin.begin(async (tx) => {
        await tx`select set_config('app.role', 'system', true)`;
        await tx`update notices set expires_at = now() - interval '1 minute' where tenant_id = ${TENANT_A} and status_code = 'published'`;
        await tx`insert into lost_found_items (tenant_id, kind_code, item_type_code, title, reporter_member_id, status_code, expires_at)
                 values (${TENANT_A}, 'found', 'phone', 'Old phone', ${M(2)}, 'open', now() - interval '1 minute')`;
        await tx`insert into utility_outages (tenant_id, utility_code, starts_at, ends_at)
                 values (${TENANT_A}, 'water', now() - interval '5 hours', now() - interval '2 hours')`;
      });
      expect(
        (
          await sqlError(
            withContext(app, as(5), (tx) => tx`select * from public.expire_info_items(100)`),
          )
        ).code,
      ).toBe('42501');
      await withContext(app, SYSTEM, (tx) => tx`select * from public.expire_info_items(1000)`);
      const left = await admin<{ n: number }[]>`
        select (select count(*) from notices where tenant_id = ${TENANT_A} and status_code = 'published')::int
             + (select count(*) from lost_found_items where tenant_id = ${TENANT_A} and title = 'Old phone' and status_code = 'open')::int
             + (select count(*) from utility_outages where tenant_id = ${TENANT_A} and utility_code = 'water' and status_code = 'scheduled')::int
             as n`;
      expect(left[0]!.n).toBe(0);
    });
  });
});
