import { and, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Sql } from 'postgres';
import { parseFieldFilters, type CategoryFieldDefinition } from '../src/categories/field-schema';
import { postFieldFilterConditions } from '../src/categories/post-field-filters';
import { posts } from '../src/database/schema/content';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * The storage decision (JSONB + generated columns, categories.md, schema.md
 * §13.13) under load: 100k live posts in one tenant's rental category,
 * filtered by "bedrooms >= 2 AND price < 15000" through the same filter
 * builder the API uses. Proves the planner uses the (tenant_id,
 * category_id, <column>) indexes rather than scanning posts, and that the
 * JSON-path filters on other fields return exactly the right rows.
 */

jest.setTimeout(600_000);

const PARTNER = '0191e3a0-8888-7000-8000-000000000001';
const GEO_AREA = '0191e3a0-8888-7000-8000-000000000011';
const TENANT = '0191e3a0-8888-7000-8000-000000000021';
const USER = '0191e3a0-8888-7000-8000-000000000031';
const MEMBER = '0191e3a0-8888-7000-8000-000000000041';
const CATEGORY = '0191e3a0-8888-7000-8000-000000000051';
const SCHEMA = '0191e3a0-8888-7000-8000-000000000061';
const FIXTURE_PREFIX = '0191e3a0-8888-7000-8000-%';
const ROWS = 100_000;

const definition: CategoryFieldDefinition = {
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      price: { 'x-field-type': 'money', type: 'string' },
      bedrooms: { 'x-field-type': 'number', type: 'integer' },
      floor: { 'x-field-type': 'number', type: 'integer' },
      has_lift: { 'x-field-type': 'bool', type: 'boolean' },
    },
    required: ['price'],
  },
  uiSchema: { order: ['price', 'bedrooms', 'floor', 'has_lift'], card: [], labels: {} },
  filterableFields: ['price', 'bedrooms', 'floor', 'has_lift'],
  searchableFields: [],
  analyticsFields: [],
};

const dialect = new PgDialect();

/** The query a listing would run: tenant, category and live-feed scoping plus the field filters. */
function listingQuery(filters: Parameters<typeof parseFieldFilters>[1]) {
  const conditions = postFieldFilterConditions(parseFieldFilters(definition, filters));
  return dialect.sqlToQuery(sql`
    select count(*)::int as n from ${posts}
    where ${and(
      sql`${posts.tenantId} = ${TENANT}`,
      sql`${posts.categoryId} = ${CATEGORY}`,
      sql`${posts.statusCode} = 'live'`,
      sql`${posts.deletedAt} is null`,
      sql`not ${posts.hiddenByOwner}`,
      ...conditions,
    )}`);
}

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

describe('Field filters on 100k posts', () => {
  let admin: Sql;

  async function cleanUp(): Promise<void> {
    await admin`delete from posts where tenant_id::text like ${FIXTURE_PREFIX}`;
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

    await admin`insert into users (id, phone_e164) values (${USER}, '+8801788000001')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Filter Perf Partner', 'Filter Perf Partner', '+8801788000099')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release)
      values (${GEO_AREA}, 3, 'upazila', 'filter-perf-a', 'Filter Perf Area', 'fixture')`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values (${TENANT}, ${PARTNER}, ${GEO_AREA}, 'filter-perf-tenant', 'এ', 'A',
              st_point(90.4, 23.8)::geography, 'active')`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values (${MEMBER}, ${TENANT}, ${USER}, 'member')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en)
      values (${CATEGORY}, 'rental', 'filter-perf-to-let', 'টু-লেট', 'To-Let')`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, status_code, published_at)
      values (${SCHEMA}, ${CATEGORY}, 1, ${admin.json(definition.jsonSchema as never)}, 'published', now())`;

    // Deterministic spread: bedrooms 0–5, rent 3,000–52,999, floor 0–9, lift on every other row.
    await admin`
      insert into posts
        (tenant_id, author_member_id, category_id, field_schema_id, title, fields,
         status_code, published_at, bumped_at)
      select ${TENANT}, ${MEMBER}, ${CATEGORY}, ${SCHEMA}, 'post ' || i,
             jsonb_build_object(
               'price', (3000 + (i * 7919) % 50000)::text || '.00',
               'bedrooms', i % 6,
               'floor', i % 10,
               'has_lift', i % 2 = 0),
             'live', now(), now()
      from generate_series(1, ${ROWS}) as i`;
    await admin`analyze posts`;
  });

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await admin.end();
    }
  });

  async function run(query: { sql: string; params: unknown[] }): Promise<number> {
    const [row] = await admin.unsafe<{ n: number }[]>(query.sql, query.params as never[]);
    return row!.n;
  }

  async function plan(query: { sql: string; params: unknown[] }): Promise<PlanNode[]> {
    const [row] = await admin.unsafe<{ 'QUERY PLAN': [{ Plan: PlanNode }] }[]>(
      `explain (format json) ${query.sql}`,
      query.params as never[],
    );
    return nodes(row!['QUERY PLAN'][0].Plan);
  }

  it('answers "bedrooms >= 2 AND rent < 15000" correctly from an index, not a scan of posts', async () => {
    const query = listingQuery([
      { field: 'bedrooms', op: 'gte', value: '2' },
      { field: 'price', op: 'lt', value: '15000' },
    ]);

    const [expected] = await admin<{ n: number }[]>`
      select count(*)::int as n from posts
      where tenant_id = ${TENANT} and (fields->>'bedrooms')::int >= 2
        and (fields->>'price')::numeric < 15000`;
    expect(await run(query)).toBe(expected!.n);
    expect(expected!.n).toBeGreaterThan(0);

    const planNodes = await plan(query);
    const indexNames = planNodes.map((n) => n['Index Name']).filter(Boolean);
    expect(indexNames).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^posts_tenant_category_(price|bedrooms)_idx$/),
      ]),
    );
    expect(
      planNodes.some((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'posts'),
    ).toBe(false);
  });

  it('returns exact results for JSON-path range and containment filters', async () => {
    const query = listingQuery([
      { field: 'floor', op: 'gte', value: '8' },
      { field: 'has_lift', op: 'eq', value: 'true' },
    ]);
    // floor 8 or 9 (2 in 10) and lift on even rows: i % 10 in {8} → 1 in 10 of all rows.
    expect(await run(query)).toBe(ROWS / 10);
  });
});
