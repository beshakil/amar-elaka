import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/tokens/token.service';
import { parseCsv } from '../src/common/files/csv';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * The seller tools' API (ADR 057) end to end: the product table, the
 * owner/manager acting on an editor's posts through the ordinary post
 * endpoints, stock status everywhere it shows (store page badge, catalog,
 * order refusal, Commerce Manager export), the counter card PDF and the
 * catalog link in the owner's view.
 */

const P = '0191e3a0-a0d5-7000-8000-';
const FIXTURE = `${P}%`;
const PARTNER = `${P}000000000001`;
const AREA = `${P}000000000011`;
const TENANT = `${P}000000000021`;
const U = (n: number) => `${P}0000000000${30 + n}`;
const M = (n: number) => `${P}0000000000${40 + n}`;
const ROLES = { owner: 1, editor: 2, stranger: 3, buyer: 4 } as const;
type Role = keyof typeof ROLES;
const STORE = `${P}000000000051`;
const SLUG = 'seller-e2e-store';
const CATEGORY = `${P}000000000061`;
const SCHEMA = `${P}000000000062`;
const POST_EDITOR_LIVE = `${P}000000000071`;
const POST_EDITOR_DRAFT = `${P}000000000072`;
const POST_OWNER_LIVE = `${P}000000000073`;
const POST_PERSONAL = `${P}000000000074`;

const SCHEMA_JSON = {
  type: 'object',
  additionalProperties: false,
  properties: {
    price: {
      'x-field-type': 'money',
      type: 'string',
      'x-money-min': '1.00',
      'x-money-max': '1000000.00',
    },
    condition: { 'x-field-type': 'select', type: 'string', enum: ['new', 'used'] },
  },
  required: ['price'],
};
const UI_JSON = {
  order: ['price', 'condition'],
  card: ['price'],
  labels: { price: { bn: 'দাম', en: 'Price' }, condition: { bn: 'অবস্থা', en: 'Condition' } },
  options: { condition: { new: { bn: 'নতুন', en: 'New' }, used: { bn: 'পুরাতন', en: 'Used' } } },
};

interface Product {
  id: string;
  status: string;
  stockStatus: string;
  isMine: boolean;
  canManage: boolean;
  price: string | null;
}

describe('Seller tools (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: Sql;
  const tokens = {} as Record<Role, string>;

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    as?: Role,
    body?: unknown,
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        'x-tenant-id': TENANT,
        'x-install-id': 'seller-e2e-install',
        ...(as ? { authorization: `Bearer ${tokens[as]}` } : {}),
      },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });

  async function cleanUp(): Promise<void> {
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from lead_events where tenant_id = ${TENANT}`;
      await tx`delete from store_follows where tenant_id = ${TENANT}`;
      await tx`delete from post_short_links where tenant_id = ${TENANT}`;
      await tx`delete from moderation_queue_items where tenant_id = ${TENANT}`;
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
    for (const n of Object.values(ROLES)) {
      await admin`insert into users (id, phone_e164) values (${U(n)}, ${`+88017470000${n}0`})`;
    }
    await admin`insert into partners (id, legal_name, display_name, phone_e164)
                values (${PARTNER}, 'Seller E2E', 'Seller E2E', '+8801747000099')`;
    await admin`insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release)
                values (${AREA}, 3, 'upazila', 'seller-e2e', 'Seller E2E', 'fixture')`;
    await admin`insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
                values (${TENANT}, ${PARTNER}, ${AREA}, 'seller-e2e', 'বিক্রেতা', 'Seller', st_point(88.45, 25.45)::geography, 'active')`;
    for (const n of Object.values(ROLES)) {
      await admin`insert into tenant_members (id, tenant_id, user_id, role_code) values (${M(n)}, ${TENANT}, ${U(n)}, 'member')`;
    }
    await admin`insert into categories (id, kind_code, slug, name_bn, name_en, default_moderation_mode_code, default_post_expiry_days)
                values (${CATEGORY}, 'marketplace', 'seller-e2e-sale', 'বিক্রি', 'Sale', 'post', 30)`;
    await admin`insert into category_field_schemas (id, category_id, version, json_schema, ui_schema, status_code, published_at)
                values (${SCHEMA}, ${CATEGORY}, 1, ${admin.json(SCHEMA_JSON)}, ${admin.json(UI_JSON)}, 'published', now())`;
    await admin`insert into tenant_categories (tenant_id, category_id, is_enabled) values (${TENANT}, ${CATEGORY}, true)`;
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code, location, phone_e164, whatsapp_e164)
               values (${STORE}, ${TENANT}, ${M(ROLES.owner)}, ${SLUG}, 'বিক্রেতার দোকান', 'active',
                       st_point(88.45, 25.45)::geography, '+8801747000010', '+8801747000010')`;
      await tx`insert into store_members (tenant_id, store_id, member_id, role_code, accepted_at)
               values (${TENANT}, ${STORE}, ${M(ROLES.editor)}, 'editor', now())`;
      for (const [id, author, store, status, title] of [
        [POST_EDITOR_LIVE, ROLES.editor, STORE, 'live', 'এডিটরের পণ্য'],
        [POST_EDITOR_DRAFT, ROLES.editor, STORE, 'draft', 'এডিটরের খসড়া'],
        [POST_OWNER_LIVE, ROLES.owner, STORE, 'live', 'মালিকের পণ্য'],
        [POST_PERSONAL, ROLES.editor, null, 'live', 'ব্যক্তিগত বিজ্ঞাপন'],
      ] as const) {
        await tx`insert into posts (id, tenant_id, author_member_id, store_id, category_id, field_schema_id, title,
                                    status_code, published_at, bumped_at, location, price_type_code, fields, contact_phone_e164)
                 values (${id}, ${TENANT}, ${M(author)}, ${store}, ${CATEGORY}, ${SCHEMA}, ${title}, ${status},
                         now() - interval '1 hour', now() - interval '1 hour', st_point(88.45, 25.45)::geography, 'fixed',
                         ${tx.json({ price: '500.00', condition: 'new' })}, '+8801747000010')`;
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
    for (const [role, n] of Object.entries(ROLES) as [Role, number][]) {
      tokens[role] = await signer.signAccessToken({
        userId: U(n),
        tenantId: TENANT,
        memberId: M(n),
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

  const products = async (as: Role) => {
    const response = await call('GET', `/stores/${STORE}/products`, as);
    expect(response.statusCode).toBe(200);
    return response.json<{ items: Product[] }>().items;
  };

  it('the product table: all of the store for its owner, own plus public for an editor, nothing for a stranger', async () => {
    const owner = await products('owner');
    expect(owner.map((p) => p.id).sort()).toEqual(
      [POST_EDITOR_LIVE, POST_EDITOR_DRAFT, POST_OWNER_LIVE].sort(),
    );
    expect(owner.every((p) => p.canManage)).toBe(true);
    expect(owner.find((p) => p.id === POST_OWNER_LIVE)?.isMine).toBe(true);
    expect(owner.find((p) => p.id === POST_EDITOR_LIVE)).toMatchObject({
      isMine: false,
      stockStatus: 'in_stock',
      price: '500.00',
    });

    const editor = await products('editor');
    expect(editor.map((p) => p.id).sort()).toEqual(
      [POST_EDITOR_LIVE, POST_EDITOR_DRAFT, POST_OWNER_LIVE].sort(),
    );
    expect(editor.find((p) => p.id === POST_OWNER_LIVE)).toMatchObject({
      isMine: false,
      canManage: false,
    });

    expect((await call('GET', `/stores/${STORE}/products`, 'stranger')).statusCode).toBe(403);
    const drafts = await call('GET', `/stores/${STORE}/products?status=draft`, 'owner');
    expect(drafts.json<{ items: Product[] }>().items.map((p) => p.id)).toEqual([POST_EDITOR_DRAFT]);
  });

  it("the owner runs an editor's post: price, hide, delete — not its photos; an editor can't touch the owner's", async () => {
    const priced = await call('PATCH', `/posts/${POST_EDITOR_LIVE}`, 'owner', {
      fields: { price: '450.00', condition: 'new' },
    });
    expect(priced.statusCode).toBe(200);
    expect(priced.json<{ price: string; isMine: boolean; hiddenByOwner: boolean }>()).toMatchObject(
      {
        price: '450.00',
        isMine: false,
        hiddenByOwner: false,
      },
    );
    expect(
      (await call('PATCH', `/posts/${POST_EDITOR_LIVE}`, 'owner', { mediaIds: [] })).json<{
        error: string;
      }>().error,
    ).toBe('POST_NOT_OWNER');

    expect(
      (await call('POST', `/posts/${POST_EDITOR_DRAFT}/hide`, 'owner')).json<{
        hiddenByOwner: boolean;
      }>().hiddenByOwner,
    ).toBe(true);
    expect((await call('POST', `/posts/${POST_EDITOR_DRAFT}/unhide`, 'owner')).statusCode).toBe(
      200,
    );
    expect((await call('POST', `/posts/${POST_OWNER_LIVE}/hide`, 'editor')).statusCode).toBe(403);
    // The editor's personal post is theirs alone.
    expect((await call('POST', `/posts/${POST_PERSONAL}/hide`, 'owner')).statusCode).toBe(403);

    const deleted = await call('DELETE', `/posts/${POST_EDITOR_DRAFT}`, 'owner');
    expect(deleted.statusCode).toBe(204);
    const [row] = await admin<
      { deletion_reason_code: string }[]
    >`select deletion_reason_code from posts where id = ${POST_EDITOR_DRAFT}`;
    expect(row?.deletion_reason_code).toBe('user_deleted');
  });

  it('stock: set by the owner, shown on the store page and catalog, refused for orders, exported as availability', async () => {
    const set = await call('POST', `/posts/${POST_EDITOR_LIVE}/stock`, 'owner', {
      stockStatus: 'out_of_stock',
    });
    expect(set.statusCode).toBe(200);
    expect(set.json<{ stockStatus: string }>().stockStatus).toBe('out_of_stock');
    expect(
      (await call('POST', `/posts/${POST_OWNER_LIVE}/stock`, 'editor', { stockStatus: 'on_order' }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await call('POST', `/posts/${POST_PERSONAL}/stock`, 'editor', { stockStatus: 'on_order' })
      ).json<{ error: string }>().error,
    ).toBe('POST_NOT_STORE_PRODUCT');
    await call('POST', `/posts/${POST_OWNER_LIVE}/stock`, 'owner', { stockStatus: 'on_order' });

    const page = (await call('GET', `/stores/${SLUG}`)).json<{
      posts: { id: string; badges: string[] }[];
    }>();
    expect(page.posts.find((p) => p.id === POST_EDITOR_LIVE)?.badges).toContain('out_of_stock');
    expect(page.posts.find((p) => p.id === POST_OWNER_LIVE)?.badges).toContain('on_order');

    const catalog = (await call('GET', `/stores/${SLUG}/catalog`)).json<{
      products: { postId: string; stockStatus: string }[];
    }>();
    expect(catalog.products.find((p) => p.postId === POST_EDITOR_LIVE)?.stockStatus).toBe(
      'out_of_stock',
    );
    const order = await call('POST', `/stores/${SLUG}/catalog/order/${POST_EDITOR_LIVE}`, 'buyer');
    expect(order.statusCode).toBe(409);
    expect(order.json<{ error: string }>().error).toBe('CONTACT_OUT_OF_STOCK');
    expect(
      (await call('POST', `/stores/${SLUG}/catalog/order/${POST_OWNER_LIVE}`, 'buyer')).statusCode,
    ).toBe(200);

    const rows = parseCsv((await call('GET', `/stores/${STORE}/catalog.csv`, 'owner')).body);
    expect(rows.find((r) => r[0] === POST_EDITOR_LIVE)?.[3]).toBe('out of stock');
    expect(rows.find((r) => r[0] === POST_OWNER_LIVE)?.[3]).toBe('preorder');
  });

  it('the public page says how to reach the store and whether you follow it — never a number', async () => {
    const before = (await call('GET', `/stores/${SLUG}`, 'buyer')).json<{
      url: string;
      isFollowing: boolean;
      contactChannels: string[];
    }>();
    expect(before.contactChannels).toEqual(['call', 'whatsapp', 'sms']);
    expect(before.isFollowing).toBe(false);
    expect(before.url).toMatch(new RegExp(`/store/${SLUG}$`));
    expect(JSON.stringify(before)).not.toContain('1747000010');
    expect((await call('POST', `/stores/${STORE}/follow`, 'buyer')).statusCode).toBe(200);
    expect(
      (await call('GET', `/stores/${SLUG}`, 'buyer')).json<{ isFollowing: boolean }>().isFollowing,
    ).toBe(true);
    expect(
      (await call('GET', `/stores/${SLUG}`)).json<{ isFollowing: boolean }>().isFollowing,
    ).toBe(false);
  });

  it('the counter card: A5 and sticker PDFs for the store’s people; the catalog link in the owner’s view', async () => {
    const a5 = await call('GET', `/stores/${STORE}/counter-card.pdf`, 'editor');
    expect(a5.statusCode).toBe(200);
    expect(a5.headers['content-type']).toBe('application/pdf');
    const pdf = a5.rawPayload.toString('latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('/MediaBox [0 0 419.53 595.28]');
    const sticker = await call('GET', `/stores/${STORE}/counter-card.pdf?size=sticker`, 'owner');
    expect(sticker.rawPayload.toString('latin1')).toContain('/MediaBox [0 0 283.46 283.46]');
    expect((await call('GET', `/stores/${STORE}/counter-card.pdf`, 'stranger')).statusCode).toBe(
      403,
    );
    const preview = await call('GET', `/stores/${STORE}/counter-card.png?size=sticker`, 'owner');
    expect(preview.headers['content-type']).toBe('image/png');
    expect(preview.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    expect(
      (await call('GET', `/stores/${STORE}/counter-card.pdf?size=poster`, 'owner')).statusCode,
    ).toBe(400);

    const view = (await call('GET', `/stores/${STORE}/manage`, 'owner')).json<{
      catalogUrl: string;
    }>();
    expect(view.catalogUrl).toMatch(
      new RegExp(`^https?://seller-e2e\\.[^/]+/store/${SLUG}/catalog$`),
    );
  });
});
