import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * map_features (0039, 0040, ADR 045): the map's data from our own tables —
 * posts, stores, places, landmarks and info (emergency services, bus stops,
 * places in map_info_place_categories such as banks and ATMs)
 * — radius-bounded, grid-clustered by zoom, across tenants, with names in
 * both languages.
 *
 * At latitude 24.05, 0.001° of longitude ≈ 102 m. Zoom 10 cells are ≈ 9.8 km
 * (64 px); A's five posts sit within 250 m, in one cell; everything of B is
 * 15 km east. Seeded settings: cell 64 px, clustering until zoom 16, radius
 * 25 km, 500 features.
 */

const FIXTURE = '0191e3a0-fea7-7000-8000-%';
const id = (n: number) => `0191e3a0-fea7-7000-8000-${String(n).padStart(12, '0')}`;
const PARTNER = id(1);
const AREA_A = id(11);
const AREA_B = id(12);
const TENANT_A = id(21);
const TENANT_B = id(22);
const USER_A = id(31);
const USER_B = id(32);
const MEMBER_A = id(41);
const MEMBER_B = id(42);
const CATEGORY = id(51);
const CATEGORY_PLACE = id(53);
const CATEGORY_PLACE_CHILD = id(54);
const CATEGORY_BANK = id(55);
const SCHEMA = id(61);

const CLUSTER_A = [101, 102, 103, 104, 105].map(id);
const POST_B = id(201);
const POST_B_EN = id(202);
const POST_DRAFT = id(203);
const POST_HIDDEN = id(204);
const POST_DELETED = id(205);
const POST_FAR = id(206);
const STORE_B = id(301);
const PLACE_OPEN = id(401);
const PLACE_CLOSED = id(402);
const PLACE_CHILD = id(403);
const LANDMARK_B = id(404);
const PLACE_GONE = id(405);
const BANK_ATM = id(406);
const HOSPITAL_24H = id(501);
const POLICE = id(502);
const ROUTE = id(601);
const STOP = id(602);

const square = (west: number, east: number, south = 24.0, north = 24.1) =>
  `SRID=4326;MULTIPOLYGON(((${west} ${south},${east} ${south},${east} ${north},${west} ${north},${west} ${south})))`;
const point = (lng: number, lat = 24.05) => `SRID=4326;POINT(${lng} ${lat})`;

type Context = Record<string, string>;
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

interface Row {
  layer: string;
  point_count: number;
  lng: number;
  lat: number;
  id: string | null;
  tenant_id: string | null;
  name_bn: string | null;
  name_en: string | null;
  category_slug: string | null;
  price: string | null;
  info_kind: string | null;
  open_now: boolean | null;
}

const ALL = ['posts', 'stores', 'places', 'landmarks', 'info'];
/** Around both tenants; centre (90.15, 24.05). Wider than the radius, so it needs a centre. */
const VIEW = { minLng: 89.9, minLat: 23.9, maxLng: 90.4, maxLat: 24.2 };
const CENTER = { lat: 24.05, lng: 90.15 };

describe('map_features (0039, 0040)', () => {
  let admin: Sql;
  let app: Sql;
  let infoCategoriesBefore: unknown;

  const features = (
    options: {
      box?: typeof VIEW;
      zoom?: number;
      layers?: string[];
      category?: string | null;
      openNow?: boolean;
      center?: { lat: number; lng: number } | null;
      limit?: number;
    } = {},
    context: Context = AS_ANONYMOUS,
  ) => {
    const box = options.box ?? VIEW;
    const center = options.center === undefined ? CENTER : options.center;
    return as(
      app,
      context,
      (tx) => tx<Row[]>`
        select layer, point_count, lng, lat, id, tenant_id, name_bn, name_en,
               category_slug, price, info_kind, open_now
        from public.map_features(${box.minLng}, ${box.minLat}, ${box.maxLng}, ${box.maxLat},
          ${options.zoom ?? 16}, ${options.layers ?? ALL}::text[], ${options.category ?? null},
          ${options.openNow ?? false}, ${center?.lat ?? null}, ${center?.lng ?? null},
          ${options.limit ?? 100})`,
    );
  };
  const ids = (rows: Row[]) => rows.map((r) => r.id);

  async function cleanUp(): Promise<void> {
    await admin`delete from transport_route_stops where tenant_id::text like ${FIXTURE}`;
    await admin`delete from transport_routes where tenant_id::text like ${FIXTURE}`;
    await admin`delete from emergency_contacts where tenant_id::text like ${FIXTURE}`;
    await admin`delete from place_hours where tenant_id::text like ${FIXTURE}`;
    await admin`delete from posts where tenant_id::text like ${FIXTURE}`;
    await admin`delete from places where tenant_id::text like ${FIXTURE}`;
    await admin`delete from stores where tenant_id::text like ${FIXTURE}`;
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE}`;
    await admin`delete from categories where id::text like ${FIXTURE} and parent_id is not null`;
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
        (${USER_A}, '+8801799400001'), (${USER_B}, '+8801799400002')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Features Partner', 'Features Partner', '+8801799400099')`;
    await admin`
      insert into geo_areas
        (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release, boundary, boundary_simplified)
      values
        (${AREA_A}, 3, 'upazila', 'features-a', 'Features Area A', 'fixture',
          ${square(90.0, 90.1)}, ${square(90.0, 90.1)}),
        (${AREA_B}, 3, 'upazila', 'features-b', 'Features Area B', 'fixture',
          ${square(90.18, 90.28)}, ${square(90.18, 90.28)})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values
        (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'features-a', 'এ', 'A', ${point(90.05)}, 'active'),
        (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'features-b', 'বি', 'B', ${point(90.23)}, 'active')`;
    await admin`insert into tenant_settings (tenant_id) values (${TENANT_A}), (${TENANT_B})`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${MEMBER_A}, ${TENANT_A}, ${USER_A}, 'member'),
        (${MEMBER_B}, ${TENANT_B}, ${USER_B}, 'member')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en) values
        (${CATEGORY}, 'marketplace', 'features-phones', 'ফোন', 'Phones'),
        (${CATEGORY_PLACE}, 'place', 'features-health', 'স্বাস্থ্য', 'Health')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en, parent_id)
      values (${CATEGORY_PLACE_CHILD}, 'place', 'features-pharmacy', 'ফার্মেসি', 'Pharmacy', ${CATEGORY_PLACE})`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en)
      values (${CATEGORY_BANK}, 'place', 'features-bank', 'ব্যাংক', 'Bank')`;
    // The info layer's place categories: this fixture's bank category only.
    const [setting] = await admin<{ value: unknown }[]>`
      select value from platform_settings where key = 'map_info_place_categories'`;
    infoCategoriesBefore = setting!.value;
    await admin`
      update platform_settings set value = '["features-bank"]'::jsonb
      where key = 'map_info_place_categories'`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, status_code)
      values (${SCHEMA}, ${CATEGORY}, 1, '{}'::jsonb, 'draft')`;

    const post = (
      postId: string,
      tenant: string,
      member: string,
      lng: number,
      lat = 24.051,
      options: { status?: string; title?: string } = {},
    ) => admin`
      insert into posts
        (id, tenant_id, author_member_id, category_id, field_schema_id, title, status_code,
         published_at, bumped_at, location, fields)
      values
        (${postId}, ${tenant}, ${member}, ${CATEGORY}, ${SCHEMA}, ${options.title ?? 'আইফোন ১৩'},
         ${options.status ?? 'live'}, now(), now(), ${point(lng, lat)}, '{"price": "65000.00"}'::jsonb)`;

    for (const [i, postId] of CLUSTER_A.entries()) {
      await post(postId, TENANT_A, MEMBER_A, 90.05 + i * 0.0005, 24.051 + i * 0.0002);
    }
    await post(POST_B, TENANT_B, MEMBER_B, 90.2);
    await post(POST_B_EN, TENANT_B, MEMBER_B, 90.21, 24.06, { title: 'iPhone 13 128GB' });
    await post(POST_DRAFT, TENANT_A, MEMBER_A, 90.0505, 24.0512, { status: 'draft' });
    await post(POST_HIDDEN, TENANT_A, MEMBER_A, 90.0505);
    await admin`update posts set hidden_by_owner = true where id = ${POST_HIDDEN}`;
    await post(POST_DELETED, TENANT_A, MEMBER_A, 90.0505);
    await admin`update posts set deleted_at = now(), deletion_reason_code = 'user_deleted' where id = ${POST_DELETED}`;
    // ~40 km from the wide view's centre (90.25): beyond the 25 km radius.
    await post(POST_FAR, TENANT_B, MEMBER_B, 90.64);

    await admin`
      insert into stores (id, tenant_id, owner_member_id, slug, name_bn, name_en, location, status_code)
      values (${STORE_B}, ${TENANT_B}, ${MEMBER_B}, 'features-store', 'রহিম স্টোর', 'Rahim Store',
              ${point(90.205, 24.045)}, 'active')`;

    const place = (
      placeId: string,
      slug: string,
      lng: number,
      extra: { landmark?: boolean; category?: string; status?: string } = {},
    ) => admin`
      insert into places (id, tenant_id, category_id, slug, name_bn, name_en, location, source_code, status_code, is_landmark)
      values (${placeId}, ${TENANT_B}, ${extra.category ?? CATEGORY_PLACE}, ${slug}, ${`নাম ${slug}`}, ${`Name ${slug}`},
              ${point(lng, 24.04)}, 'user_submitted', ${extra.status ?? 'published'}, ${extra.landmark ?? false})`;
    await place(PLACE_OPEN, 'features-open', 90.19);
    await place(PLACE_CLOSED, 'features-closed', 90.191);
    await place(PLACE_CHILD, 'features-child', 90.192, { category: CATEGORY_PLACE_CHILD });
    await place(LANDMARK_B, 'features-landmark', 90.193, { landmark: true });
    await place(PLACE_GONE, 'features-gone', 90.194, { status: 'permanently_closed' });
    await place(BANK_ATM, 'features-atm', 90.195, { category: CATEGORY_BANK });
    // Insert triggers keep a new store pending and a landmark off unless staff
    // approve them: approve both as a tenant admin would.
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'tenant_admin', true)`;
      await tx`update stores set status_code = 'active' where id = ${STORE_B}`;
      await tx`update places set is_landmark = true where id = ${LANDMARK_B}`;
    });
    // Open all day every day / open one second a day (closed now, whatever the time).
    for (let day = 1; day <= 7; day++) {
      await admin`
        insert into place_hours (tenant_id, place_id, iso_day_of_week, opens_at, closes_at, closes_next_day)
        values (${TENANT_B}, ${PLACE_OPEN}, ${day}, '00:00', '00:00', true),
               (${TENANT_B}, ${PLACE_CLOSED}, ${day}, '03:00:00', '03:00:01', false)`;
    }

    await admin`
      insert into emergency_contacts (id, tenant_id, service_type_code, name_bn, name_en, phones, location, is_24h)
      values
        (${HOSPITAL_24H}, ${TENANT_B}, 'hospital', 'হাসপাতাল', 'Hospital', '{"+8801799400111"}', ${point(90.22, 24.05)}, true),
        (${POLICE}, ${TENANT_B}, 'police', 'থানা', 'Police', '{"+8801799400112"}', ${point(90.221, 24.05)}, false)`;
    await admin`
      insert into transport_routes (id, tenant_id, mode_code, name_bn, origin_name, destination_name)
      values (${ROUTE}, ${TENANT_B}, 'bus', 'বাস রুট', 'এক', 'দুই')`;
    await admin`
      insert into transport_route_stops (id, tenant_id, transport_route_id, seq, name_bn, name_en, location)
      values (${STOP}, ${TENANT_B}, ${ROUTE}, 1, 'বাস স্ট্যান্ড', 'Bus stand', ${point(90.222, 24.05)})`;
  }, 60_000);

  afterAll(async () => {
    try {
      await admin`
        update platform_settings set value = ${admin.json(infoCategoriesBefore as never)}
        where key = 'map_info_place_categories'`;
      await cleanUp();
    } finally {
      await admin.end();
      await app.end();
    }
  });

  it('clusters at low zoom, keeping a lone feature whole', async () => {
    const rows = await features({ zoom: 10, layers: ['posts'] });
    const cluster = rows.find((r) => r.point_count === 5);
    expect(cluster).toMatchObject({ layer: 'posts', id: null, name_bn: null });
    expect(cluster!.lng).toBeCloseTo(90.051, 3);
    expect(
      rows.find((r) => r.id === POST_B_EN) ?? rows.find((r) => r.point_count === 2),
    ).toBeDefined();
  });

  it('returns every feature on its own from map_cluster_until_zoom, never drafts, hidden or deleted', async () => {
    const rows = await features({ zoom: 16, layers: ['posts'] });
    expect(rows.every((r) => r.point_count === 1)).toBe(true);
    expect(ids(rows)).toEqual(expect.arrayContaining([...CLUSTER_A, POST_B, POST_B_EN]));
    for (const hidden of [POST_DRAFT, POST_HIDDEN, POST_DELETED])
      expect(ids(rows)).not.toContain(hidden);
  });

  it('carries names in both languages (a post title goes where its script says)', async () => {
    const rows = await features();
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(POST_B)).toMatchObject({
      name_bn: 'আইফোন ১৩',
      name_en: null,
      price: '65000.00',
      category_slug: 'features-phones',
    });
    expect(byId.get(POST_B_EN)).toMatchObject({ name_bn: null, name_en: 'iPhone 13 128GB' });
    expect(byId.get(STORE_B)).toMatchObject({
      layer: 'stores',
      name_bn: 'রহিম স্টোর',
      name_en: 'Rahim Store',
    });
    expect(byId.get(HOSPITAL_24H)).toMatchObject({
      layer: 'info',
      info_kind: 'hospital',
      name_en: 'Hospital',
      open_now: true,
    });
    expect(byId.get(STOP)).toMatchObject({
      layer: 'info',
      info_kind: 'bus_stop',
      name_bn: 'বাস স্ট্যান্ড',
    });
  });

  it('toggles each layer on its own; landmarks are not places', async () => {
    const only = async (layer: string) =>
      new Set((await features({ layers: [layer] })).map((r) => r.layer));
    for (const layer of ALL) expect(await only(layer)).toEqual(new Set([layer]));
    const places = ids(await features({ layers: ['places'] }));
    expect(places).toEqual(expect.arrayContaining([PLACE_OPEN, PLACE_CLOSED, PLACE_CHILD]));
    expect(places).not.toContain(LANDMARK_B);
    expect(places).not.toContain(PLACE_GONE); // permanently closed: not on the map
    expect(ids(await features({ layers: ['landmarks'] }))).toEqual([LANDMARK_B]);
  });

  it('shows map_info_place_categories places (banks, ATMs) as info, not as places', async () => {
    expect(ids(await features({ layers: ['places'] }))).not.toContain(BANK_ATM);
    const info = await features({ layers: ['info'] });
    expect(info.find((r) => r.id === BANK_ATM)).toMatchObject({
      layer: 'info',
      info_kind: 'features-bank',
      category_slug: null,
      name_bn: 'নাম features-atm',
      name_en: 'Name features-atm',
      tenant_id: TENANT_B,
    });
    // Its category asks for it too.
    expect(ids(await features({ category: 'features-bank' }))).toEqual([BANK_ATM]);
  });

  it('filters by category with its descendants; stores, emergency services and stops have none', async () => {
    const rows = await features({ category: 'features-health' });
    expect(new Set(rows.map((r) => r.layer))).toEqual(new Set(['places', 'landmarks']));
    expect(ids(rows)).toEqual(expect.arrayContaining([PLACE_CHILD, LANDMARK_B]));
    expect(ids(await features({ category: 'features-pharmacy' }))).toEqual([PLACE_CHILD]);
    expect(await features({ category: 'no-such-category' })).toEqual([]);
  });

  it('open_now keeps what is open: hours for places, 24h info, bus stops; posts and stores have no hours', async () => {
    const rows = await features({ openNow: true });
    const got = ids(rows);
    expect(got).toEqual(expect.arrayContaining([PLACE_OPEN, HOSPITAL_24H, STOP]));
    for (const closed of [PLACE_CLOSED, POLICE, POST_B, STORE_B]) expect(got).not.toContain(closed);
    expect(rows.find((r) => r.id === PLACE_OPEN)!.open_now).toBe(true);
  });

  it('caps the rows (the caller asks one more than map_features_max to know it was cut)', async () => {
    const rows = await features({ zoom: 10, layers: ['posts'], limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ point_count: 5 }); // biggest cluster first
  });

  it('is radius-based: never past map_viewport_max_radius_km from the centre, never filtered by tenant', async () => {
    const wide = { minLng: 89.5, minLat: 23.5, maxLng: 91.0, maxLat: 24.6 };
    const got = ids(await features({ box: wide, center: { lat: 24.05, lng: 90.25 } }));
    expect(got).toContain(CLUSTER_A[0]); // ~20 km
    expect(got).not.toContain(POST_FAR); // ~40 km
    const asMember = ids(await features({}, AS_MEMBER_OF_A)).sort();
    expect(asMember).toEqual(ids(await features()).sort());
  });

  it('without a centre, takes only a box that fits the radius', async () => {
    const small = { minLng: 90.18, minLat: 24.0, maxLng: 90.25, maxLat: 24.1 };
    expect(ids(await features({ box: small, center: null }))).toContain(POST_B);
    await expect(features({ center: null })).rejects.toThrow(/needs a centre/);
  });

  it('leaves plain SELECTs as tenant-isolated as before', async () => {
    const anonymous = await as(
      app,
      AS_ANONYMOUS,
      (tx) => tx`select id from posts where id = ${POST_DRAFT}`,
    );
    expect(anonymous).toHaveLength(0);
  });

  it('refuses a malformed request', async () => {
    await expect(
      features({ box: { minLng: 90.4, minLat: 23.9, maxLng: 89.9, maxLat: 24.2 } }),
    ).rejects.toThrow(/bbox/);
    await expect(features({ zoom: 40 })).rejects.toThrow(/zoom/);
  });
});
