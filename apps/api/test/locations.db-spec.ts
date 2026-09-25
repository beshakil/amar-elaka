import type { Sql, TransactionSql } from 'postgres';
import {
  checkImport,
  importBoundaries,
  importReference,
  PILOT_BOUNDARIES_PATH,
  readBoundaries,
  readReference,
  reparentPointsByContainment,
} from '../src/locations/geo-import/geo-import';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * The location system against real PostGIS and real data (0021, ADR 026):
 * the COD-AB reference with the pilot district's actual upazila polygons
 * (Trishal, Bhaluka, Fulbaria, … in Mymensingh), tenants in both boundary
 * modes, and the SQL helpers — point-in-tenant, nearest tenant, distances,
 * viewport. Distances are checked against an independent Vincenty (WGS84)
 * computation, to the millimetre.
 */

const PARTNER = '0191e3a0-a1a1-7000-8000-000000000001';
const T_TRISHAL = '0191e3a0-a1a1-7000-8000-000000000011';
const T_BHALUKA = '0191e3a0-a1a1-7000-8000-000000000012';
const T_FULBARIA_SUSPENDED = '0191e3a0-a1a1-7000-8000-000000000013';
const T_MIRPUR_RADIUS = '0191e3a0-a1a1-7000-8000-000000000014';
const T_KAFRUL_RADIUS = '0191e3a0-a1a1-7000-8000-000000000015';
const T_TOWN_RADIUS = '0191e3a0-a1a1-7000-8000-000000000016';
const AREA_MIRPUR = '0191e3a0-a1a1-7000-8000-000000000021';
const AREA_KAFRUL = '0191e3a0-a1a1-7000-8000-000000000022';
const AREA_TOWN = '0191e3a0-a1a1-7000-8000-000000000023';
const FIXTURE = '0191e3a0-a1a1-7000-8000-%';

// Known places (lat, lng).
const TRISHAL_TOWN = [24.581, 90.3939] as const;
const BHALUKA_TOWN = [24.3833, 90.3833] as const;
const FULBARIA_TOWN = [24.6333, 90.2667] as const;
const MIRPUR_10 = [23.8069, 90.3687] as const;
const CHATTOGRAM = [22.3569, 91.7832] as const;

const SYSTEM = { role: 'system', is_platform_admin: 'true' };
const ANONYMOUS = { role: 'anonymous' };

async function as<T>(
  sql: Sql,
  context: Record<string, string>,
  work: (tx: TransactionSql) => Promise<T>,
) {
  return sql.begin(async (tx) => {
    for (const [key, value] of Object.entries(context)) {
      await tx`select set_config(${`app.${key}`}, ${value}, true)`;
    }
    return work(tx);
  }) as Promise<T>;
}

describe('Location system (0021): real Bangladesh data, both tenant boundary modes', () => {
  let admin: Sql;
  let app: Sql;
  const reference = readReference();
  const areaId = new Map<string, string>();

  const point = (p: readonly [number, number]) => `SRID=4326;POINT(${p[1]} ${p[0]})`;
  const covers = async (tenant: string, lat: number, lng: number) =>
    (
      await admin<
        { v: boolean }[]
      >`select public.tenant_covers_point(${tenant}, public.geo_point(${lat}, ${lng})) as v`
    )[0]!.v;
  const nearest = (lat: number, lng: number, maxM: number, limit = 1) =>
    admin<{ tenant_id: string; inside: boolean; distance_m: number }[]>`
      select tenant_id, inside, distance_m from public.nearest_tenants(public.geo_point(${lat}, ${lng}), ${maxM}, ${limit})`;

  async function cleanUp(): Promise<void> {
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    app = testSqlClient(1, resolveTestAppDatabaseUrl());
    await cleanUp();
    await as(admin, SYSTEM, async (tx) => {
      const ids = await importReference(tx, reference);
      for (const [pcode, id] of ids) areaId.set(pcode, id);
      await importBoundaries(tx, readBoundaries(PILOT_BOUNDARIES_PATH));
      await reparentPointsByContainment(tx);
    });

    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Location Partner', 'Location Partner', '+8801766000501')`;
    // Areas the open data lacks (metro thanas), for the radius-mode tenants.
    const dncc = areaId.get('BD30262500')!;
    for (const [id, name] of [
      [AREA_MIRPUR, 'Mirpur (fixture)'],
      [AREA_KAFRUL, 'Kafrul (fixture)'],
      [AREA_TOWN, 'Trishal bazar (fixture)'],
    ] as const) {
      await admin`
        insert into geo_areas (id, parent_id, adm_level, level_code, bbs_code_geocode11, name_en,
                               source_release, needs_manual_review, manually_verified_at)
        values (${id}, ${dncc}, 4, 'ward', ${`fixture-${id.slice(-2)}`}, ${name}, 'fixture', true, now())`;
    }
    const tenant = (
      id: string,
      slug: string,
      area: string,
      center: readonly [number, number],
      status = 'active',
    ) =>
      admin`
        insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
        values (${id}, ${PARTNER}, ${area}, ${slug}, ${slug}, ${slug}, ${point(center)}, ${status})`;
    await tenant(T_TRISHAL, 'loc-trishal', areaId.get('BD45610094')!, TRISHAL_TOWN);
    await tenant(T_BHALUKA, 'loc-bhaluka', areaId.get('BD45610013')!, BHALUKA_TOWN);
    await tenant(
      T_FULBARIA_SUSPENDED,
      'loc-fulbaria',
      areaId.get('BD45610020')!,
      FULBARIA_TOWN,
      'suspended',
    );
    await tenant(T_MIRPUR_RADIUS, 'loc-mirpur', AREA_MIRPUR, MIRPUR_10);
    await tenant(T_KAFRUL_RADIUS, 'loc-kafrul', AREA_KAFRUL, [23.7926, 90.3812]);
    // A small radius tenant whose centre is right next to a point inside Trishal.
    await tenant(T_TOWN_RADIUS, 'loc-town', AREA_TOWN, [24.5902, 90.3939]);
    await admin`update tenants set boundary_mode = 'radius', service_radius_km = 4 where id in (${T_MIRPUR_RADIUS}, ${T_KAFRUL_RADIUS})`;
    await admin`update tenants set boundary_mode = 'radius', service_radius_km = 0.5 where id = ${T_TOWN_RADIUS}`;
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await Promise.all([admin.end(), app.end()]);
    }
  });

  describe('import', () => {
    it('loads every real area once, by pcode, with a healthy tree (idempotent)', async () => {
      const counts = await admin<{ level_code: string; n: number }[]>`
        select level_code, count(*)::int as n from geo_areas where cod_pcode is not null group by level_code`;
      const n = (level: string) => counts.find((c) => c.level_code === level)?.n;
      expect([n('division'), n('district'), n('upazila'), n('city_corporation')]).toEqual([
        8, 64, 495, 12,
      ]);

      await as(admin, SYSTEM, (tx) => importReference(tx, reference));
      const [again] = await admin<
        { n: number }[]
      >`select count(*)::int as n from geo_areas where cod_pcode is not null`;
      expect(again!.n).toBe(reference.areas.length);
      await as(admin, SYSTEM, async (tx) => {
        await reparentPointsByContainment(tx);
        expect((await checkImport(tx, reference)).problems).toEqual([]);
      });
    });

    it('keeps Bengali names and a boundary-derived centre inside its polygon', async () => {
      const [trishal] = await admin<{ name_bn: string; inside: boolean; valid: boolean }[]>`
        select name_bn, st_covers(boundary, centroid) as inside, st_isvalid(boundary::geometry) as valid
        from geo_areas where cod_pcode = 'BD45610094'`;
      expect(trishal).toEqual({ name_bn: 'ত্রিশাল', inside: true, valid: true });
    });
  });

  describe('point in tenant', () => {
    it('polygon mode: inside the real Trishal boundary, outside it in the next upazila', async () => {
      expect(await covers(T_TRISHAL, ...TRISHAL_TOWN)).toBe(true);
      expect(await covers(T_TRISHAL, ...BHALUKA_TOWN)).toBe(false);
      expect(await covers(T_BHALUKA, ...BHALUKA_TOWN)).toBe(true);
      expect(await covers(T_TRISHAL, ...CHATTOGRAM)).toBe(false);
    });

    it('radius mode: inside at 3.9 km from the centre, outside at 4.1 km', async () => {
      const [edge] = await admin<{ in39: boolean; out41: boolean; d39: number }[]>`
        with c as (select public.geo_point(${MIRPUR_10[0]}, ${MIRPUR_10[1]}) as p)
        select public.tenant_covers_point(${T_MIRPUR_RADIUS}, st_project(c.p, 3900, radians(0))) as in39,
               public.tenant_covers_point(${T_MIRPUR_RADIUS}, st_project(c.p, 4100, radians(90))) as out41,
               public.geo_distance_m(c.p, st_project(c.p, 3900, radians(0))) as d39
        from c`;
      expect(edge).toMatchObject({ in39: true, out41: false });
      expect(edge!.d39).toBeCloseTo(3900, 3);
    });

    it('distance to a tenant: 0 inside, to the circle edge in radius mode, to the border in polygon mode', async () => {
      const [row] = await admin<
        { inside: number; radius: number; border: number; direct: number }[]
      >`
        with c as (select public.geo_point(${MIRPUR_10[0]}, ${MIRPUR_10[1]}) as p)
        select public.tenant_distance_m(${T_TRISHAL}, public.geo_point(${TRISHAL_TOWN[0]}, ${TRISHAL_TOWN[1]})) as inside,
               public.tenant_distance_m(${T_MIRPUR_RADIUS}, st_project(c.p, 5000, radians(45))) as radius,
               public.tenant_distance_m(${T_TRISHAL}, public.geo_point(${BHALUKA_TOWN[0]}, ${BHALUKA_TOWN[1]})) as border,
               (select st_distance(g.boundary, public.geo_point(${BHALUKA_TOWN[0]}, ${BHALUKA_TOWN[1]}))
                  from geo_areas g where g.cod_pcode = 'BD45610094') as direct
        from c`;
      expect(row!.inside).toBe(0);
      expect(row!.radius).toBeCloseTo(1000, 2);
      expect(row!.border).toBeGreaterThan(1000);
      expect(row!.border).toBeCloseTo(row!.direct, 6);
    });
  });

  describe('nearest tenant', () => {
    it("picks the tenant that contains the point, even when another tenant's centre is nearer", async () => {
      // 24.5810,90.3939 is inside Trishal; loc-town's centre is ~1 km away, its 0.5 km circle doesn't reach.
      const [best] = await nearest(...TRISHAL_TOWN, 50_000);
      expect(best).toMatchObject({ tenant_id: T_TRISHAL, inside: true, distance_m: 0 });
      const ranked = await nearest(...TRISHAL_TOWN, 50_000, 3);
      expect(ranked.map((r) => r.tenant_id)).toEqual([T_TRISHAL, T_TOWN_RADIUS, T_BHALUKA]);
    });

    it('works for radius tenants, breaking overlap ties by the nearest centre', async () => {
      const [mirpur] = await nearest(...MIRPUR_10, 50_000);
      expect(mirpur).toMatchObject({ tenant_id: T_MIRPUR_RADIUS, inside: true });
      // Mirpur and Kafrul circles overlap here; Kafrul's centre is nearer.
      const [overlap] = await nearest(23.796, 90.379, 50_000);
      expect(overlap).toMatchObject({ tenant_id: T_KAFRUL_RADIUS, inside: true });
    });

    it('outside every tenant: the nearest by distance to its area, skipping suspended tenants', async () => {
      // Fulbaria town is inside the suspended tenant's polygon, which doesn't count.
      const ranked = await nearest(...FULBARIA_TOWN, 50_000, 5);
      expect(ranked.map((r) => r.tenant_id)).not.toContain(T_FULBARIA_SUSPENDED);
      expect(ranked[0]).toMatchObject({ tenant_id: T_TRISHAL, inside: false });
      const distances = ranked.map((r) => r.distance_m);
      expect(distances).toEqual([...distances].sort((a, b) => a - b));
    });

    it('finds nothing beyond the maximum distance', async () => {
      expect(await nearest(...CHATTOGRAM, 50_000)).toEqual([]);
    });

    it('works for an anonymous app session through RLS, and ignores archived tenants', async () => {
      const rows = await as(
        app,
        ANONYMOUS,
        (tx) =>
          tx<
            { tenant_id: string }[]
          >`select tenant_id from public.nearest_tenants(public.geo_point(${TRISHAL_TOWN[0]}, ${TRISHAL_TOWN[1]}), 50000, 1)`,
      );
      expect(rows).toEqual([{ tenant_id: T_TRISHAL }]);
      await admin`update tenants set status_code = 'archived' where id = ${T_BHALUKA}`;
      const [bhaluka] = await nearest(...BHALUKA_TOWN, 50_000);
      expect(bhaluka!.tenant_id).not.toBe(T_BHALUKA);
      await admin`update tenants set status_code = 'active' where id = ${T_BHALUKA}`;
    });
  });

  describe('distances (WGS84, metres)', () => {
    it.each([
      {
        label: 'Parliament → Airport',
        a: [23.7625, 90.3783],
        b: [23.8433, 90.3978],
        expected: 9167.01,
      },
      {
        label: 'Motijheel → Mirpur 10',
        a: [23.7302, 90.4172],
        b: [23.8069, 90.3687],
        expected: 9828.731,
      },
      {
        label: 'Sadarghat → Airport',
        a: [23.7059, 90.4086],
        b: [23.8433, 90.3978],
        expected: 15257.498,
      },
      {
        label: 'Mirpur 10 → Trishal',
        a: [23.8069, 90.3687],
        b: [24.581, 90.3939],
        expected: 85778.338,
      },
    ])('$label = $expected m, to the millimetre', async ({ a, b, expected }) => {
      const [row] = await admin<{ d: number }[]>`
        select public.geo_distance_m(public.geo_point(${a[0]!}, ${a[1]!}), public.geo_point(${b[0]!}, ${b[1]!})) as d`;
      expect(row!.d).toBeCloseTo(expected, 3);
    });
  });

  describe('map viewport', () => {
    it('returns the upazilas in view with simplified boundaries, capped', async () => {
      const inView = await admin<{ cod_pcode: string; has_shape: boolean }[]>`
        select cod_pcode, boundary_simplified is not null as has_shape
        from public.geo_areas_in_bbox(90.30, 24.50, 90.50, 24.65, 'upazila', 50)`;
      const pcodes = inView.map((r) => r.cod_pcode);
      expect(pcodes).toContain('BD45610094'); // Trishal
      expect(pcodes).not.toContain('BD45610013'); // Bhaluka is further south
      // Trishal's polygon is loaded (pilot fixture); areas without one come back with their centre only.
      expect(inView.find((r) => r.cod_pcode === 'BD45610094')?.has_shape).toBe(true);

      const capped =
        await admin`select 1 from public.geo_areas_in_bbox(88, 20, 93, 27, 'district', 5)`;
      expect(capped).toHaveLength(5);
    });
  });

  describe('tenant boundary columns', () => {
    it('require a radius exactly in radius mode', async () => {
      await expect(
        admin`update tenants set boundary_mode = 'radius', service_radius_km = null where id = ${T_TRISHAL}`,
      ).rejects.toThrow(/tenants_service_radius_ck/);
      await expect(
        admin`update tenants set service_radius_km = 3 where id = ${T_TRISHAL}`,
      ).rejects.toThrow(/tenants_service_radius_ck/);
      await expect(
        admin`update tenants set boundary_mode = 'circle' where id = ${T_TRISHAL}`,
      ).rejects.toThrow(/tenants_boundary_mode_ck/);
    });
  });
});
