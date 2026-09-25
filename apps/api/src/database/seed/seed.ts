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
      const storeIds = await seedStores(tx, tenantIds, memberIds);
      await seedPosts(tx, tenantIds, memberIds, storeIds, categoryIds, geoAreaIdBySlug);
      await seedPlaces(tx, tenantIds, memberIds, categoryIds, geoAreaIdBySlug);
      await seedEmergencyContacts(tx, tenantIds);
      await seedBloodDonors(tx, tenantIds, memberIds);
      await seedBazarPrices(
        tx,
        tenantIds,
        commodityIds,
        bazarMarketIds,
        userIds.get('tenant-admin')!,
      );
    });
    console.log('Seed complete.');
  } finally {
    await sql.end();
  }
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
         monetization_mode_code, is_active)
      values
        (${idBySlug.get(c.slug)!}, ${c.parent ? idBySlug.get(c.parent)! : null}, ${c.kind},
         ${c.moduleCode ?? null}, ${c.slug}, ${c.nameBn}, ${c.nameEn}, ${c.icon}, ${(i + 1) * 10},
         ${c.costCredits}, ${c.moderationMode}, ${c.expiryDays}, ${c.monetizationMode},
         ${c.phase1})
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
    };
  });
  await tx`
    insert into stores ${tx(rows, 'id', 'tenant_id', 'owner_member_id', 'slug', 'name_bn', 'name_en', 'status_code')}
    on conflict (id) do nothing`;
  console.log(`stores: ${rows.length}`);
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
