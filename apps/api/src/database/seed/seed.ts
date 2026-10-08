import { createHash } from 'node:crypto';
import postgres, { type TransactionSql } from 'postgres';
import { loadDotenv } from '../../config/load-dotenv';
import {
  importBoundaries,
  importReference,
  PILOT_BOUNDARIES_PATH,
  readBoundaries,
  readReference,
  reparentPointsByContainment,
} from '../../locations/geo-import/geo-import';
import {
  checkPublishable,
  compileFieldsValidator,
  validationContextAt,
  type FieldSchema,
  type FieldValues,
} from '../../categories/field-schema';
import { CATEGORIES, type CategoryDef } from './data/categories';
import { authoredDefinitionOf, definitionOf } from './data/category-dsl';
import { sampleFields } from './data/category-samples';
import {
  BAZAR_COMMODITIES,
  COMMUNITY_MEMBER_NAMES,
  NAMED_USERS,
  TENANT_SLUGS,
} from './data/fixtures';
import { centroidOf, GEO_AREAS, randomPointIn, type GeoAreaDef } from './data/geo';
import { intBetween, pick, rngFor, seedId } from './ids';

/**
 * Idempotent dev-data seed. Every row's id is deterministic (`seedId`), and
 * every insert is `ON CONFLICT (id) DO NOTHING`, so running this twice is a
 * no-op the second time — safe to re-run after `db:reset` or by hand.
 *
 * Connects as ae_migrator (MIGRATION_DATABASE_URL) with `app.role = system`
 * and `app.is_platform_admin = true` for the whole transaction: every
 * table's RLS has a platform/system override policy (docs/specs/schema.md
 * §0.6), so this one flag combination satisfies every table's write policy
 * without needing to switch `app.tenant_id` between tenants or fake a
 * specific actor per row — the same pattern migrations 0010/0012 use for
 * their own privileged seed INSERTs. This still goes *through* RLS with a
 * declared role, not BYPASSRLS (CLAUDE.md hard rule 1).
 */

async function main(): Promise<void> {
  loadDotenv();
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('Set MIGRATION_DATABASE_URL to run the seed script.');

  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await sql.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`select set_config('app.is_platform_admin', 'true', true)`;

      const partnerId = await seedPartner(tx);
      const geoAreaIdBySlug = await seedGeoAreas(tx);
      const tenantIds = await seedTenants(tx, partnerId, geoAreaIdBySlug);
      const userIds = await seedUsers(tx);
      const memberIds = await seedTenantMembers(tx, tenantIds, userIds);
      const categoryIds = await seedCategories(tx, userIds.get('platform-admin')!);
      await seedTenantCategories(tx, tenantIds, categoryIds);
      const commodityIds = await seedBazarCommodities(tx);
      const bazarMarketIds = await seedBazarMarkets(tx, tenantIds);
      const storeIds = await seedStores(tx, tenantIds, memberIds, categoryIds);
      await seedPosts(tx, tenantIds, memberIds, storeIds, categoryIds, geoAreaIdBySlug);
      await seedPlaces(tx, tenantIds, memberIds, categoryIds, geoAreaIdBySlug);
      await seedPlaceModeration(tx, tenantIds, memberIds);
      await seedSavedAndFollows(tx, userIds.get('buyer')!);
      await seedSearchQueries(tx, tenantIds);
      await seedSavedSearches(tx, tenantIds, userIds.get('buyer')!);
      await seedEmergencyContacts(tx, tenantIds);
      await seedBloodDonors(tx, tenantIds, memberIds);
      await seedBazarPrices(
        tx,
        tenantIds,
        commodityIds,
        bazarMarketIds,
        userIds.get('tenant-admin')!,
      );
      await seedAnalyticsHistory(tx, tenantIds);
    });
    console.log('Seed complete.');
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------------------
// Seller analytics history (ADR 055)
// ---------------------------------------------------------------------------

// settings-exempt: how much demo history the dev seed writes (the screen's longest default period)
const ANALYTICS_SEED_DAYS = 30;

/**
 * Thirty finished days of analytics_daily for every live seeded post, so the
 * seller screen has a history and a trend in dev. Numbers are a stable hash
 * of post and day (the same seed, the same screen); today stays live (Redis).
 */
async function seedAnalyticsHistory(
  tx: TransactionSql,
  tenantIds: Map<string, string>,
): Promise<void> {
  const tenants = [...tenantIds.values()];
  const rows = await tx`
    insert into analytics_daily (tenant_id, entity_type, entity_id, stat_date, metrics)
    select p.tenant_id, 'post', p.id, d::date,
           jsonb_strip_nulls(jsonb_build_object(
             'views', 5 + abs(hashtext(p.id::text || d::text)) % 40,
             'unique_viewers', 4 + abs(hashtext(p.id::text || d::text)) % 30,
             'search_appearances', 10 + abs(hashtext(d::text || p.id::text)) % 60,
             'map_taps', nullif(abs(hashtext(p.id::text || 'm' || d::text)) % 4, 0),
             'saves', nullif(abs(hashtext(p.id::text || 's' || d::text)) % 3, 0),
             'contacts_call', nullif(abs(hashtext(p.id::text || 'c' || d::text)) % 3, 0),
             'contacts_whatsapp', nullif(abs(hashtext(p.id::text || 'w' || d::text)) % 2, 0)))
    from posts p
    cross join generate_series(current_date - ${ANALYTICS_SEED_DAYS}::int, current_date - 1, interval '1 day') d
    where p.tenant_id in ${tx(tenants)} and p.status_code = 'live' and p.scrubbed_at is null
    on conflict (tenant_id, entity_type, entity_id, stat_date) do nothing`;
  console.log(`analytics history: ${rows.count} post-days`);
}

// ---------------------------------------------------------------------------
// Partner
// ---------------------------------------------------------------------------

async function seedPartner(tx: TransactionSql): Promise<string> {
  const id = seedId('partner:amar-elaka-dev');
  await tx`
    insert into partners (id, legal_name, display_name, phone_e164, status_code)
    values (${id}, 'Amar Elaka Dev Partner', 'Amar Elaka Dev Partner', '+8801711000000', 'active')
    on conflict (id) do nothing`;
  console.log('partners: 1');
  return id;
}

// ---------------------------------------------------------------------------
// Geo areas
// ---------------------------------------------------------------------------

async function seedGeoAreas(tx: TransactionSql): Promise<Map<string, string>> {
  // The real hierarchy (all of Bangladesh, by pcode) plus the pilot district's
  // boundaries — the same code path as `geo:import` (ADR 026).
  const idByPcode = await importReference(tx, readReference());
  const boundaries = await importBoundaries(tx, readBoundaries(PILOT_BOUNDARIES_PATH));
  await reparentPointsByContainment(tx);
  console.log(`geo_areas: ${idByPcode.size} from the COD-AB reference, ${boundaries} boundaries`);

  const idBySlug = new Map<string, string>();
  for (const area of GEO_AREAS) {
    idBySlug.set(
      area.slug,
      area.pcode ? idByPcode.get(area.pcode)! : seedId(`geo-area:${area.slug}`),
    );
  }

  // Dev scaffolds for what the open data lacks (the Mirpur metro thana and its
  // wards): no polygon — Mirpur's tenant is centre + radius — and marked
  // verified so a tenant may use the thana.
  const scaffolds = GEO_AREAS.filter((a) => a.pcode === undefined);
  for (const level of [...new Set(scaffolds.map((a) => a.admLevel))].sort((a, b) => a - b)) {
    const rows = scaffolds
      .filter((a) => a.admLevel === level)
      .map((area) => scaffoldRow(area, idBySlug));
    await tx`
      insert into geo_areas ${tx(
        rows,
        'id',
        'parent_id',
        'adm_level',
        'level_code',
        'bbs_code_geocode11',
        'name_en',
        'name_bn',
        'centroid',
        'needs_manual_review',
        'manually_verified_at',
        'source_release',
      )}
      on conflict (id) do nothing`;
  }
  console.log(`geo_areas: ${scaffolds.length} dev scaffolds`);
  return idBySlug;
}

function scaffoldRow(area: GeoAreaDef, idBySlug: Map<string, string>): Record<string, unknown> {
  const [lon, lat] = centroidOf(area.bbox);
  return {
    id: idBySlug.get(area.slug),
    parent_id: area.parentSlug ? idBySlug.get(area.parentSlug) : null,
    adm_level: area.admLevel,
    level_code: area.levelCode,
    bbs_code_geocode11: area.bbsCode,
    name_en: area.nameEn,
    name_bn: area.nameBn ?? null,
    centroid: `SRID=4326;POINT(${lon} ${lat})`,
    needs_manual_review: true,
    manually_verified_at: new Date(),
    source_release: 'dev-scaffold',
  };
}

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

const MIRPUR_SERVICE_RADIUS_KM = 4;

async function seedTenants(
  tx: TransactionSql,
  partnerId: string,
  geoAreaIdBySlug: Map<string, string>,
): Promise<Map<string, string>> {
  const mirpurId = seedId(`tenant:${TENANT_SLUGS.mirpur}`);
  const trishalId = seedId(`tenant:${TENANT_SLUGS.trishal}`);
  const [mirpurLon, mirpurLat] = centroidOf(GEO_AREAS.find((a) => a.slug === 'mirpur-thana')!.bbox);
  const [trishalLon, trishalLat] = centroidOf(
    GEO_AREAS.find((a) => a.slug === 'trishal-upazila')!.bbox,
  );

  const mirpurGeoAreaId = geoAreaIdBySlug.get('mirpur-thana')!;
  const trishalGeoAreaId = geoAreaIdBySlug.get('trishal-upazila')!;
  await tx`
    insert into tenants
      (id, partner_id, geo_area_id, slug, name_bn, name_en, status_code, map_center, launched_at,
       boundary_mode, service_radius_km)
    values
      -- A metro thana has no polygon in the open data: centre + radius (ADR 026).
      (${mirpurId}, ${partnerId}, ${mirpurGeoAreaId}, ${TENANT_SLUGS.mirpur}, 'মিরপুর', 'Mirpur',
        'active', ${`SRID=4326;POINT(${mirpurLon} ${mirpurLat})`}, now(), 'radius', ${MIRPUR_SERVICE_RADIUS_KM}),
      -- A real upazila: its COD-AB boundary.
      (${trishalId}, ${partnerId}, ${trishalGeoAreaId}, ${TENANT_SLUGS.trishal}, 'ত্রিশাল', 'Trishal',
        'active', ${`SRID=4326;POINT(${trishalLon} ${trishalLat})`}, now(), 'polygon', null)
    on conflict (id) do nothing`;

  console.log('tenants: 2');
  return new Map([
    [TENANT_SLUGS.mirpur, mirpurId],
    [TENANT_SLUGS.trishal, trishalId],
  ]);
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

async function seedUsers(tx: TransactionSql): Promise<Map<string, string>> {
  const idByKey = new Map<string, string>();
  const rows: Record<string, unknown>[] = [];

  for (const u of NAMED_USERS) {
    const id = seedId(`user:${u.key}`);
    idByKey.set(u.key, id);
    rows.push({
      id,
      phone_e164: u.phone,
      platform_role_code: u.platformRole,
      preferred_locale: 'bn',
    });
  }
  COMMUNITY_MEMBER_NAMES.forEach((name, i) => {
    const key = `community-${i}`;
    const id = seedId(`user:${key}`);
    idByKey.set(key, id);
    rows.push({
      id,
      phone_e164: `+88017${String(20000000 + i).padStart(8, '0')}`,
      platform_role_code: null,
      preferred_locale: 'bn',
    });
  });

  await tx`insert into users ${tx(rows, 'id', 'phone_e164', 'platform_role_code', 'preferred_locale')} on conflict (id) do nothing`;
  console.log(`users: ${rows.length}`);
  return idByKey;
}

// ---------------------------------------------------------------------------
// Tenant members
// ---------------------------------------------------------------------------

interface MemberIds {
  mirpur: {
    tenantAdmin: string;
    moderator: string;
    seller: string;
    buyer: string;
    community: string[];
  };
  trishal: { seller: string; buyer: string; community: string[] };
}

async function seedTenantMembers(
  tx: TransactionSql,
  tenantIds: Map<string, string>,
  userIds: Map<string, string>,
): Promise<MemberIds> {
  const mirpurId = tenantIds.get(TENANT_SLUGS.mirpur)!;
  const trishalId = tenantIds.get(TENANT_SLUGS.trishal)!;

  const rows: Record<string, unknown>[] = [];
  const memberId = (tenantSlug: string, userKey: string) =>
    seedId(`member:${tenantSlug}:${userKey}`);

  const push = (tenantId: string, tenantSlug: string, userKey: string, roleCode: string) => {
    const id = memberId(tenantSlug, userKey);
    rows.push({ id, tenant_id: tenantId, user_id: userIds.get(userKey)!, role_code: roleCode });
    return id;
  };

  const mirpur = {
    tenantAdmin: push(mirpurId, TENANT_SLUGS.mirpur, 'tenant-admin', 'tenant_admin'),
    moderator: push(mirpurId, TENANT_SLUGS.mirpur, 'moderator', 'moderator'),
    seller: push(mirpurId, TENANT_SLUGS.mirpur, 'seller', 'member'),
    buyer: push(mirpurId, TENANT_SLUGS.mirpur, 'buyer', 'member'),
    community: [] as string[],
  };
  const trishal = {
    seller: push(trishalId, TENANT_SLUGS.trishal, 'seller', 'member'),
    buyer: push(trishalId, TENANT_SLUGS.trishal, 'buyer', 'member'),
    community: [] as string[],
  };

  // 10 generic members in Mirpur, 10 in Trishal.
  COMMUNITY_MEMBER_NAMES.forEach((_, i) => {
    const userKey = `community-${i}`;
    if (i < 10) {
      mirpur.community.push(push(mirpurId, TENANT_SLUGS.mirpur, userKey, 'member'));
    } else {
      trishal.community.push(push(trishalId, TENANT_SLUGS.trishal, userKey, 'member'));
    }
  });

  await tx`insert into tenant_members ${tx(rows, 'id', 'tenant_id', 'user_id', 'role_code')} on conflict (id) do nothing`;
  console.log(`tenant_members: ${rows.length}`);
  return { mirpur, trishal };
}

// ---------------------------------------------------------------------------
// Categories + field schemas
// ---------------------------------------------------------------------------

async function seedCategories(
  tx: TransactionSql,
  platformAdminUserId: string,
): Promise<Map<string, string>> {
  const idBySlug = new Map<string, string>();
  for (const c of CATEGORIES) idBySlug.set(c.slug, seedId(`category:${c.slug}`));

  // One row at a time, in array order: a child's parent must exist first
  // (categories_validate_parent() sets depth from it).
  for (const [i, c] of CATEGORIES.entries()) {
    await tx`
      insert into categories
        (id, parent_id, kind_code, module_code, slug, name_bn, name_en, icon_key, default_sort_order,
         default_post_cost_credits, default_moderation_mode_code, default_post_expiry_days,
         monetization_mode_code, is_active, is_shippable)
      values
        (${idBySlug.get(c.slug)!}, ${c.parent ? idBySlug.get(c.parent)! : null}, ${c.kind},
         ${c.moduleCode ?? null}, ${c.slug}, ${c.nameBn}, ${c.nameEn}, ${c.icon}, ${(i + 1) * 10},
         ${c.costCredits}, ${c.moderationMode}, ${c.expiryDays}, ${c.monetizationMode},
         ${c.phase1}, ${c.shippable ?? false})
      on conflict (id) do nothing`;
  }

  // Module tiles have no custom-field schema (0017 rejects one).
  const withSchema = CATEGORIES.filter((c) => c.kind !== 'module');
  for (const c of withSchema) {
    const definition = definitionOf(c, CATEGORIES);
    // Same checks a platform admin's publish goes through; throws on any violation.
    const { jsonSchema, uiSchema } = checkPublishable(definition);
    // What an admin would have authored: own fields only (re-flattened when a parent publishes).
    await tx`
      insert into category_field_schemas
        (id, category_id, version, json_schema, ui_schema, filterable_fields, searchable_fields,
         analytics_fields, authored_definition, status_code, published_at, published_by_user_id)
      values
        (${fieldSchemaId(c.slug)}, ${idBySlug.get(c.slug)!}, 1,
         ${tx.json(jsonSchema as never)}, ${tx.json(uiSchema as never)},
         ${definition.filterableFields}, ${definition.searchableFields}, ${definition.analyticsFields},
         ${tx.json(authoredDefinitionOf(c) as never)}, 'published', now(), ${platformAdminUserId})
      on conflict (id) do nothing`;
  }

  console.log(`categories: ${CATEGORIES.length}, category_field_schemas: ${withSchema.length}`);
  return idBySlug;
}

function fieldSchemaId(slug: string): string {
  return seedId(`category-field-schema:${slug}:1`);
}

// ---------------------------------------------------------------------------
// Tenant categories (enable the active, phase-1 categories for both tenants)
// ---------------------------------------------------------------------------

/** Provisioning inserts tenant_categories rows only for active categories (categories.md §2). */
const ACTIVE_CATEGORIES = CATEGORIES.filter((c) => c.phase1);

async function seedTenantCategories(
  tx: TransactionSql,
  tenantIds: Map<string, string>,
  categoryIds: Map<string, string>,
): Promise<void> {
  const rows: Record<string, unknown>[] = [];
  for (const [tenantSlug, tenantId] of tenantIds) {
    let sortOrder = 0;
    for (const c of ACTIVE_CATEGORIES) {
      sortOrder += 10;
      rows.push({
        id: seedId(`tenant-category:${tenantSlug}:${c.slug}`),
        tenant_id: tenantId,
        category_id: categoryIds.get(c.slug),
        is_enabled: true,
        sort_order: sortOrder,
      });
    }
  }
  await tx`insert into tenant_categories ${tx(rows, 'id', 'tenant_id', 'category_id', 'is_enabled', 'sort_order')} on conflict (id) do nothing`;
  console.log(`tenant_categories: ${rows.length}`);
}

/** Valid sample `fields` for a category, checked by the same validator the API uses. */
function buildFields(category: CategoryDef, label: string, rand: () => number): FieldValues {
  const schema: FieldSchema = definitionOf(category, CATEGORIES).jsonSchema;
  const context = validationContextAt(new Date(), 'Asia/Dhaka');
  const fields = sampleFields(schema, context, rand, label);
  return compileFieldsValidator(schema, context).parse(fields);
}

// ---------------------------------------------------------------------------
// Bazar commodities + markets
// ---------------------------------------------------------------------------

async function seedBazarCommodities(tx: TransactionSql): Promise<Map<string, string>> {
  const idByCode = new Map<string, string>();
  const rows = BAZAR_COMMODITIES.map((c, i) => {
    const id = seedId(`bazar-commodity:${c.code}`);
    idByCode.set(c.code, id);
    return {
      id,
      code: c.code,
      name_bn: c.nameBn,
      name_en: c.nameEn,
      group_code: c.group,
      default_unit_code: c.unit,
      sort_order: (i + 1) * 10,
    };
  });
  await tx`
    insert into bazar_commodities ${tx(rows, 'id', 'code', 'name_bn', 'name_en', 'group_code', 'default_unit_code', 'sort_order')}
    on conflict (id) do nothing`;
  console.log(`bazar_commodities: ${rows.length}`);
  return idByCode;
}

async function seedBazarMarkets(
  tx: TransactionSql,
  tenantIds: Map<string, string>,
): Promise<Map<string, string>> {
  const idByTenant = new Map<string, string>();
  const markets = [
    {
      tenantSlug: TENANT_SLUGS.mirpur,
      nameBn: 'মিরপুর কাঁচাবাজার',
      nameEn: 'Mirpur Bazar',
      areaSlug: 'mirpur-10',
    },
    {
      tenantSlug: TENANT_SLUGS.trishal,
      nameBn: 'ত্রিশাল হাট',
      nameEn: 'Trishal Haat',
      areaSlug: 'trishal-sadar',
    },
  ];
  const rows = markets.map((m) => {
    const id = seedId(`bazar-market:${m.tenantSlug}`);
    idByTenant.set(m.tenantSlug, id);
    const area = GEO_AREAS.find((a) => a.slug === m.areaSlug)!;
    const [lon, lat] = centroidOf(area.bbox);
    return {
      id,
      tenant_id: tenantIds.get(m.tenantSlug),
      name_bn: m.nameBn,
      name_en: m.nameEn,
      market_type_code: 'daily_bazar',
      location: `SRID=4326;POINT(${lon} ${lat})`,
    };
  });
  await tx`
    insert into bazar_markets ${tx(rows, 'id', 'tenant_id', 'name_bn', 'name_en', 'market_type_code', 'location')}
    on conflict (id) do nothing`;
  console.log(`bazar_markets: ${rows.length}`);
  return idByTenant;
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

async function seedStores(
  tx: TransactionSql,
  tenantIds: Map<string, string>,
  memberIds: MemberIds,
  categoryIds: Map<string, string>,
): Promise<string[]> {
  const storeNames = [
    'Rahim Electronics',
    'Nice Fashion House',
    'Green Mobile Center',
    'Dhaka Furniture Mart',
    'City Motors',
    'Amin Traders',
    'New Star Enterprise',
    'Bismillah Store',
    'Green Valley Agro',
    'Trishal Hardware',
  ];
  const rows = storeNames.map((name, i) => {
    const tenantSlug = i < 6 ? TENANT_SLUGS.mirpur : TENANT_SLUGS.trishal;
    const ownerMemberId = i < 6 ? memberIds.mirpur.seller : memberIds.trishal.seller;
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${i + 1}`;
    return {
      id: seedId(`store:${slug}`),
      tenant_id: tenantIds.get(tenantSlug),
      owner_member_id: ownerMemberId,
      slug,
      name_bn: name,
      name_en: name,
      status_code: 'active',
      // What the store is (0050): the shop directory's place category, as its pin would be.
      category_id: categoryIds.get('local-shop-directory') ?? null,
    };
  });
  await tx`
    insert into stores ${tx(rows, 'id', 'tenant_id', 'owner_member_id', 'slug', 'name_bn', 'name_en', 'status_code', 'category_id')}
    on conflict (id) do nothing`;
  // A Mirpur community member edits the first store's catalog (ADR 054): posts as it, nothing else.
  const editorMemberId = memberIds.mirpur.community[0];
  if (editorMemberId) {
    await tx`
      insert into store_members (tenant_id, store_id, member_id, role_code, invited_by_member_id, accepted_at)
      values (${rows[0]!.tenant_id!}, ${rows[0]!.id}, ${editorMemberId}, 'editor', ${rows[0]!.owner_member_id}, now())
      on conflict (tenant_id, store_id, member_id) do nothing`;
  }
  console.log(`stores: ${rows.length} (1 editor)`);
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

async function seedPosts(
  tx: TransactionSql,
  tenantIds: Map<string, string>,
  memberIds: MemberIds,
  storeIds: string[],
  categoryIds: Map<string, string>,
  geoAreaIdBySlug: Map<string, string>,
): Promise<void> {
  const postableCategories = ACTIVE_CATEGORIES.filter(
    (c) => c.kind !== 'place' && c.kind !== 'module',
  );
  const POST_COUNT = 30;
  const rows: unknown[][] = [];

  for (let i = 0; i < POST_COUNT; i++) {
    const category = postableCategories[i % postableCategories.length]!;
    const isMirpur = i < 20;
    const tenantSlug = isMirpur ? TENANT_SLUGS.mirpur : TENANT_SLUGS.trishal;
    const tenantId = tenantIds.get(tenantSlug)!;
    const areaSlug = isMirpur
      ? i % 2 === 0
        ? 'mirpur-10'
        : 'mirpur-11'
      : i % 2 === 0
        ? 'trishal-sadar'
        : 'amirabari';
    const area = GEO_AREAS.find((a) => a.slug === areaSlug)!;
    const community = isMirpur ? memberIds.mirpur.community : memberIds.trishal.community;
    // Every third post is authored by "seller", the only member who owns
    // any store — a post's store_id requires the author to own/manage that
    // store (posts_validate_store_authorship(), 0006), so only these posts
    // ever get a store_id.
    const authoredBySeller = i % 3 === 0;
    const authorMemberId = authoredBySeller
      ? isMirpur
        ? memberIds.mirpur.seller
        : memberIds.trishal.seller
      : community[i % community.length];
    const rand = rngFor(`post:${i}`);
    const [lon, lat] = randomPointIn(area.bbox, rand);
    const { title, fields, priceTypeCode } = buildPostContent(category, i, rand);
    const storeId =
      authoredBySeller && i % 5 === 0
        ? pick(storeIds.slice(isMirpur ? 0 : 6, isMirpur ? 6 : 10), rand)
        : null;

    rows.push([
      seedId(`post:${i}`),
      tenantId,
      authorMemberId,
      storeId,
      categoryIds.get(category.slug),
      fieldSchemaId(category.slug),
      title,
      `${title} — বিস্তারিত জানতে যোগাযোগ করুন।`,
      tx.json(fields),
      priceTypeCode,
      geoAreaIdBySlug.get(areaSlug),
      `SRID=4326;POINT(${lon} ${lat})`,
      'live',
      tx`now()`,
    ]);
  }

  await tx`
    insert into posts
      (id, tenant_id, author_member_id, store_id, category_id, field_schema_id, title, description, fields,
       price_type_code, geo_area_id, location, status_code, published_at)
    values ${tx(rows as never)}
    on conflict (id) do nothing`;
  console.log(`posts: ${rows.length}`);

  const postIds = rows.map((row) => row[0] as string);
  // Buyers reach the author's own number, as a new post defaults to (ADR
  // 032) — revealed only through POST /posts/:id/contact (ADR 036).
  await tx`
    update posts p
    set contact_phone_e164 = u.phone_e164,
        contact_name = nullif(btrim(up.display_name), '')
    from tenant_members tm
    join users u on u.id = tm.user_id
    left join user_profiles up on up.user_id = u.id
    where tm.tenant_id = p.tenant_id and tm.id = p.author_member_id
      and p.id in ${tx(postIds)}
      and p.contact_phone_e164 is null`;
  // A share code per post (/s/:code), stable across re-seeds.
  await tx`
    insert into post_short_links (tenant_id, post_id, code)
    select tenant_id, id, substr(md5(id::text), 1, 8) from posts where id in ${tx(postIds)}
    on conflict do nothing`;
  console.log(`post contacts and share links: ${postIds.length}`);
}

function buildPostContent(
  category: CategoryDef,
  index: number,
  rand: () => number,
): {
  title: string;
  fields: FieldValues;
  priceTypeCode: string;
} {
  const title = `${category.nameEn} #${index + 1}`;
  const fields = buildFields(category, title, rand);
  const priceTypeCode =
    fields.price === undefined
      ? 'on_request'
      : category.slug === 'to-let'
        ? 'per_month'
        : rand() > 0.7
          ? 'negotiable'
          : 'fixed';
  return { title, fields, priceTypeCode };
}

// ---------------------------------------------------------------------------
// Saved items and follows (ADR 037)
// ---------------------------------------------------------------------------

/**
 * The buyer's saved list, across both tenants: a few posts, places and a
 * store, and two followed stores. Each row lives in its target's tenant
 * (§13.29); the counters (saved_count, follower_count) follow by trigger.
 */
async function seedSavedAndFollows(tx: TransactionSql, buyerId: string): Promise<void> {
  const savedPosts = await tx`
    insert into saved_posts (tenant_id, user_id, post_id)
    select p.tenant_id, ${buyerId}, p.id from posts p
    where p.id in ${tx([0, 5, 12, 21].map((i) => seedId(`post:${i}`)))}
    on conflict do nothing`;
  const savedPlaces = await tx`
    insert into saved_places (tenant_id, user_id, place_id)
    select pl.tenant_id, ${buyerId}, pl.id from places pl
    where pl.status_code = 'published' and pl.deleted_at is null
    order by pl.id limit 2
    on conflict do nothing`;
  const savedStores = await tx`
    insert into saved_stores (tenant_id, user_id, store_id)
    select st.tenant_id, ${buyerId}, st.id from stores st
    where st.status_code = 'active' and st.deleted_at is null
    order by st.id limit 1
    on conflict do nothing`;
  const follows = await tx`
    insert into store_follows (tenant_id, user_id, store_id)
    select st.tenant_id, ${buyerId}, st.id from stores st
    where st.status_code = 'active' and st.deleted_at is null
    order by st.id limit 2
    on conflict do nothing`;
  console.log(
    `saved: ${savedPosts.count} posts, ${savedPlaces.count} places, ${savedStores.count} stores; follows: ${follows.count}`,
  );
}

// ---------------------------------------------------------------------------
// Search log (0034, ADR 040)
// ---------------------------------------------------------------------------

/**
 * A few days of searches per tenant, so trending, the popular queries in
 * suggestions and the zero-result report (search:zero-results) show
 * something in dev. Normalized text only, in all three scripts, from several
 * anonymous searchers; some found nothing.
 */
const SEED_SEARCHES: readonly { q: string; searchers: number; found: boolean }[] = [
  { q: 'ডাক্তার', searchers: 6, found: true },
  { q: 'daktar', searchers: 4, found: true },
  { q: 'basa vara', searchers: 5, found: true },
  { q: 'বাসা ভাড়া', searchers: 3, found: true },
  { q: 'mobile', searchers: 4, found: true },
  { q: 'ইলেকট্রিশিয়ান', searchers: 3, found: true },
  { q: 'plumbr', searchers: 3, found: false },
  { q: 'অ্যাম্বুলেন্স রাতে', searchers: 2, found: false },
];

async function seedSearchQueries(
  tx: TransactionSql,
  tenantIds: Map<string, string>,
): Promise<void> {
  let rows = 0;
  for (const [slug, tenantId] of tenantIds) {
    for (const { q, searchers, found } of SEED_SEARCHES) {
      for (let n = 0; n < searchers; n += 1) {
        const searcher = createHash('sha256').update(`seed-searcher:${slug}:${n}`).digest('hex');
        const result = await tx`
          insert into search_queries
            (id, tenant_id, searcher_hash, q_normalized, filters_hash, result_count, created_at)
          values (${seedId(`search:${slug}:${q}:${n}`)}, ${tenantId}, ${searcher}, ${q},
                  '0000000000000000', ${found ? 7 : 0}, now() - make_interval(hours => ${n * 3}))
          on conflict (id) do nothing`;
        rows += result.count;
      }
    }
  }
  console.log(`search log: ${rows} searches`);
}

// ---------------------------------------------------------------------------
// Saved searches (0035, ADR 041)
// ---------------------------------------------------------------------------

/**
 * Two of the buyer's saved searches around each tenant's centre — one
 * instant, one daily — and, for the first, a few "new results" (its badge),
 * so the saved-search screens have something to show in dev. Matches are
 * normally the worker's (saved_search_matches is system-written); the seed
 * runs as system too.
 */
async function seedSavedSearches(
  tx: TransactionSql,
  tenantIds: Map<string, string>,
  buyerId: string,
): Promise<void> {
  let searches = 0;
  let matches = 0;
  for (const [slug, tenantId] of tenantIds) {
    const instantId = seedId(`saved-search:${slug}:instant`);
    const inserted = await tx`
      insert into saved_searches (id, user_id, name, query_text, center, radius_km, alert_frequency_code, last_engaged_at)
      select ${instantId}::uuid, ${buyerId}::uuid, 'মোবাইল', 'mobile', t.map_center, 5, 'instant', now()
      from tenants t where t.id = ${tenantId}
      union all
      select ${seedId(`saved-search:${slug}:daily`)}::uuid, ${buyerId}::uuid, 'বাসা ভাড়া', 'basa vara', t.map_center, 3, 'daily', now()
      from tenants t where t.id = ${tenantId}
      on conflict (id) do nothing`;
    searches += inserted.count;
    const newResults = await tx`
      insert into saved_search_matches (saved_search_id, user_id, post_id, post_tenant_id)
      select ${instantId}::uuid, ${buyerId}::uuid, p.id, p.tenant_id from posts p
      where p.tenant_id = ${tenantId} and p.status_code = 'live'
      order by p.id limit 3
      on conflict (saved_search_id, post_id) do nothing`;
    matches += newResults.count;
  }
  console.log(`saved searches: ${searches}, new results: ${matches}`);
}

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

async function seedPlaces(
  tx: TransactionSql,
  tenantIds: Map<string, string>,
  memberIds: MemberIds,
  categoryIds: Map<string, string>,
  geoAreaIdBySlug: Map<string, string>,
): Promise<void> {
  const placeCategories = ACTIVE_CATEGORIES.filter((c) => c.kind === 'place');
  const PLACE_COUNT = 20;
  const rows: unknown[][] = [];

  for (let i = 0; i < PLACE_COUNT; i++) {
    const category = placeCategories[i % placeCategories.length]!;
    const isMirpur = i < 12;
    const tenantSlug = isMirpur ? TENANT_SLUGS.mirpur : TENANT_SLUGS.trishal;
    const areaSlug = isMirpur
      ? i % 2 === 0
        ? 'mirpur-10'
        : 'mirpur-11'
      : i % 2 === 0
        ? 'trishal-sadar'
        : 'amirabari';
    const area = GEO_AREAS.find((a) => a.slug === areaSlug)!;
    const rand = rngFor(`place:${i}`);
    const [lon, lat] = randomPointIn(area.bbox, rand);
    const name = `${category.nameEn} ${i + 1}`;
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const createdBy = isMirpur ? memberIds.mirpur.tenantAdmin : memberIds.trishal.seller;
    const fields = buildFields(category, name, rand);

    rows.push([
      seedId(`place:${slug}-${i}`),
      tenantIds.get(tenantSlug),
      categoryIds.get(category.slug),
      fieldSchemaId(category.slug),
      `${slug}-${i}`,
      name,
      name,
      tx.json(fields),
      geoAreaIdBySlug.get(areaSlug),
      `SRID=4326;POINT(${lon} ${lat})`,
      'agent_survey',
      createdBy ? tx`(select user_id from tenant_members where id = ${createdBy})` : null,
      'published',
    ]);
  }

  await tx`
    insert into places
      (id, tenant_id, category_id, field_schema_id, slug, name_bn, name_en, fields, geo_area_id, location,
       source_code, created_by_user_id, status_code)
    values ${tx(rows as never)}
    on conflict (id) do nothing`;
  console.log(`places: ${rows.length}`);
}

/**
 * The moderators' Places tab has something in it (ADR 051): on Mirpur's first
 * place a wrong-location and a closed report (below the "possibly closed"
 * threshold), and on its second a pending phone suggestion. Filed through
 * report_place() / suggest_place_edit() as the members (moderation_actions
 * takes no other writer), then the seed's system context is restored.
 */
async function seedPlaceModeration(
  tx: TransactionSql,
  tenantIds: Map<string, string>,
  memberIds: MemberIds,
): Promise<void> {
  const tenantId = tenantIds.get(TENANT_SLUGS.mirpur)!;
  const places = await tx<{ id: string }[]>`
    select id from places where tenant_id = ${tenantId} and status_code = 'published'
    order by slug limit 2`;
  if (places.length < 2) return;
  const [first, second] = [places[0]!.id, places[1]!.id];

  const asMember = async (memberId: string, work: () => Promise<unknown>) => {
    const [m] = await tx<{ user_id: string }[]>`
      select user_id from tenant_members where id = ${memberId}`;
    await tx`select set_config('app.tenant_id', ${tenantId}, true),
                    set_config('app.user_id', ${m!.user_id}, true),
                    set_config('app.member_id', ${memberId}, true),
                    set_config('app.role', 'member', true)`;
    try {
      await work();
    } finally {
      await tx`select set_config('app.tenant_id', '', true), set_config('app.user_id', '', true),
                      set_config('app.member_id', '', true), set_config('app.role', 'system', true)`;
    }
  };

  // A repeat run finds the open reports again (report_place returns them).
  await asMember(
    memberIds.mirpur.buyer,
    () => tx`select report_place(${first}, 'wrong_location', 'পিনটা রাস্তার উল্টো পাশে')`,
  );
  await asMember(
    memberIds.mirpur.seller,
    () => tx`select report_place(${first}, 'closed_permanently', 'দোকান বন্ধ হয়ে গেছে')`,
  );
  const [pending] = await tx<{ n: number }[]>`
    select count(*)::int as n from place_edit_suggestions
    where place_id = ${second} and suggester_member_id = ${memberIds.mirpur.buyer}
      and status_code = 'pending'`;
  if (pending!.n === 0) {
    await asMember(
      memberIds.mirpur.buyer,
      () =>
        tx`select suggest_place_edit(${second}, ${tx.json({ phones: ['+8801711000777'] })},
                                   (select jsonb_build_object('phones', to_jsonb(phones))
                                    from places where id = ${second}),
                                   'দোকানের নতুন নম্বর')`,
    );
  }
  console.log('place moderation: 2 reports, 1 suggestion');
}

// ---------------------------------------------------------------------------
// Emergency contacts
// ---------------------------------------------------------------------------

async function seedEmergencyContacts(
  tx: TransactionSql,
  tenantIds: Map<string, string>,
): Promise<void> {
  const serviceTypes = [
    'ambulance',
    'fire_service',
    'police',
    'hospital',
    'pharmacy_24h',
    'electricity',
    'gas',
    'union_parishad',
  ];
  const CONTACT_COUNT = 15;
  const rows: unknown[][] = [];

  for (let i = 0; i < CONTACT_COUNT; i++) {
    const isMirpur = i < 8;
    const tenantSlug = isMirpur ? TENANT_SLUGS.mirpur : TENANT_SLUGS.trishal;
    const areaSlug = isMirpur ? 'mirpur-thana' : 'trishal-upazila';
    const area = GEO_AREAS.find((a) => a.slug === areaSlug)!;
    const rand = rngFor(`emergency-contact:${i}`);
    const [lon, lat] = randomPointIn(area.bbox, rand);
    const serviceType = serviceTypes[i % serviceTypes.length]!;
    const name = `${tenantSlug === TENANT_SLUGS.mirpur ? 'Mirpur' : 'Trishal'} ${serviceType.replace(/_/g, ' ')}`;

    rows.push([
      seedId(`emergency-contact:${tenantSlug}:${i}`),
      tenantIds.get(tenantSlug),
      serviceType,
      name,
      [`+8801${intBetween(700000000, 999999999, rand)}`],
      `SRID=4326;POINT(${lon} ${lat})`,
      true,
    ]);
  }

  await tx`
    insert into emergency_contacts (id, tenant_id, service_type_code, name_bn, phones, location, is_active)
    values ${tx(rows as never)}
    on conflict (id) do nothing`;
  console.log(`emergency_contacts: ${rows.length}`);
}

// ---------------------------------------------------------------------------
// Blood donors
// ---------------------------------------------------------------------------

async function seedBloodDonors(
  tx: TransactionSql,
  tenantIds: Map<string, string>,
  memberIds: MemberIds,
): Promise<void> {
  const bloodGroups = ['a_pos', 'a_neg', 'b_pos', 'b_neg', 'ab_pos', 'ab_neg', 'o_pos', 'o_neg'];
  const donorMembers = [
    ...memberIds.mirpur.community.slice(0, 5),
    ...memberIds.trishal.community.slice(0, 5),
  ];
  const rows = donorMembers.map((memberId, i) => {
    const isMirpur = i < 5;
    return [
      seedId(`blood-donor:${i}`),
      isMirpur ? tenantIds.get(TENANT_SLUGS.mirpur) : tenantIds.get(TENANT_SLUGS.trishal),
      memberId,
      bloodGroups[i % bloodGroups.length]!,
      true,
      tx`now()`,
    ];
  });
  await tx`
    insert into blood_donors (id, tenant_id, member_id, blood_group_code, is_available, eligibility_confirmed_at)
    values ${tx(rows as never)}
    on conflict (id) do nothing`;
  console.log(`blood_donors: ${rows.length}`);
}

// ---------------------------------------------------------------------------
// Bazar prices (7 days)
// ---------------------------------------------------------------------------

async function seedBazarPrices(
  tx: TransactionSql,
  tenantIds: Map<string, string>,
  commodityIds: Map<string, string>,
  bazarMarketIds: Map<string, string>,
  publishedByUserId: string,
): Promise<void> {
  const rows: unknown[][] = [];
  for (const [tenantSlug, tenantId] of tenantIds) {
    for (const commodity of BAZAR_COMMODITIES) {
      const rand = rngFor(`bazar-price:${tenantSlug}:${commodity.code}`);
      const base = intBetween(30, 200, rand);
      for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
        const wobble = intBetween(-5, 5, rand);
        const min = Math.max(10, base + wobble);
        const max = min + intBetween(2, 15, rand);
        rows.push([
          seedId(`bazar-price:${tenantSlug}:${commodity.code}:${dayOffset}`),
          tenantId,
          commodityIds.get(commodity.code),
          bazarMarketIds.get(tenantSlug),
          tx`current_date - ${dayOffset}::int`,
          commodity.unit,
          min,
          max,
          'staff',
          'published',
          publishedByUserId,
        ]);
      }
    }
  }
  await tx`
    insert into bazar_prices
      (id, tenant_id, commodity_id, bazar_market_id, price_date, unit_code, min_price, max_price, source_code,
       status_code, published_by_user_id)
    values ${tx(rows as never)}
    on conflict (id) do nothing`;
  console.log(`bazar_prices: ${rows.length}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
