import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Sql } from 'postgres';
import sharp from 'sharp';
import { AppModule } from '../src/app.module';
import { STORAGE_SERVICE, type StorageService } from '../src/storage/storage.ports';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * The public web's API (ADR 039) on real Postgres + storage: what each
 * listing URL should answer (render / 410 / 404, sold noindex after
 * sold_noindex_days), the sitemap's data (host tenant only), the store page
 * (never a phone), and the share image (a real PNG, rendered once).
 */

const FIXTURE = '0191e3a0-5e00-7000-8000-%';
const PARTNER = '0191e3a0-5e00-7000-8000-000000000001';
const AREA_A = '0191e3a0-5e00-7000-8000-000000000011';
const AREA_B = '0191e3a0-5e00-7000-8000-000000000012';
const TENANT_A = '0191e3a0-5e00-7000-8000-000000000021';
const TENANT_B = '0191e3a0-5e00-7000-8000-000000000022';
const SELLER = '0191e3a0-5e00-7000-8000-000000000031';
const M_SELLER = '0191e3a0-5e00-7000-8000-000000000041';
const M_SELLER_B = '0191e3a0-5e00-7000-8000-000000000042';
const CATEGORY = '0191e3a0-5e00-7000-8000-000000000051';
const SCHEMA = '0191e3a0-5e00-7000-8000-000000000061';
const STORE = '0191e3a0-5e00-7000-8000-000000000071';
const STORE_CLOSED = '0191e3a0-5e00-7000-8000-000000000072';
const MEDIA = '0191e3a0-5e00-7000-8000-000000000081';

const square = (west: number, east: number) =>
  `SRID=4326;MULTIPOLYGON(((${west} 20.0,${east} 20.0,${east} 20.1,${west} 20.1,${west} 20.0)))`;

interface Status {
  state: string;
  tenantSlug: string | null;
  title: string | null;
  indexable: boolean;
}

describe('Public web SEO (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: Sql;
  let storage: StorageService;

  async function cleanUp(): Promise<void> {
    await admin`delete from media_attachments where tenant_id::text like ${FIXTURE}`;
    await admin`delete from media_assets where tenant_id::text like ${FIXTURE}`;
    await admin`delete from outbox_events where aggregate_id::text like ${FIXTURE}`;
    await admin`delete from posts where tenant_id::text like ${FIXTURE}`;
    await admin`delete from stores where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_categories where tenant_id::text like ${FIXTURE}`;
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
    await cleanUp();
    await admin`insert into users (id, phone_e164) values (${SELLER}, '+8801755500001')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'SEO Partner', 'SEO Partner', '+8801755500099')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, name_bn, source_release, boundary, boundary_simplified)
      values
        (${AREA_A}, 3, 'upazila', 'seo-a', 'SEO A', 'এসইও এ', 'fixture', ${square(86.0, 86.1)}, ${square(86.0, 86.1)}),
        (${AREA_B}, 3, 'upazila', 'seo-b', 'SEO B', 'এসইও বি', 'fixture', ${square(86.1, 86.2)}, ${square(86.1, 86.2)})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values
        (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'seo-a', 'শিবপুর', 'A', st_point(86.05, 20.05)::geography, 'active'),
        (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'seo-b', 'বি', 'B', st_point(86.15, 20.05)::geography, 'active')`;
    await admin`insert into tenant_settings (tenant_id) values (${TENANT_A}), (${TENANT_B})`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${M_SELLER}, ${TENANT_A}, ${SELLER}, 'member'), (${M_SELLER_B}, ${TENANT_B}, ${SELLER}, 'member')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en)
      values (${CATEGORY}, 'marketplace', 'seo-phones', 'ফোন', 'Phones')`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, status_code)
      values (${SCHEMA}, ${CATEGORY}, 1, '{}'::jsonb, 'draft')`;
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`
        insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code, is_verified, phone_e164, address_text)
        values
          (${STORE}, ${TENANT_A}, ${M_SELLER}, 'seo-shop', 'শিবপুর মোবাইল', 'active', true, '+8801755500002', 'বাজার রোড'),
          (${STORE_CLOSED}, ${TENANT_A}, ${M_SELLER}, 'seo-closed', 'বন্ধ দোকান', 'closed', false, null, null)`;
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
    storage = moduleRef.get<StorageService>(STORAGE_SERVICE);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    try {
      await cleanUp();
    } finally {
      await admin.end();
    }
  });

  const get = (url: string, tenant = TENANT_A) =>
    app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { 'x-tenant-id': tenant } });

  let n = 0x1000;
  const post = async (
    options: {
      status?: string;
      tenant?: string;
      member?: string;
      soldDaysAgo?: number;
      hidden?: boolean;
      deleted?: boolean;
      storeId?: string;
    } = {},
  ): Promise<string> => {
    const id = `0191e3a0-5e00-7000-8000-${(n++).toString(16).padStart(12, '0')}`;
    const status = options.status ?? 'live';
    const published = ['live', 'sold', 'expired', 'removed'].includes(status);
    await admin`
      insert into posts
        (id, tenant_id, author_member_id, store_id, category_id, field_schema_id, title, fields, status_code,
         published_at, sold_at, location, geo_area_id, hidden_by_owner, deleted_at, deletion_reason_code,
         contact_phone_e164, moderation_reason_code)
      values
        (${id}, ${options.tenant ?? TENANT_A}, ${options.member ?? M_SELLER}, ${options.storeId ?? null}, ${CATEGORY},
         ${SCHEMA}, 'আইফোন ১৩ প্রো ম্যাক্স', ${admin.json({ price: '65000.00' })}, ${status},
         ${published ? admin`now() - interval '200 days'` : null},
         ${status === 'sold' ? admin`now() - make_interval(days => ${options.soldDaysAgo ?? 1})` : null},
         'SRID=4326;POINT(86.05 20.05)', ${AREA_A}, ${options.hidden ?? false},
         ${options.deleted ? admin`now()` : null}, ${options.deleted ? 'user_deleted' : null},
         '+8801755500001', ${status === 'removed' ? 'spam' : null})`;
    return id;
  };

  describe('GET /seo/listing-status/:id', () => {
    const status = async (id: string) => (await get(`/seo/listing-status/${id}`)).json<Status>();

    it('live renders and is indexed, with its title and owning tenant', async () => {
      expect(await status(await post())).toMatchObject({
        state: 'live',
        tenantSlug: 'seo-a',
        title: 'আইফোন ১৩ প্রো ম্যাক্স',
        indexable: true,
      });
    });

    it('sold stays up, indexed until sold_noindex_days (90) have passed', async () => {
      expect(await status(await post({ status: 'sold', soldDaysAgo: 10 }))).toMatchObject({
        state: 'sold',
        indexable: true,
      });
      expect(await status(await post({ status: 'sold', soldDaysAgo: 120 }))).toMatchObject({
        state: 'sold',
        indexable: false,
      });
    });

    it('expired, removed and deleted are gone (410), without their titles', async () => {
      for (const id of [
        await post({ status: 'expired' }),
        await post({ status: 'removed' }),
        await post({ deleted: true }),
      ]) {
        expect(await status(id)).toMatchObject({ state: 'gone', title: null, indexable: false });
      }
    });

    it('draft, in review, hidden and unknown are not found (404)', async () => {
      for (const id of [
        await post({ status: 'draft' }),
        await post({ status: 'pending' }),
        await post({ hidden: true }),
        '0191e3a0-5e00-7000-8000-00000000ffff',
      ]) {
        expect(await status(id)).toMatchObject({
          state: 'not_found',
          title: null,
          tenantSlug: null,
        });
      }
    });

    it("names a neighbour's post's own tenant (the canonical host)", async () => {
      const id = await post({ tenant: TENANT_B, member: M_SELLER_B });
      expect(await status(id)).toMatchObject({ state: 'live', tenantSlug: 'seo-b' });
    });
  });

  describe('sitemap data', () => {
    it("lists the host tenant's live and still-indexed sold posts, and its active stores", async () => {
      const live = await post();
      const soldRecent = await post({ status: 'sold', soldDaysAgo: 5 });
      const soldOld = await post({ status: 'sold', soldDaysAgo: 200 });
      const draft = await post({ status: 'draft' });
      const other = await post({ tenant: TENANT_B, member: M_SELLER_B });

      const summary = (await get('/seo/sitemap/summary')).json<{
        posts: number;
        stores: number;
        urlsPerFile: number;
      }>();
      expect(summary.urlsPerFile).toBe(10_000);
      expect(summary.stores).toBe(1);

      const items = (await get('/seo/sitemap/posts?limit=1000')).json<{ items: { id: string }[] }>()
        .items;
      const ids = items.map((i) => i.id);
      expect(ids).toEqual(expect.arrayContaining([live, soldRecent]));
      expect(ids).not.toContain(soldOld);
      expect(ids).not.toContain(draft);
      expect(ids).not.toContain(other);
      expect(summary.posts).toBe(items.length);

      const firstTwo = (await get('/seo/sitemap/posts?limit=2')).json<{
        items: { id: string }[];
      }>();
      const next = (await get('/seo/sitemap/posts?offset=1&limit=1')).json<{
        items: { id: string }[];
      }>();
      expect(next.items[0]!.id).toBe(firstTwo.items[1]!.id);

      const stores = (await get('/seo/sitemap/stores')).json<{ items: { slug: string }[] }>();
      expect(stores.items.map((s) => s.slug)).toEqual(['seo-shop']);
    });
  });

  describe('GET /stores/:slug', () => {
    it("shows an active store and its live listings — never the store's phone", async () => {
      const listed = await post({ storeId: STORE });
      await post({ storeId: STORE, status: 'draft' });
      const response = await get('/stores/seo-shop');
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('01755500002');
      const page = response.json<{
        name: { bn: string };
        isVerified: boolean;
        posts: { id: string }[];
      }>();
      expect(page).toMatchObject({
        name: { bn: 'শিবপুর মোবাইল' },
        isVerified: true,
        addressText: 'বাজার রোড',
      });
      expect(page.posts.map((p) => p.id)).toEqual([listed]);
    });

    it('is a 404 for a closed store, or one in another tenant', async () => {
      expect((await get('/stores/seo-closed')).statusCode).toBe(404);
      expect((await get('/stores/seo-shop', TENANT_B)).statusCode).toBe(404);
    });
  });

  describe('GET /posts/:id/og.png', () => {
    it('draws a 1200×630 PNG once, then serves the stored one', async () => {
      const id = await post({ status: 'sold', soldDaysAgo: 2 });
      // A real cover photo for the right-hand side.
      const photo = await sharp({
        create: { width: 1200, height: 900, channels: 3, background: '#3a7be8' },
      })
        .webp()
        .toBuffer();
      await storage.putObject('media', 'seo-e2e/full.webp', photo, 'image/webp');
      await admin`
        insert into media_assets
          (id, tenant_id, uploaded_by_user_id, kind_code, visibility_code, storage_key, mime_type, byte_size,
           checksum_sha256, status_code, variants)
        values (${MEDIA}, ${TENANT_A}, ${SELLER}, 'image', 'public', 'seo-e2e/original', 'image/webp', 10,
                ${'5'.repeat(64)}, 'ready', ${admin.json({
                  thumb: { key: 'seo-e2e/full.webp', width: 200, height: 150, bytes: 1 },
                  card: { key: 'seo-e2e/full.webp', width: 600, height: 450, bytes: 1 },
                  full: { key: 'seo-e2e/full.webp', width: 1200, height: 900, bytes: 1 },
                })})`;
      await admin`insert into media_attachments (tenant_id, media_asset_id, post_id) values (${TENANT_A}, ${MEDIA}, ${id})`;

      const first = await get(`/posts/${id}/og.png`);
      expect(first.statusCode).toBe(200);
      expect(first.headers['content-type']).toBe('image/png');
      const meta = await sharp(first.rawPayload).metadata();
      expect(meta).toMatchObject({ format: 'png', width: 1200, height: 630 });

      const second = await get(`/posts/${id}/og.png`);
      expect(second.rawPayload.equals(first.rawPayload)).toBe(true);
    });

    it('is a 404 for a post the public cannot see', async () => {
      expect((await get(`/posts/${await post({ status: 'draft' })}/og.png`)).statusCode).toBe(404);
      expect((await get(`/posts/${await post({ status: 'expired' })}/og.png`)).statusCode).toBe(
        404,
      );
    });
  });
});
