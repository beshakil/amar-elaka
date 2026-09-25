import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/tokens/token.service';
import { FieldValidationException } from '../src/categories/categories.exceptions';
import { FieldValidationService } from '../src/categories/field-validation.service';
import { TenantContext } from '../src/database/tenant-context';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * The category engine end to end, on real Postgres + Redis:
 * platform admin creates a category and publishes field schema v1, a tenant
 * admin enables it, GET /categories serves it per tenant, a post pins v1,
 * then v2 removes a field and adds a required one, and the v1 post still
 * renders (GET /categories/schemas/:id) and validates against v1.
 */

const PARTNER = '0191e3a0-f00f-7000-8000-000000000001';
const GEO_AREA_A = '0191e3a0-f00f-7000-8000-000000000011';
const GEO_AREA_B = '0191e3a0-f00f-7000-8000-000000000012';
const TENANT_A = '0191e3a0-f00f-7000-8000-000000000021';
const TENANT_B = '0191e3a0-f00f-7000-8000-000000000022';
const FIXTURE_PREFIX = '0191e3a0-f00f-7000-8000-%';
const SLUG = 'e2e-cat-to-let';
const RUN_ID = Date.now().toString().slice(-6);
const NO_MEMBER = '00000000-0000-7000-8000-000000000000';

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+88018${RUN_ID}${phoneCounter.toString().padStart(2, '0')}`;
}

const label = (bn: string, en: string) => ({ bn, en });

const v1Draft = {
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      property_type: { 'x-field-type': 'select', type: 'string', enum: ['flat', 'shop'] },
      bedrooms: { 'x-field-type': 'number', type: 'integer', minimum: 0, maximum: 20 },
      price: {
        'x-field-type': 'money',
        type: 'string',
        'x-money-min': '100.00',
        'x-money-max': '10000000.00',
      },
    },
    required: ['property_type', 'price'],
  },
  uiSchema: {
    order: ['property_type', 'bedrooms', 'price'],
    card: ['bedrooms'],
    labels: {
      property_type: label('ধরন', 'Property type'),
      bedrooms: label('শোবার ঘর', 'Bedrooms'),
      price: label('মাসিক ভাড়া', 'Monthly rent'),
    },
    options: { property_type: { flat: label('ফ্ল্যাট', 'Flat'), shop: label('দোকান', 'Shop') } },
  },
  filterableFields: ['property_type', 'bedrooms', 'price'],
  searchableFields: ['property_type'],
  analyticsFields: ['property_type', 'bedrooms', 'price'],
};

// v2 removes bedrooms and adds a required gas_supply.
const v2Draft = {
  jsonSchema: {
    ...v1Draft.jsonSchema,
    properties: {
      property_type: v1Draft.jsonSchema.properties.property_type,
      price: v1Draft.jsonSchema.properties.price,
      gas_supply: {
        'x-field-type': 'select',
        type: 'string',
        enum: ['pipeline', 'cylinder', 'none'],
      },
    },
    required: ['property_type', 'price', 'gas_supply'],
  },
  uiSchema: {
    order: ['property_type', 'price', 'gas_supply'],
    card: ['gas_supply'],
    labels: {
      property_type: v1Draft.uiSchema.labels.property_type,
      price: v1Draft.uiSchema.labels.price,
      gas_supply: label('গ্যাস', 'Gas'),
    },
    options: {
      property_type: v1Draft.uiSchema.options.property_type,
      gas_supply: {
        pipeline: label('লাইনের গ্যাস', 'Pipeline gas'),
        cylinder: label('সিলিন্ডার', 'Cylinder'),
        none: label('নেই', 'None'),
      },
    },
  },
  filterableFields: ['property_type', 'price', 'gas_supply'],
  searchableFields: ['property_type'],
  analyticsFields: ['property_type', 'price', 'gas_supply'],
};

interface Actor {
  userId: string;
  token: string;
}

describe('Category engine (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: Sql;
  let tokens: TokenService;
  const actors: Record<string, Actor> = {};
  let categoryId: string;
  let v1Id: string;
  let v2Id: string;
  const v1Post = { property_type: 'flat', bedrooms: 3, price: '12000.00' };

  async function createActor(
    name: string,
    options: { platformRole?: string; tenantRole?: string },
  ): Promise<void> {
    const [user] = await admin<{ id: string }[]>`
      insert into users (phone_e164, phone_verified_at, platform_role_code)
      values (${nextPhone()}, now(), ${options.platformRole ?? null}) returning id`;
    let memberId = NO_MEMBER;
    if (options.tenantRole) {
      const [member] = await admin<{ id: string }[]>`
        insert into tenant_members (tenant_id, user_id, role_code)
        values (${TENANT_A}, ${user!.id}, ${options.tenantRole}) returning id`;
      memberId = member!.id;
    }
    const token = await tokens.signAccessToken({
      userId: user!.id,
      tenantId: TENANT_A,
      memberId,
      role: (options.tenantRole ?? 'member') as never,
    });
    actors[name] = { userId: user!.id, token };
  }

  const as = (name: string, tenantId = TENANT_A) => ({
    authorization: `Bearer ${actors[name]!.token}`,
    'x-tenant-id': tenantId,
  });

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164) values
        (${PARTNER}, 'Category E2E Partner', 'Category E2E Partner', '+8801911000070')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
        (${GEO_AREA_A}, 3, 'upazila', 'category-e2e-a', 'Category E2E Area A', 'fixture'),
        (${GEO_AREA_B}, 3, 'upazila', 'category-e2e-b', 'Category E2E Area B', 'fixture')`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
        (${TENANT_A}, ${PARTNER}, ${GEO_AREA_A}, 'category-e2e-a', 'এ', 'A', st_point(90.4, 23.8)::geography, 'active'),
        (${TENANT_B}, ${PARTNER}, ${GEO_AREA_B}, 'category-e2e-b', 'বি', 'B', st_point(90.5, 23.9)::geography, 'active')`;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api', {
      exclude: [
        { path: 'health/live', method: RequestMethod.GET },
        { path: 'health/ready', method: RequestMethod.GET },
      ],
    });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    tokens = moduleRef.get(TokenService);

    await createActor('platformAdmin', { platformRole: 'platform_admin' });
    await createActor('platformSupport', { platformRole: 'platform_support' });
    await createActor('tenantAdmin', { tenantRole: 'tenant_admin' });
    await createActor('member', { tenantRole: 'member' });
  });

  afterAll(async () => {
    await app.close();
    try {
      await admin`delete from posts where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenant_categories where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from category_field_schemas
                  where category_id in (select id from categories where slug like 'e2e-cat-%')`;
      await admin`delete from categories where slug like 'e2e-cat-%'`;
      await admin`delete from tenant_members where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from users where phone_e164 like ${`+88018${RUN_ID}%`}`;
    } finally {
      await admin.end();
    }
  });

  const createBody = {
    slug: SLUG,
    kind: 'rental',
    nameBn: 'টু-লেট',
    nameEn: 'To-Let',
    iconKey: 'key-round',
    monetizationMode: 'per_listing',
    postCostCredits: 2,
    postExpiryDays: 30,
    requiresApproval: true,
  };

  it('lets only a platform admin create categories', async () => {
    for (const actor of ['platformSupport', 'tenantAdmin', 'member']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/platform/categories',
        headers: as(actor),
        payload: createBody,
      });
      expect(response.statusCode).toBe(403);
    }

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/platform/categories',
      headers: as('platformAdmin'),
      payload: createBody,
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<{
      id: string;
      requiresApproval: boolean;
      monetizationMode: string;
    }>();
    expect(body).toMatchObject({ requiresApproval: true, monetizationMode: 'per_listing' });
    categoryId = body.id;
  });

  it('validates the request body and rejects a duplicate slug', async () => {
    const invalid = await app.inject({
      method: 'PATCH',
      url: `/api/v1/platform/categories/${categoryId}`,
      headers: as('platformAdmin'),
      payload: { postExpiryDays: 0 },
    });
    expect(invalid.statusCode).toBe(400);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/platform/categories',
      headers: as('platformAdmin'),
      payload: createBody,
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it('publishes field schema v1 from a draft', async () => {
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/v1/platform/categories/${categoryId}/schema-draft`,
      headers: as('platformAdmin'),
      payload: v1Draft,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ version: 1, status: 'draft' });

    const published = await app.inject({
      method: 'POST',
      url: `/api/v1/platform/categories/${categoryId}/schema-draft/publish`,
      headers: as('platformAdmin'),
    });
    expect(published.statusCode).toBe(200);
    const body = published.json<{ id: string; version: number; status: string }>();
    expect(body).toMatchObject({ version: 1, status: 'published' });
    v1Id = body.id;
  });

  it('rejects an invalid schema draft with a typed error', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/platform/categories/${categoryId}/schema-draft`,
      headers: as('platformAdmin'),
      payload: { ...v1Draft, analyticsFields: ['nope'] },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'CATEGORY_FIELD_SCHEMA_INVALID' });
  });

  it('lets a tenant admin, and not a member, enable the category in their tenant', async () => {
    const forbidden = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/categories/${categoryId}`,
      headers: as('member'),
      payload: { isEnabled: true },
    });
    expect(forbidden.statusCode).toBe(403);

    const enabled = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/categories/${categoryId}`,
      headers: as('tenantAdmin'),
      payload: { isEnabled: true, postExpiryDays: 14 },
    });
    expect(enabled.statusCode).toBe(204);

    const loosened = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/categories/${categoryId}`,
      headers: as('tenantAdmin'),
      payload: { requiresApproval: false },
    });
    expect(loosened.statusCode).toBe(422);
  });

  it('serves GET /categories per tenant, with the current schema', async () => {
    const inA = await app.inject({
      method: 'GET',
      url: '/api/v1/categories',
      headers: { 'x-tenant-id': TENANT_A },
    });
    expect(inA.statusCode).toBe(200);
    const category = inA.json<{ slug: string }[]>().find((c) => c.slug === SLUG);
    expect(category).toMatchObject({
      id: categoryId,
      postCostCredits: 2,
      postExpiryDays: 14,
      requiresApproval: true,
      fieldSchema: { id: v1Id, version: 1 },
    });

    const inB = await app.inject({
      method: 'GET',
      url: '/api/v1/categories',
      headers: { 'x-tenant-id': TENANT_B },
    });
    expect(inB.statusCode).toBe(200);
    expect(inB.json<{ slug: string }[]>().some((c) => c.slug === SLUG)).toBe(false);
  });

  it('keeps a post written under v1 readable and valid after v2 removes and adds fields', async () => {
    const [member] = await admin<{ id: string }[]>`
      select id from tenant_members where user_id = ${actors.member!.userId}`;
    const [post] = await admin<{ id: string }[]>`
      insert into posts (tenant_id, author_member_id, category_id, field_schema_id, title, fields)
      values (${TENANT_A}, ${member!.id}, ${categoryId}, ${v1Id}, 'Flat for rent', ${admin.json(v1Post)})
      returning id`;

    await app.inject({
      method: 'PUT',
      url: `/api/v1/platform/categories/${categoryId}/schema-draft`,
      headers: as('platformAdmin'),
      payload: v2Draft,
    });
    const published = await app.inject({
      method: 'POST',
      url: `/api/v1/platform/categories/${categoryId}/schema-draft/publish`,
      headers: as('platformAdmin'),
    });
    expect(published.json()).toMatchObject({ version: 2, status: 'published' });
    v2Id = published.json<{ id: string }>().id;

    // New posts see v2…
    const catalog = await app.inject({
      method: 'GET',
      url: '/api/v1/categories',
      headers: { 'x-tenant-id': TENANT_A },
    });
    const current = catalog
      .json<{ slug: string; fieldSchema: { id: string; jsonSchema: { properties: object } } }[]>()
      .find((c) => c.slug === SLUG)!;
    expect(current.fieldSchema.id).toBe(v2Id);
    expect(Object.keys(current.fieldSchema.jsonSchema.properties)).toEqual([
      'property_type',
      'price',
      'gas_supply',
    ]);

    // …the stored post still pins v1, which is still served, labels and all…
    const [stored] = await admin<{ field_schema_id: string }[]>`
      select field_schema_id from posts where id = ${post!.id}`;
    expect(stored!.field_schema_id).toBe(v1Id);
    const v1 = await app.inject({ method: 'GET', url: `/api/v1/categories/schemas/${v1Id}` });
    expect(v1.statusCode).toBe(200);
    expect(v1.json()).toMatchObject({
      version: 1,
      status: 'retired',
      uiSchema: { labels: { bedrooms: { bn: 'শোবার ঘর', en: 'Bedrooms' } } },
    });

    // …and its fields still validate against v1, while v2 would reject them.
    const validation = app.get(FieldValidationService);
    const context = app.get(TenantContext);
    await context.run({ tenantId: TENANT_A, role: 'member' }, async () => {
      await expect(validation.validateAgainstVersion(v1Id, v1Post)).resolves.toEqual(v1Post);
      const error = await validation
        .validate(categoryId, v1Post)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(FieldValidationException);
      expect((error as FieldValidationException).issues).toEqual(
        expect.arrayContaining([
          { field: 'gas_supply', code: 'field.required' },
          { field: 'bedrooms', code: 'field.not_in_schema' },
        ]),
      );
    });
  });

  it('never serves a draft publicly', async () => {
    const draft = await app.inject({
      method: 'PUT',
      url: `/api/v1/platform/categories/${categoryId}/schema-draft`,
      headers: as('platformAdmin'),
      payload: v2Draft,
    });
    const draftId = draft.json<{ id: string }>().id;
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/categories/schemas/${draftId}`,
    });
    expect(response.statusCode).toBe(404);
  });

  it('soft-deletes a category, which then leaves the catalog', async () => {
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/platform/categories/${categoryId}`,
      headers: as('platformAdmin'),
    });
    expect(deleted.statusCode).toBe(204);
    const catalog = await app.inject({
      method: 'GET',
      url: '/api/v1/categories',
      headers: { 'x-tenant-id': TENANT_A },
    });
    expect(catalog.json<{ slug: string }[]>().some((c) => c.slug === SLUG)).toBe(false);
  });
});
