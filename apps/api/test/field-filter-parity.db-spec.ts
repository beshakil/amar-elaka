import { and, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Sql } from 'postgres';
import {
  parseFieldFilters,
  type CategoryFieldDefinition,
  type RawFieldFilter,
} from '../src/categories/field-schema';
import { postFieldFilterConditions } from '../src/categories/post-field-filters';
import { posts } from '../src/database/schema/content';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * One field-filter meaning inside Postgres (month 2 review §6). The feed
 * sends parsed filters to feed_posts(), which runs post_field_filter_matches()
 * (0030); the search fallback builds SQL in post-field-filters.ts (generated
 * columns and containment, for the indexes, and the same SQL matcher for
 * everything else). Every filter kind, including values stored with the wrong
 * type by an older schema version, must pick exactly the same posts both ways.
 */

const PARTNER = '0191e3a0-8899-7000-8000-000000000001';
const GEO_AREA = '0191e3a0-8899-7000-8000-000000000011';
const TENANT = '0191e3a0-8899-7000-8000-000000000021';
const USER = '0191e3a0-8899-7000-8000-000000000031';
const MEMBER = '0191e3a0-8899-7000-8000-000000000041';
const CATEGORY = '0191e3a0-8899-7000-8000-000000000051';
const SCHEMA = '0191e3a0-8899-7000-8000-000000000061';
const FIXTURE_PREFIX = '0191e3a0-8899-7000-8000-%';
const ROWS = 240;

const definition: CategoryFieldDefinition = {
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      price: { 'x-field-type': 'money', type: 'string' },
      bedrooms: { 'x-field-type': 'number', type: 'integer' },
      floor: { 'x-field-type': 'number', type: 'integer' },
      service_charge: { 'x-field-type': 'money', type: 'string' },
      available_from: { 'x-field-type': 'date', type: 'string', format: 'date' },
      property_type: { 'x-field-type': 'select', type: 'string', enum: ['flat', 'house', 'shop'] },
      has_lift: { 'x-field-type': 'bool', type: 'boolean' },
      days: {
        'x-field-type': 'multiselect',
        type: 'array',
        items: { type: 'string', enum: ['sat', 'sun'] },
        uniqueItems: true,
      },
    },
    required: [],
  },
  uiSchema: { order: [], card: [], labels: {} },
  filterableFields: [
    'price',
    'bedrooms',
    'floor',
    'service_charge',
    'available_from',
    'property_type',
    'has_lift',
    'days',
  ],
  searchableFields: [],
  analyticsFields: [],
};

const CASES: Record<string, RawFieldFilter[]> = {
  'generated number': [{ field: 'bedrooms', op: 'gte', value: '2' }],
  'generated money': [{ field: 'price', op: 'lt', value: '15000' }],
  'json number, range': [{ field: 'floor', op: 'gt', value: '3' }],
  'json number, equal (a string "3" never matches)': [{ field: 'floor', op: 'eq', value: '3' }],
  'json money (a malformed "500" never matches)': [
    { field: 'service_charge', op: 'lte', value: '500' },
  ],
  'json money, lower bound': [{ field: 'service_charge', op: 'gte', value: '200' }],
  'date, from': [{ field: 'available_from', op: 'gte', value: '2026-10-15' }],
  'date, before (a malformed date never matches)': [
    { field: 'available_from', op: 'lt', value: '2026-10-10' },
  ],
  'select, one of': [{ field: 'property_type', op: 'in', value: 'flat,house' }],
  'bool (a string "true" never matches)': [{ field: 'has_lift', op: 'eq', value: 'true' }],
  'multiselect, one value': [{ field: 'days', op: 'any', value: 'sat' }],
  'multiselect, either value': [{ field: 'days', op: 'any', value: 'sat,sun' }],
  'mixed, all ANDed': [
    { field: 'bedrooms', op: 'gte', value: '2' },
    { field: 'floor', op: 'lte', value: '5' },
    { field: 'has_lift', op: 'eq', value: 'false' },
  ],
  'every kind at once': [
    { field: 'price', op: 'gte', value: '10000' },
    { field: 'service_charge', op: 'gt', value: '300' },
    { field: 'available_from', op: 'lte', value: '2026-10-20' },
    { field: 'property_type', op: 'in', value: 'shop' },
  ],
};

const dialect = new PgDialect();

describe('field filters: the feed path and the search path agree', () => {
  let admin: Sql;

  async function cleanUp(): Promise<void> {
    await admin`delete from posts where tenant_id::text like ${FIXTURE_PREFIX}`;
    await admin`
      delete from outbox_events
      where aggregate_table = 'posts' and payload->>'tenant_id' like ${FIXTURE_PREFIX}`;
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from categories where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;
    await admin`delete from users where id::text like ${FIXTURE_PREFIX}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();

    await admin`insert into users (id, phone_e164) values (${USER}, '+8801788000201')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Filter Parity Partner', 'Filter Parity Partner', '+8801788000299')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release)
      values (${GEO_AREA}, 3, 'upazila', 'filter-parity-a', 'Filter Parity Area', 'fixture')`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values (${TENANT}, ${PARTNER}, ${GEO_AREA}, 'filter-parity-tenant', 'এ', 'A',
              st_point(90.4, 23.8)::geography, 'active')`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values (${MEMBER}, ${TENANT}, ${USER}, 'member')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en)
      values (${CATEGORY}, 'rental', 'filter-parity-to-let', 'টু-লেট', 'To-Let')`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, status_code, published_at)
      values (${SCHEMA}, ${CATEGORY}, 1, ${admin.json(definition.jsonSchema as never)}, 'published', now())`;

    // A deterministic spread, with a few values stored as an older schema
    // version might have stored them: floor as a string, a money value
    // without decimals, a date that isn't one, a bool as a string.
    await admin`
      insert into posts
        (tenant_id, author_member_id, category_id, field_schema_id, title, fields,
         status_code, published_at, bumped_at)
      select ${TENANT}, ${MEMBER}, ${CATEGORY}, ${SCHEMA}, 'post ' || i,
             jsonb_build_object(
               'price', (3000 + (i * 7919) % 50000)::text || '.00',
               'bedrooms', i % 6,
               'floor', CASE WHEN i % 17 = 0 THEN to_jsonb('3'::text) ELSE to_jsonb(i % 10) END,
               'service_charge', CASE WHEN i % 13 = 0 THEN '500' ELSE ((i * 37) % 900)::text || '.00' END,
               'available_from', CASE WHEN i % 11 = 0 THEN 'soon'
                                      ELSE '2026-10-' || lpad((1 + i % 28)::text, 2, '0') END,
               'property_type', (ARRAY['flat', 'house', 'shop'])[1 + i % 3],
               'has_lift', CASE WHEN i % 19 = 0 THEN to_jsonb('true'::text) ELSE to_jsonb(i % 2 = 0) END,
               'days', (ARRAY['[]', '["sat"]', '["sun"]', '["sat","sun"]'])[1 + i % 4]::jsonb),
             'live', now(), now()
      from generate_series(1, ${ROWS}) as i`;
  });

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await admin.end();
    }
  });

  async function ids(query: { sql: string; params: unknown[] }): Promise<string[]> {
    const rows = await admin.unsafe<{ id: string }[]>(query.sql, query.params as never[]);
    return rows.map((r) => r.id);
  }

  /** What feed_posts() does with p_field_filters. */
  function feedPath(raw: RawFieldFilter[]) {
    const filters = JSON.stringify(parseFieldFilters(definition, raw));
    return dialect.sqlToQuery(sql`
      select p.id from public.posts p
      where p.tenant_id = ${TENANT}
        and not exists (
          select 1 from jsonb_array_elements(${filters}::text::jsonb) f (value)
          where not coalesce(public.post_field_filter_matches(p.fields, f.value), false))
      order by p.id`);
  }

  /** What the search fallback (search-query.repository.ts) does. */
  function searchPath(raw: RawFieldFilter[]) {
    return dialect.sqlToQuery(sql`
      select ${posts.id} from ${posts}
      where ${and(sql`${posts.tenantId} = ${TENANT}`, ...postFieldFilterConditions(parseFieldFilters(definition, raw)))}
      order by ${posts.id}`);
  }

  it.each(Object.entries(CASES))('%s', async (_name, raw) => {
    const viaFeed = await ids(feedPath(raw));
    const viaSearch = await ids(searchPath(raw));
    expect(viaSearch).toEqual(viaFeed);
    // Each case narrows: neither nothing nor everything.
    expect(viaFeed.length).toBeGreaterThan(0);
    expect(viaFeed.length).toBeLessThan(ROWS);
  });

  it('a value stored with the wrong type never matches either way', async () => {
    const [{ n }] = (await admin`
      select count(*)::int as n from posts
      where tenant_id = ${TENANT} and fields -> 'floor' = to_jsonb('3'::text)`) as unknown as [
      { n: number },
    ];
    expect(n).toBeGreaterThan(0);
    const floor3 = await ids(feedPath(CASES['json number, equal (a string "3" never matches)']!));
    const [{ m }] = (await admin`
      select count(*)::int as m from posts
      where tenant_id = ${TENANT} and jsonb_typeof(fields -> 'floor') = 'number'
        and (fields ->> 'floor')::int = 3`) as unknown as [{ m: number }];
    expect(floor3).toHaveLength(m);
  });
});
