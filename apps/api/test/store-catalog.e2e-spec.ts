import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/tokens/token.service';
import { parseCsv } from '../src/common/files/csv';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * The WhatsApp catalog end to end (ADR 056): the public catalog never
 * carries a phone number; an order is a lead (source store_catalog) and a
 * wa.me link with the product prefilled; the share image; the owner's
 * Commerce Manager export; a suspended store has no catalog.
 */

const P = '0191e3a0-a0d2-7000-8000-';
const FIXTURE = `${P}%`;
const PARTNER = `${P}000000000001`;
const AREA = `${P}000000000011`;
const TENANT = `${P}000000000021`;
const OWNER = `${P}000000000031`;
const EDITOR = `${P}000000000032`;
const BUYER = `${P}000000000033`;
const M_OWNER = `${P}000000000041`;
const M_EDITOR = `${P}000000000042`;
const M_BUYER = `${P}000000000043`;
const STORE = `${P}000000000051`;
const CATEGORY = `${P}000000000061`;
const SCHEMA = `${P}000000000062`;
const POST_A = `${P}000000000071`;
const POST_B = `${P}000000000072`;
const POST_DRAFT = `${P}000000000073`;
const WHATSAPP = '+8801799700010';
const PHONE = '+8801799700011';
const SLUG = 'catalog-e2e-store';

type Role = 'owner' | 'editor' | 'buyer';

/** Any Bangladeshi mobile number, in any of its spellings. */
const PHONE_PATTERN = /(\+?88)?0?1[3-9]\d{8}|1799700/;

describe('WhatsApp catalog (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: Sql;
  const tokens = {} as Record<Role, string>;

  const call = (method: 'GET' | 'POST', url: string, as?: Role, body?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        'x-tenant-id': TENANT,
        'x-install-id': 'catalog-e2e-install',
        ...(as ? { authorization: `Bearer ${tokens[as]}` } : {}),
      },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });

  async function cleanUp(): Promise<void> {
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from lead_events where tenant_id = ${TENANT}`;
      await tx`delete from post_short_links where tenant_id = ${TENANT}`;
      await tx`delete from posts where tenant_id = ${TENANT}`;
      await tx`delete from store_members where tenant_id = ${TENANT}`;
      await tx`delete from stores where tenant_id = ${TENANT}`;
      await tx`delete from tenant_categories where tenant_id = ${TENANT}`;
      await tx`delete from tenant_members where tenant_id = ${TENANT}`;
    });
    await admin`delete from outbox_events where aggregate_id::text like ${FIXTURE}`;
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();
    await admin`insert into users (id, phone_e164) values
      (${OWNER}, '+8801799700001'), (${EDITOR}, '+8801799700002'), (${BUYER}, '+8801799700003')`;
    await admin`insert into partners (id, legal_name, display_name, phone_e164)
                values (${PARTNER}, 'Catalog E2E', 'Catalog E2E', '+8801799700099')`;
    await admin`insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release)
                values (${AREA}, 3, 'upazila', 'catalog-e2e', 'Catalog E2E', 'fixture')`;
    await admin`insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
                values (${TENANT}, ${PARTNER}, ${AREA}, 'catalog-e2e', 'ক্যাটালগ', 'Catalog', st_point(88.05, 25.05)::geography, 'active')`;
    await admin`insert into tenant_members (id, tenant_id, user_id, role_code) values
      (${M_OWNER}, ${TENANT}, ${OWNER}, 'member'), (${M_EDITOR}, ${TENANT}, ${EDITOR}, 'member'), (${M_BUYER}, ${TENANT}, ${BUYER}, 'member')`;
    await admin`insert into categories (id, kind_code, slug, name_bn, name_en, default_moderation_mode_code, default_post_expiry_days)
                values (${CATEGORY}, 'marketplace', 'catalog-e2e-sale', 'বিক্রি', 'Sale', 'post', 30)`;
    await admin`insert into category_field_schemas (id, category_id, version, json_schema, status_code, published_at)
                values (${SCHEMA}, ${CATEGORY}, 1, '{}'::jsonb, 'published', now())`;
    await admin`insert into tenant_categories (tenant_id, category_id, is_enabled) values (${TENANT}, ${CATEGORY}, true)`;
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code, location, phone_e164, whatsapp_e164)
               values (${STORE}, ${TENANT}, ${M_OWNER}, ${SLUG}, 'ক্যাটালগের দোকান', 'active',
                       st_point(88.05, 25.05)::geography, ${PHONE}, ${WHATSAPP})`;
      await tx`insert into store_members (tenant_id, store_id, member_id, role_code, accepted_at)
               values (${TENANT}, ${STORE}, ${M_EDITOR}, 'editor', now())`;
      for (const [id, title, status, price, description] of [
        [POST_A, 'নাজিরশাইল চাল ৫০ কেজি', 'live', '3200.00', `ফোন করুন ${PHONE} নম্বরে`],
        [POST_B, 'মসুর ডাল', 'live', '140.00', null],
        [POST_DRAFT, 'খসড়া পণ্য', 'draft', '10.00', null],
      ] as const) {
        await tx`insert into posts (id, tenant_id, author_member_id, store_id, category_id, field_schema_id, title, description,
                                    status_code, published_at, bumped_at, location, price_type_code, fields, contact_phone_e164)
                 values (${id}, ${TENANT}, ${M_OWNER}, ${STORE}, ${CATEGORY}, ${SCHEMA}, ${title}, ${description}, ${status},
                         now() - interval '1 hour', now() - interval '1 hour', st_point(88.05, 25.05)::geography, 'fixed',
                         ${tx.json({ price, condition: 'new' })}, ${PHONE})`;
      }
    });

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
    const signer = moduleRef.get(TokenService);
    for (const [role, userId, memberId] of [
      ['owner', OWNER, M_OWNER],
      ['editor', EDITOR, M_EDITOR],
      ['buyer', BUYER, M_BUYER],
    ] as const) {
      tokens[role] = await signer.signAccessToken({
        userId,
        tenantId: TENANT,
        memberId,
        role: 'member',
      });
    }
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    try {
      await cleanUp();
    } finally {
      await admin.end();
    }
  });

  it('lists the live products, light, and never a phone number', async () => {
    const response = await call('GET', `/stores/${SLUG}/catalog`);
    expect(response.statusCode).toBe(200);
    const catalog = response.json<{
      store: { orderable: boolean };
      products: { postId: string; price: string }[];
      shareImagePath: string;
    }>();
    expect(catalog.products.map((p) => p.postId).sort()).toEqual([POST_A, POST_B].sort());
    expect(catalog.store.orderable).toBe(true);
    expect(catalog.shareImagePath).toBe(`/stores/${SLUG}/og.png`);
    // Not the store's numbers, not the posts' contact numbers, not a description that has one.
    expect(response.body).not.toMatch(PHONE_PATTERN);
    for (const product of catalog.products)
      expect(Object.keys(product)).not.toContain('description');
  });

  it('an order is a lead and a wa.me link with the product named', async () => {
    const order = await call('POST', `/stores/${SLUG}/catalog/order/${POST_B}`, 'buyer');
    expect(order.statusCode).toBe(200);
    const reveal = order.json<{ href: string; message: string; phone: string }>();
    expect(reveal.href.startsWith(`https://wa.me/${WHATSAPP.slice(1)}?text=`)).toBe(true);
    expect(reveal.message).toContain('"মসুর ডাল" অর্ডার করতে চাই');
    const [lead] = await admin<
      { channel_code: string; source_code: string; store_id: string; post_id: string }[]
    >`
      select channel_code, source_code, store_id, post_id from lead_events where tenant_id = ${TENANT}`;
    expect(lead).toEqual({
      channel_code: 'whatsapp_click',
      source_code: 'store_catalog',
      store_id: STORE,
      post_id: POST_B,
    });

    // A double tap is the same lead.
    await call('POST', `/stores/${SLUG}/catalog/order/${POST_B}`, 'buyer');
    const [n] = await admin<
      { n: string }[]
    >`select count(*) as n from lead_events where tenant_id = ${TENANT}`;
    expect(Number(n!.n)).toBe(1);

    expect(
      (await call('POST', `/stores/${SLUG}/catalog/order/${POST_B}`, 'owner')).statusCode,
    ).toBe(409);
    expect(
      (await call('POST', `/stores/${SLUG}/catalog/order/${POST_DRAFT}`, 'buyer')).statusCode,
    ).toBe(404);
  });

  it('draws the share card for link previews', async () => {
    const image = await call('GET', `/stores/${SLUG}/og.png`);
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.rawPayload.subarray(1, 4).toString()).toBe('PNG');
  });

  it('exports the Commerce Manager feed for the owner, not an editor', async () => {
    expect((await call('GET', `/stores/${STORE}/catalog.csv`, 'editor')).statusCode).toBe(403);
    const csv = await call('GET', `/stores/${STORE}/catalog.csv`, 'owner');
    expect(csv.statusCode).toBe(200);
    const rows = parseCsv(csv.body);
    expect(rows[0]).toEqual([
      'id',
      'title',
      'description',
      'availability',
      'condition',
      'price',
      'link',
      'image_link',
      'brand',
    ]);
    const rice = rows.find((r) => r[0] === POST_A)!;
    expect(rice.slice(3, 6)).toEqual(['in stock', 'new', '3200.00 BDT']);
    expect(rice[6]).toMatch(/\/s\/[A-Za-z0-9]+$/);
    expect(rows).toHaveLength(3);
  });

  it('a suspended store has no catalog', async () => {
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`update stores set status_code = 'suspended' where id = ${STORE}`;
    });
    expect((await call('GET', `/stores/${SLUG}/catalog`)).statusCode).toBe(404);
    expect(
      (await call('POST', `/stores/${SLUG}/catalog/order/${POST_A}`, 'buyer')).statusCode,
    ).toBe(404);
  });
});
