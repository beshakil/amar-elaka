import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * Ownership and discovery across tenant boundaries (0023, schema.md §13.26,
 * test plan §G): resolve_owning_tenant picks the tenant that owns a new post
 * at a point, discover_nearby finds public rows by radius whichever tenant
 * owns them — while plain SELECTs stay exactly as tenant-isolated as before.
 *
 * Two square upazilas side by side at latitude 24.05 (1° of longitude ≈
 * 101.7 km there), with an 8.1 km gap between them:
 *
 *   A: lng 90.00–90.10        gap        B: lng 90.18–90.28
 *
 * The platform boundary_buffer_km is the seeded 5 km.
 */

const FIXTURE = '0191e3a0-d15c-7000-8000-%';
const PARTNER = '0191e3a0-d15c-7000-8000-000000000001';
const AREA_A = '0191e3a0-d15c-7000-8000-000000000011';
const AREA_B = '0191e3a0-d15c-7000-8000-000000000012';
const TENANT_A = '0191e3a0-d15c-7000-8000-000000000021';
const TENANT_B = '0191e3a0-d15c-7000-8000-000000000022';
const USER_A = '0191e3a0-d15c-7000-8000-000000000031';
const USER_B = '0191e3a0-d15c-7000-8000-000000000032';
const MEMBER_A = '0191e3a0-d15c-7000-8000-000000000041';
const MEMBER_B = '0191e3a0-d15c-7000-8000-000000000042';
const CATEGORY = '0191e3a0-d15c-7000-8000-000000000051';
const CATEGORY_OTHER = '0191e3a0-d15c-7000-8000-000000000052';
const CATEGORY_PLACE = '0191e3a0-d15c-7000-8000-000000000053';
const SCHEMA = '0191e3a0-d15c-7000-8000-000000000061';
const SCHEMA_OTHER = '0191e3a0-d15c-7000-8000-000000000062';

const POST_A_LIVE = '0191e3a0-d15c-7000-8000-000000000101';
const POST_B_LIVE = '0191e3a0-d15c-7000-8000-000000000102';
const POST_B_DRAFT = '0191e3a0-d15c-7000-8000-000000000103';
const POST_B_SOLD = '0191e3a0-d15c-7000-8000-000000000104';
const POST_B_DELETED = '0191e3a0-d15c-7000-8000-000000000105';
const POST_B_HIDDEN = '0191e3a0-d15c-7000-8000-000000000106';
const POST_B_OTHER_CATEGORY = '0191e3a0-d15c-7000-8000-000000000107';
const POST_B_FAR = '0191e3a0-d15c-7000-8000-000000000108';
const PLACE_B = '0191e3a0-d15c-7000-8000-000000000201';

const LAT = 24.05;
const square = (west: number, east: number, south = 24.0, north = 24.1) =>
  `SRID=4326;MULTIPOLYGON(((${west} ${south},${east} ${south},${east} ${north},${west} ${north},${west} ${south})))`;
const point = (lng: number, lat = LAT) => `SRID=4326;POINT(${lng} ${lat})`;

type Context = Record<string, string>;
const AS_PLATFORM: Context = { role: 'platform_admin', is_platform_admin: 'true' };
const AS_ANONYMOUS: Context = { role: 'anonymous' };
const AS_MEMBER_OF_A: Context = {
  tenant_id: TENANT_A,
  user_id: USER_A,
  member_id: MEMBER_A,
  role: 'member',
};

async function as<T>(sql: Sql, context: Context, work: (tx: TransactionSql) => Promise<T>) {
  return sql.begin(async (tx) => {
    for (const [key, value] of Object.entries(context)) {
      await tx`select set_config(${`app.${key}`}, ${value}, true)`;
    }
    return work(tx);
  }) as Promise<T>;
}

interface Owner {
  tenant_id: string;
  resolution_code: string;
}

interface Hit {
  entity: string;
  id: string;
  tenant_id: string;
  distance_m: number;
}

describe('Cross-tenant ownership and discovery (0023)', () => {
  let admin: Sql;
  let app: Sql;

  const resolve = async (lng: number | null, fallback = TENANT_A): Promise<Owner> => {
    const rows = await as(
      app,
      AS_ANONYMOUS,
      (tx) => tx<Owner[]>`
        select tenant_id, resolution_code
        from public.resolve_owning_tenant(${lng === null ? null : point(lng)}::geography, ${fallback})`,
    );
    expect(rows).toHaveLength(1);
    return rows[0]!;
  };

  const discover = (
    options: {
      radiusKm?: number;
      kinds?: string[];
      categoryIds?: string[] | null;
      limit?: number;
      offset?: number;
    } = {},
    context: Context = AS_MEMBER_OF_A,
  ) =>
    as(
      app,
      context,
      (tx) => tx<Hit[]>`
        select entity, id, tenant_id, distance_m
        from public.discover_nearby(
          ${point(90.05)}::geography,
          ${options.radiusKm ?? 20},
          ${options.kinds ?? ['post', 'place']}::text[],
          ${options.categoryIds ?? null}::uuid[],
          ${options.limit ?? 50},
          ${options.offset ?? 0})`,
    );

  async function cleanUp(): Promise<void> {
    await admin`delete from posts where tenant_id::text like ${FIXTURE}`;
    await admin`delete from places where tenant_id::text like ${FIXTURE}`;
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_settings where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    app = testSqlClient(1, resolveTestAppDatabaseUrl());
    await cleanUp();

    await admin`
      insert into users (id, phone_e164) values
        (${USER_A}, '+8801799000001'),
        (${USER_B}, '+8801799000002')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Discovery Partner', 'Discovery Partner', '+8801799000099')`;
    // A's simplified boundary stops short of its real east edge (90.09 vs
    // 90.10), so a point between them tells which of the two is used.
    await admin`
      insert into geo_areas
        (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release, boundary, boundary_simplified)
      values
        (${AREA_A}, 3, 'upazila', 'discovery-a', 'Discovery Area A', 'fixture',
          ${square(90.0, 90.1)}, ${square(90.0, 90.09)}),
        (${AREA_B}, 3, 'upazila', 'discovery-b', 'Discovery Area B', 'fixture',
          ${square(90.18, 90.28)}, ${square(90.18, 90.28)})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values
        (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'discovery-a', 'এ', 'A', ${point(90.05)}, 'active'),
        (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'discovery-b', 'বি', 'B', ${point(90.23)}, 'active')`;
    await admin`
      insert into tenant_settings (tenant_id) values (${TENANT_A}), (${TENANT_B})`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${MEMBER_A}, ${TENANT_A}, ${USER_A}, 'member'),
        (${MEMBER_B}, ${TENANT_B}, ${USER_B}, 'member')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en) values
        (${CATEGORY}, 'marketplace', 'discovery-category', 'বিভাগ', 'Category'),
        (${CATEGORY_OTHER}, 'marketplace', 'discovery-category-other', 'অন্য', 'Other'),
        (${CATEGORY_PLACE}, 'place', 'discovery-category-place', 'স্থান', 'Place')`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, status_code) values
        (${SCHEMA}, ${CATEGORY}, 1, '{}'::jsonb, 'draft'),
        (${SCHEMA_OTHER}, ${CATEGORY_OTHER}, 1, '{}'::jsonb, 'draft')`;

    const post = (
      id: string,
      tenant: string,
      member: string,
      lng: number,
      extra: { status?: string; category?: string; schema?: string; lat?: number } = {},
    ) => admin`
      insert into posts
        (id, tenant_id, author_member_id, category_id, field_schema_id, title, status_code,
         published_at, bumped_at, location, sold_at)
      values
        (${id}, ${tenant}, ${member}, ${extra.category ?? CATEGORY}, ${extra.schema ?? SCHEMA},
         'discovery post', ${extra.status ?? 'live'}, now(), now(), ${point(lng, extra.lat)},
         ${extra.status === 'sold' ? new Date() : null})`;

    await post(POST_A_LIVE, TENANT_A, MEMBER_A, 90.06); // ~1 km from the search point
    await post(POST_B_LIVE, TENANT_B, MEMBER_B, 90.2); // ~15.3 km, across the boundary
    await post(POST_B_DRAFT, TENANT_B, MEMBER_B, 90.19, { status: 'draft' });
    await post(POST_B_SOLD, TENANT_B, MEMBER_B, 90.19, { status: 'sold' });
    await post(POST_B_DELETED, TENANT_B, MEMBER_B, 90.19);
    await admin`update posts set deleted_at = now(), deletion_reason_code = 'user_deleted' where id = ${POST_B_DELETED}`;
    await post(POST_B_HIDDEN, TENANT_B, MEMBER_B, 90.19);
    await admin`update posts set hidden_by_owner = true where id = ${POST_B_HIDDEN}`;
    await post(POST_B_OTHER_CATEGORY, TENANT_B, MEMBER_B, 90.19, {
      category: CATEGORY_OTHER,
      schema: SCHEMA_OTHER,
      lat: 24.06,
    });
    // ~60 km away: beyond search_max_radius_km (seeded 50) however large a radius is asked for.
    await post(POST_B_FAR, TENANT_B, MEMBER_B, 90.64);

    await admin`
      insert into places (id, tenant_id, category_id, slug, name_bn, location, source_code, status_code)
      values (${PLACE_B}, ${TENANT_B}, ${CATEGORY_PLACE}, 'discovery-place', 'দোকান',
              ${point(90.19, 24.04)}, 'user_submitted', 'published')`;
  }, 60_000);

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await admin.end();
      await app.end();
    }
  });

  describe('resolve_owning_tenant', () => {
    it('gives a point inside a boundary to that tenant', async () => {
      await expect(resolve(90.05)).resolves.toEqual({
        tenant_id: TENANT_A,
        resolution_code: 'inside_boundary',
      });
      await expect(resolve(90.23, TENANT_A)).resolves.toEqual({
        tenant_id: TENANT_B,
        resolution_code: 'inside_boundary',
      });
    });

    it('treats a point exactly on the boundary as inside', async () => {
      const [row] = await as(
        app,
        AS_ANONYMOUS,
        (tx) => tx<Owner[]>`
          select tenant_id, resolution_code
          from public.resolve_owning_tenant(${point(90.1, 24.1)}::geography, ${TENANT_B})`,
      );
      expect(row).toEqual({ tenant_id: TENANT_A, resolution_code: 'inside_boundary' });
    });

    it('uses the full-precision boundary, not the simplified one', async () => {
      // Inside A's real boundary (east edge 90.10), outside its simplified one (90.09).
      await expect(resolve(90.095, TENANT_B)).resolves.toEqual({
        tenant_id: TENANT_A,
        resolution_code: 'inside_boundary',
      });
    });

    it('gives a point within both buffers to the nearest tenant', async () => {
      // 3.6 km from A, 4.6 km from B.
      await expect(resolve(90.135, TENANT_B)).resolves.toEqual({
        tenant_id: TENANT_A,
        resolution_code: 'within_buffer',
      });
      // 4.6 km from A, 3.6 km from B.
      await expect(resolve(90.145, TENANT_A)).resolves.toEqual({
        tenant_id: TENANT_B,
        resolution_code: 'within_buffer',
      });
    });

    it("honours a tenant's own boundary_buffer_km override", async () => {
      await as(
        admin,
        AS_PLATFORM,
        (tx) => tx`
          update tenant_settings set setting_overrides = '{"boundary_buffer_km": 1}'::jsonb
          where tenant_id = ${TENANT_B}`,
      );
      try {
        // 3.6 km from B is now outside B's 1 km buffer; A's 5 km still reaches.
        await expect(resolve(90.145, TENANT_B)).resolves.toEqual({
          tenant_id: TENANT_A,
          resolution_code: 'within_buffer',
        });
      } finally {
        await as(
          admin,
          AS_PLATFORM,
          (tx) => tx`
            update tenant_settings set setting_overrides = '{}'::jsonb where tenant_id = ${TENANT_B}`,
        );
      }
    });

    it('falls back to the request tenant beyond every buffer', async () => {
      await expect(resolve(91.0, TENANT_B)).resolves.toEqual({
        tenant_id: TENANT_B,
        resolution_code: 'beyond_buffer_fallback',
      });
    });

    it('gives a post without a location to the request tenant', async () => {
      await expect(resolve(null, TENANT_B)).resolves.toEqual({
        tenant_id: TENANT_B,
        resolution_code: 'no_location',
      });
    });
  });

  describe('discover_nearby', () => {
    it("returns the other tenant's live post within the radius, nearest first", async () => {
      const hits = await discover();
      expect(hits.map((hit) => hit.id).sort()).toEqual(
        [POST_A_LIVE, POST_B_LIVE, POST_B_OTHER_CATEGORY, PLACE_B].sort(),
      );
      expect(hits[0]).toMatchObject({ entity: 'post', id: POST_A_LIVE, tenant_id: TENANT_A });
      expect(hits.find((hit) => hit.id === POST_B_LIVE)?.tenant_id).toBe(TENANT_B);
      const distances = hits.map((hit) => hit.distance_m);
      expect(distances).toEqual([...distances].sort((a, b) => a - b));
    });

    it('never returns drafts, sold, soft-deleted or owner-hidden posts', async () => {
      const ids = (await discover()).map((hit) => hit.id);
      for (const hidden of [POST_B_DRAFT, POST_B_SOLD, POST_B_DELETED, POST_B_HIDDEN]) {
        expect(ids).not.toContain(hidden);
      }
    });

    it('filters by kind and by category (a category filter leaves out other categories)', async () => {
      expect((await discover({ kinds: ['place'] })).map((hit) => hit.id)).toEqual([PLACE_B]);
      expect((await discover({ categoryIds: [CATEGORY] })).map((hit) => hit.id).sort()).toEqual(
        [POST_A_LIVE, POST_B_LIVE].sort(),
      );
    });

    it('clamps the radius to search_max_radius_km', async () => {
      const ids = (await discover({ radiusKm: 100 })).map((hit) => hit.id);
      expect(ids).toContain(POST_B_LIVE);
      expect(ids).not.toContain(POST_B_FAR);
    });

    it('pages stably with limit and offset', async () => {
      const all = await discover();
      const second = await discover({ limit: 1, offset: 1 });
      expect(second).toEqual([all[1]]);
    });

    it('rejects a missing radius and a non-positive limit', async () => {
      await expect(discover({ radiusKm: 0 })).rejects.toMatchObject({ code: '22023' });
      await expect(discover({ limit: 0 })).rejects.toMatchObject({ code: '22023' });
    });

    it("leaves RLS unchanged: the hit is readable only in its owner's context", async () => {
      const inViewerContext = await as(
        app,
        AS_MEMBER_OF_A,
        (tx) => tx`select id from posts where id = ${POST_B_LIVE}`,
      );
      expect(inViewerContext).toHaveLength(0);

      const inOwnerContext = await as(
        app,
        { tenant_id: TENANT_B, role: 'anonymous' },
        (tx) => tx`select id from posts where id = ${POST_B_LIVE}`,
      );
      expect(inOwnerContext).toHaveLength(1);
    });

    it('works for an anonymous visitor with no tenant context', async () => {
      const hits = await discover({}, AS_ANONYMOUS);
      expect(hits.map((hit) => hit.id)).toContain(POST_B_LIVE);
    });
  });
});
