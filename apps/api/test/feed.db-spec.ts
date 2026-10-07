import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * The feed's ranking functions (0030, ADR 035), called as ae_app exactly as
 * FeedRepository does: radius correctness across a tenant boundary, the
 * country scope, landmark inclusion, the boost slot cap, cursor stability
 * while rows are inserted between pages, field filters and photo_count.
 *
 * Two square upazilas side by side at latitude 24.05 (1° of longitude ≈
 * 101.7 km there), sharing the edge at lng 90.10:
 *
 *   A: lng 90.00–90.10 | B: lng 90.10–90.20
 *
 * The viewer stands in A at lng 90.08, 2 km from B.
 */

const FIXTURE = '0191e3a0-fee0-7000-8000-%';
const PARTNER = '0191e3a0-fee0-7000-8000-000000000001';
const AREA_A = '0191e3a0-fee0-7000-8000-000000000011';
const AREA_B = '0191e3a0-fee0-7000-8000-000000000012';
const TENANT_A = '0191e3a0-fee0-7000-8000-000000000021';
const TENANT_B = '0191e3a0-fee0-7000-8000-000000000022';
const USER_A = '0191e3a0-fee0-7000-8000-000000000031';
const USER_B = '0191e3a0-fee0-7000-8000-000000000032';
const MEMBER_A = '0191e3a0-fee0-7000-8000-000000000041';
const MEMBER_B = '0191e3a0-fee0-7000-8000-000000000042';
const CATEGORY = '0191e3a0-fee0-7000-8000-000000000051';
const CATEGORY_SHIPPABLE = '0191e3a0-fee0-7000-8000-000000000052';
const CATEGORY_PLACE = '0191e3a0-fee0-7000-8000-000000000053';
const SCHEMA = '0191e3a0-fee0-7000-8000-000000000061';
const SCHEMA_SHIPPABLE = '0191e3a0-fee0-7000-8000-000000000062';
const BOOST_TYPE_HOME = '0191e3a0-fee0-7000-8000-000000000071';
const BOOST_TYPE_HIGHLIGHT = '0191e3a0-fee0-7000-8000-000000000072';
const MEDIA_1 = '0191e3a0-fee0-7000-8000-000000000081';
const MEDIA_2 = '0191e3a0-fee0-7000-8000-000000000082';

const ORIGIN_LNG = 90.08;
const LAT = 24.05;
const square = (west: number, east: number, south = 24.0, north = 24.1) =>
  `SRID=4326;MULTIPOLYGON(((${west} ${south},${east} ${south},${east} ${north},${west} ${north},${west} ${south})))`;
const point = (lng: number, lat = LAT) => `SRID=4326;POINT(${lng} ${lat})`;
const ORIGIN = point(ORIGIN_LNG);

const RANK = {
  w_distance: 0.3,
  w_recency: 0.35,
  w_boost: 0.5,
  w_trust: 0.15,
  w_completeness: 0.2,
  distance_half_km: 2,
  recency_half_life_hours: 48,
  photo_target: 4,
  trust_default: 50,
};

type Context = Record<string, string>;
const AS_VISITOR_OF_A: Context = { tenant_id: TENANT_A, role: 'anon' };

async function as<T>(sql: Sql, context: Context, work: (tx: TransactionSql) => Promise<T>) {
  return sql.begin(async (tx) => {
    for (const [key, value] of Object.entries(context)) {
      await tx`select set_config(${`app.${key}`}, ${value}, true)`;
    }
    return work(tx);
  }) as Promise<T>;
}

interface Ranked {
  id: string;
  tenant_id: string;
  score: number;
  distance_m: number | null;
  is_boosted: boolean;
  is_highlighted: boolean;
}

interface Near {
  id: string;
  tenant_id: string;
  distance_m: number;
}

/** A fixture id in the 0x1000+ range, one per post. */
let nextPost = 0x1000;
const postId = () => `0191e3a0-fee0-7000-8000-${(nextPost++).toString(16).padStart(12, '0')}`;

describe('Feed ranking functions (0030)', () => {
  let admin: Sql;
  let app: Sql;

  const rank = (
    options: {
      radiusKm?: number | null;
      categoryIds?: string[] | null;
      shippableOnly?: boolean;
      filters?: unknown[] | null;
      placement?: string;
      asOf?: Date;
      after?: { score: number; id: string } | null;
      limit?: number;
    } = {},
  ) =>
    as(
      app,
      AS_VISITOR_OF_A,
      (tx) => tx<Ranked[]>`
        select id, tenant_id, score, distance_m, is_boosted, is_highlighted
        from public.feed_posts(
          ${ORIGIN}::geography,
          ${options.radiusKm === undefined ? 5 : options.radiusKm}::double precision,
          ${options.categoryIds ?? null}::uuid[],
          ${options.shippableOnly ?? false},
          ${options.filters ? JSON.stringify(options.filters) : null}::text::jsonb,
          ${options.placement ?? 'home_featured'},
          ${JSON.stringify(RANK)}::text::jsonb,
          ${(options.asOf ?? new Date()).toISOString()}::timestamptz,
          ${options.after?.score ?? null}::double precision,
          ${options.after?.id ?? null}::uuid,
          ${options.limit ?? 50})`,
    );

  const post = async (
    lng: number,
    extra: {
      tenant?: string;
      member?: string;
      category?: string;
      schema?: string;
      ageHours?: number;
      at?: Date;
      fields?: Record<string, unknown>;
      status?: string;
      lat?: number;
    } = {},
  ): Promise<string> => {
    const id = postId();
    const at = extra.at ?? new Date(Date.now() - (extra.ageHours ?? 1) * 3_600_000);
    await admin`
      insert into posts
        (id, tenant_id, author_member_id, category_id, field_schema_id, title, status_code,
         published_at, bumped_at, location, fields)
      values
        (${id}, ${extra.tenant ?? TENANT_A}, ${extra.member ?? MEMBER_A},
         ${extra.category ?? CATEGORY}, ${extra.schema ?? SCHEMA}, 'feed post',
         ${extra.status ?? 'live'}, ${at}, ${at}, ${point(lng, extra.lat)},
         ${admin.json((extra.fields ?? {}) as never)})`;
    return id;
  };

  const boost = (
    postIdValue: string,
    options: { tenant?: string; member?: string; type?: string; startedHoursAgo: number },
  ) => admin`
    insert into boosts
      (tenant_id, boost_type_id, post_id, purchased_by_member_id, starts_at, ends_at, cost_credits, status_code)
    values
      (${options.tenant ?? TENANT_A}, ${options.type ?? BOOST_TYPE_HOME}, ${postIdValue},
       ${options.member ?? MEMBER_A}, now() - make_interval(hours => ${options.startedHoursAgo}),
       now() + interval '1 day', 0, 'active')`;

  // The feed measures on the sphere (use_spheroid = false, ADR 035).
  const distanceTo = async (id: string) => {
    const [row] = await admin<{ d: number }[]>`
      select st_distance(location, ${ORIGIN}::geography, false) as d from posts where id = ${id}`;
    return row!.d;
  };

  async function clearPosts(): Promise<void> {
    await admin`delete from boosts where tenant_id::text like ${FIXTURE}`;
    await admin`delete from media_attachments where tenant_id::text like ${FIXTURE}`;
    await admin`delete from media_assets where tenant_id::text like ${FIXTURE}`;
    await admin`delete from posts where tenant_id::text like ${FIXTURE}`;
  }

  async function cleanUp(): Promise<void> {
    await clearPosts();
    await admin`delete from places where tenant_id::text like ${FIXTURE}`;
    await admin`delete from boost_types where id::text like ${FIXTURE}`;
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
        (${USER_A}, '+8801799100001'),
        (${USER_B}, '+8801799100002')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Feed Partner', 'Feed Partner', '+8801799100099')`;
    await admin`
      insert into geo_areas
        (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release, boundary, boundary_simplified)
      values
        (${AREA_A}, 3, 'upazila', 'feed-a', 'Feed Area A', 'fixture', ${square(90.0, 90.1)}, ${square(90.0, 90.1)}),
        (${AREA_B}, 3, 'upazila', 'feed-b', 'Feed Area B', 'fixture', ${square(90.1, 90.2)}, ${square(90.1, 90.2)})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values
        (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'feed-a', 'এ', 'A', ${point(90.05)}, 'active'),
        (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'feed-b', 'বি', 'B', ${point(90.15)}, 'active')`;
    await admin`insert into tenant_settings (tenant_id) values (${TENANT_A}), (${TENANT_B})`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${MEMBER_A}, ${TENANT_A}, ${USER_A}, 'member'),
        (${MEMBER_B}, ${TENANT_B}, ${USER_B}, 'member')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en, is_shippable) values
        (${CATEGORY}, 'marketplace', 'feed-category', 'বিভাগ', 'Category', false),
        (${CATEGORY_SHIPPABLE}, 'marketplace', 'feed-category-shippable', 'পাঠানো যায়', 'Shippable', true),
        (${CATEGORY_PLACE}, 'place', 'feed-category-place', 'স্থান', 'Place', false)`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, status_code) values
        (${SCHEMA}, ${CATEGORY}, 1,
         '{"type":"object","properties":{"condition":{"type":"string"},"rooms":{"type":"integer"}}}'::jsonb,
         'draft'),
        (${SCHEMA_SHIPPABLE}, ${CATEGORY_SHIPPABLE}, 1, '{}'::jsonb, 'draft')`;
    await admin`
      insert into boost_types
        (id, code, name_key, placement_code, target_code, duration_hours, default_cost_credits, min_cost_credits, max_cost_credits)
      values
        (${BOOST_TYPE_HOME}, 'feed-home', 'enum.boost_types.fixture', 'home_featured', 'post', 24, 50, 10, 200),
        (${BOOST_TYPE_HIGHLIGHT}, 'feed-highlight', 'enum.boost_types.fixture', 'highlight', 'post', 24, 50, 10, 200)`;
  }, 60_000);

  afterEach(clearPosts);

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await admin.end();
      await app.end();
    }
  });

  describe('radius', () => {
    it('returns exactly the live posts within the radius, across the tenant boundary', async () => {
      const inA = await post(90.06); // ~2 km, same tenant
      const inB = await post(90.12, { tenant: TENANT_B, member: MEMBER_B }); // ~4.1 km, other tenant
      const justInside = await post(90.129); // ~4.98 km
      const justOutside = await post(90.13); // ~5.09 km
      const farInB = await post(90.19, { tenant: TENANT_B, member: MEMBER_B }); // ~11 km
      const draft = await post(90.07, { status: 'draft' });

      const expected = [];
      for (const id of [inA, inB, justInside, justOutside, farInB]) {
        if ((await distanceTo(id)) <= 5_000) expected.push(id);
      }
      expect(expected).toEqual(expect.arrayContaining([inA, inB, justInside]));
      expect(expected).not.toContain(justOutside);

      const rows = await rank({ radiusKm: 5 });
      expect(rows.map((r) => r.id).sort()).toEqual(expected.sort());
      expect(rows.map((r) => r.id)).not.toContain(draft);
      for (const row of rows) {
        expect(row.distance_m).toBeCloseTo(await distanceTo(row.id), 3);
      }
    });

    it('clamps an oversized radius to feed_max_radius_km', async () => {
      // 90.08 + 0.26° ≈ 26.4 km: beyond the seeded 25 km cap, whatever is asked for.
      const beyondCap = await post(90.34, { tenant: TENANT_B, member: MEMBER_B });
      const withinCap = await post(90.3, { tenant: TENANT_B, member: MEMBER_B });
      const ids = (await rank({ radiusKm: 500 })).map((r) => r.id);
      expect(ids).toContain(withinCap);
      expect(ids).not.toContain(beyondCap);
    });

    it('country scope ignores distance but keeps to shippable categories', async () => {
      const far = await post(91.5, { category: CATEGORY_SHIPPABLE, schema: SCHEMA_SHIPPABLE });
      const nearNotShippable = await post(90.081);
      const ids = (await rank({ radiusKm: null, shippableOnly: true })).map((r) => r.id);
      expect(ids).toContain(far);
      expect(ids).not.toContain(nearNotShippable);
    });

    it('refuses no radius without the shippable restriction', async () => {
      await expect(rank({ radiusKm: null, shippableOnly: false })).rejects.toThrow(
        /only for shippable categories/,
      );
    });
  });

  describe('ranking', () => {
    it('ranks nearer and fresher posts higher, all else equal', async () => {
      const near = await post(90.085, { ageHours: 2 });
      const far = await post(90.12, { ageHours: 2 });
      const old = await post(90.085, { ageHours: 200 });
      const ids = (await rank()).map((r) => r.id);
      expect(ids.indexOf(near)).toBeLessThan(ids.indexOf(far));
      expect(ids.indexOf(near)).toBeLessThan(ids.indexOf(old));
    });

    it('credits completeness: filled fields of the schema', async () => {
      const bare = await post(90.085);
      const filled = await post(90.085, { fields: { condition: 'new', rooms: 3 } });
      const rows = await rank();
      const score = (id: string) => rows.find((r) => r.id === id)!.score;
      // Two of two schema fields, weight 0.2, half the completeness term.
      expect(score(filled) - score(bare)).toBeCloseTo(0.2 / 2, 6);
    });

    it('applies field filters from JSON with the post-field-filters semantics', async () => {
      const match = await post(90.085, { fields: { condition: 'new', rooms: 3 } });
      const wrongValue = await post(90.085, { fields: { condition: 'used', rooms: 3 } });
      const tooFew = await post(90.085, { fields: { condition: 'new', rooms: 1 } });
      const ids = (
        await rank({
          categoryIds: [CATEGORY],
          filters: [
            { kind: 'one_of', field: 'condition', multiselect: false, values: ['new', 'like_new'] },
            { kind: 'number', field: 'rooms', op: 'gte', value: 2 },
          ],
        })
      ).map((r) => r.id);
      expect(ids).toContain(match);
      expect(ids).not.toContain(wrongValue);
      expect(ids).not.toContain(tooFew);
    });
  });

  describe('boost slot cap', () => {
    afterEach(async () => {
      await admin`update tenant_settings set setting_overrides = '{}'::jsonb where tenant_id = ${TENANT_A}`;
    });

    it('never marks more posts boosted than the tenant has slots per category', async () => {
      await admin`
        update tenant_settings set setting_overrides = '{"boost_slots_per_category": 2}'::jsonb
        where tenant_id = ${TENANT_A}`;
      const first = await post(90.09);
      const second = await post(90.09);
      const third = await post(90.09);
      const organic = await post(90.09);
      await boost(second, { startedHoursAgo: 2 });
      await boost(first, { startedHoursAgo: 3 });
      await boost(third, { startedHoursAgo: 1 }); // latest: over the cap

      const rows = await rank();
      const boosted = rows.filter((r) => r.is_boosted).map((r) => r.id);
      expect(boosted.sort()).toEqual([first, second].sort());
      const score = (id: string) => rows.find((r) => r.id === id)!.score;
      expect(score(third)).toBeCloseTo(score(organic), 6);
      expect(score(first) - score(organic)).toBeCloseTo(RANK.w_boost, 6);
    });

    it('counts slots per owning tenant, with the platform default when not overridden', async () => {
      // Platform default boost_slots_per_category is 3 (seed).
      const inB = await Promise.all(
        [0, 1, 2, 3].map(() => post(90.11, { tenant: TENANT_B, member: MEMBER_B })),
      );
      for (const [i, id] of inB.entries()) {
        await boost(id, { tenant: TENANT_B, member: MEMBER_B, startedHoursAgo: 10 - i });
      }
      const rows = await rank();
      expect(rows.filter((r) => r.is_boosted)).toHaveLength(3);
      expect(rows.find((r) => r.id === inB[3])!.is_boosted).toBe(false);
    });

    it('does not count another placement, and highlight only badges', async () => {
      const highlighted = await post(90.09);
      await boost(highlighted, { type: BOOST_TYPE_HIGHLIGHT, startedHoursAgo: 1 });
      const [home] = await rank({ placement: 'home_featured' });
      expect(home).toMatchObject({ id: highlighted, is_boosted: false, is_highlighted: true });
      const [category] = await rank({ placement: 'category_top', categoryIds: [CATEGORY] });
      expect(category!.is_boosted).toBe(false);
    });
  });

  describe('cursor', () => {
    it('pages without gaps or repeats while new posts arrive between pages', async () => {
      const originals = [];
      for (let i = 0; i < 9; i += 1) {
        originals.push(await post(90.08 + i * 0.003, { ageHours: 1 + i * 5 }));
      }
      const asOf = new Date();
      const everything = (await rank({ asOf })).map((r) => r.id);
      expect(everything.sort()).toEqual([...originals].sort());

      const seen: string[] = [];
      let after: { score: number; id: string } | null = null;
      for (let page = 0; page < 5; page += 1) {
        const rows = await rank({ asOf, after, limit: 4 });
        seen.push(...rows.map((r) => r.id));
        // New, close, fresh posts after every page: they would rank on top.
        await post(90.0801, { ageHours: 0 });
        await post(90.0802, { ageHours: 0, tenant: TENANT_B, member: MEMBER_B });
        const last = rows.at(-1);
        if (rows.length < 4 || !last) break;
        after = { score: last.score, id: last.id };
      }

      expect(seen).toEqual((await rank({ asOf })).map((r) => r.id));
      expect(new Set(seen).size).toBe(seen.length);
      expect([...seen].sort()).toEqual([...originals].sort());
    });

    it('breaks score ties by id', async () => {
      const at = new Date(Date.now() - 3 * 3_600_000);
      const a = await post(90.09, { at });
      const b = await post(90.09, { at });
      const asOf = new Date();
      const [top] = await rank({ asOf, limit: 1 });
      const [next] = await rank({ asOf, limit: 1, after: { score: top!.score, id: top!.id } });
      expect([top!.id, next!.id]).toEqual([a, b].sort().reverse());
    });
  });

  describe('stores and landmarks', () => {
    afterEach(async () => {
      await admin`delete from places where tenant_id::text like ${FIXTURE}`;
    });

    const landmark = async (
      slug: string,
      lng: number,
      radiusKm: number | null,
      isLandmark = true,
    ) => {
      await as(
        admin,
        { role: 'moderator' },
        (tx) => tx`
        insert into places
          (tenant_id, category_id, slug, name_bn, location, source_code, status_code, is_landmark, landmark_radius_km)
        values (${TENANT_B}, ${CATEGORY_PLACE}, ${slug}, 'ল্যান্ডমার্ক', ${point(lng)}, 'user_submitted',
                'published', ${isLandmark}, ${radiusKm})`,
      );
      const [row] = await admin<{ id: string }[]>`select id from places where slug = ${slug}`;
      return row!.id;
    };

    it("includes a neighbouring tenant's landmark whose own radius reaches the viewer", async () => {
      const hospital = await landmark('feed-hospital', 90.25, 20); // ~17.3 km, reach 20 km
      const smallReach = await landmark('feed-clinic', 90.15, 3); // ~7.1 km, reach 3 km
      const defaultReach = await landmark('feed-terminal', 90.16, null); // ~8.1 km, default 10 km
      const plainPlace = await landmark('feed-shop', 90.09, null, false);

      const rows = await as(
        app,
        AS_VISITOR_OF_A,
        (tx) => tx<Near[]>`
        select id, tenant_id, distance_m from public.feed_landmarks(${ORIGIN}::geography, 10, false)`,
      );
      const ids = rows.map((r) => r.id);
      expect(ids).toEqual([defaultReach, hospital]);
      expect(ids).not.toContain(smallReach);
      expect(ids).not.toContain(plainPlace);
      expect(rows.every((r) => r.tenant_id === TENANT_B)).toBe(true);
    });
  });

  describe('feed_stores', () => {
    afterEach(async () => {
      await admin`delete from stores where tenant_id::text like ${FIXTURE}`;
    });

    it('pages active stores within the radius nearest first, keyset on (distance, id)', async () => {
      // As staff: stores_protect_status forces anyone else's insert to pending_review.
      const store = (
        slug: string,
        tenant: string,
        member: string,
        lng: number,
        status = 'active',
      ) =>
        as(
          admin,
          { role: 'moderator' },
          (tx) => tx<{ id: string }[]>`
          insert into stores (tenant_id, owner_member_id, slug, name_bn, location, status_code)
          values (${tenant}, ${member}, ${slug}, 'দোকান', ${point(lng)}, ${status})
          returning id`,
        );
      const [near] = await store('feed-store-near', TENANT_A, MEMBER_A, 90.081);
      const [across] = await store('feed-store-b', TENANT_B, MEMBER_B, 90.11);
      await store('feed-store-pending', TENANT_A, MEMBER_A, 90.082, 'pending_review');
      await store('feed-store-far', TENANT_B, MEMBER_B, 90.19);

      const page = (after: { d: number; id: string } | null) =>
        as(
          app,
          AS_VISITOR_OF_A,
          (tx) => tx<Near[]>`
          select id, tenant_id, distance_m
          from public.feed_stores(${ORIGIN}::geography, 5, ${after?.d ?? null}::double precision,
                                  ${after?.id ?? null}::uuid, 1, false)`,
        );
      const [first] = await page(null);
      expect(first!.id).toBe(near!.id);
      const [second] = await page({ d: first!.distance_m, id: first!.id });
      expect(second).toMatchObject({ id: across!.id, tenant_id: TENANT_B });
      expect(await page({ d: second!.distance_m, id: second!.id })).toEqual([]);
    });
  });

  describe('photo_count', () => {
    it('follows attachments, whoever writes them', async () => {
      const id = await post(90.09);
      for (const media of [MEDIA_1, MEDIA_2]) {
        await admin`
          insert into media_assets
            (id, tenant_id, uploaded_by_user_id, kind_code, storage_key, mime_type, byte_size, checksum_sha256, status_code)
          values (${media}, ${TENANT_A}, ${USER_A}, 'image', ${`feed/${media}`}, 'image/webp', 10, ${'a'.repeat(64)}, 'ready')`;
        await admin`insert into media_attachments (tenant_id, media_asset_id, post_id) values (${TENANT_A}, ${media}, ${id})`;
      }
      const count = async () =>
        (await admin<{ photo_count: number }[]>`select photo_count from posts where id = ${id}`)[0]!
          .photo_count;
      expect(await count()).toBe(2);
      await admin`delete from media_attachments where media_asset_id = ${MEDIA_1}`;
      expect(await count()).toBe(1);
    });
  });
});
