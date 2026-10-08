import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/tokens/token.service';
import { allowEmptyJsonBody } from '../src/common/http/empty-json-body';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * Saved items, store follows, store-activity analytics and the price-drop
 * event end to end (ADR 037) on real Postgres + Redis.
 *
 * Tenant A (SELLER, SAVER, ADMIN, MOD) and tenant B next to it, where SELLER
 * also posts. SAVER saves across both; the list is one list.
 */

const FIXTURE = '0191e3a0-5a0f-7000-8000-%';
const PARTNER = '0191e3a0-5a0f-7000-8000-000000000001';
const AREA_A = '0191e3a0-5a0f-7000-8000-000000000011';
const AREA_B = '0191e3a0-5a0f-7000-8000-000000000012';
const TENANT_A = '0191e3a0-5a0f-7000-8000-000000000021';
const TENANT_B = '0191e3a0-5a0f-7000-8000-000000000022';
const SELLER = '0191e3a0-5a0f-7000-8000-000000000031';
const SAVER = '0191e3a0-5a0f-7000-8000-000000000032';
const ADMIN = '0191e3a0-5a0f-7000-8000-000000000033';
const MOD = '0191e3a0-5a0f-7000-8000-000000000034';
const M_SELLER = '0191e3a0-5a0f-7000-8000-000000000041';
const M_SAVER = '0191e3a0-5a0f-7000-8000-000000000042';
const M_ADMIN = '0191e3a0-5a0f-7000-8000-000000000043';
const M_MOD = '0191e3a0-5a0f-7000-8000-000000000044';
const M_SELLER_B = '0191e3a0-5a0f-7000-8000-000000000045';
const CATEGORY = '0191e3a0-5a0f-7000-8000-000000000051';
const PLACE_CATEGORY = '0191e3a0-5a0f-7000-8000-000000000052';
const SCHEMA = '0191e3a0-5a0f-7000-8000-000000000061';
const STORE = '0191e3a0-5a0f-7000-8000-000000000071';
const STORE_SUSPENDED = '0191e3a0-5a0f-7000-8000-000000000072';
const PLACE = '0191e3a0-5a0f-7000-8000-000000000081';

// Its own patch of map, far from every other suite's tenants.
const square = (west: number, east: number) =>
  `SRID=4326;MULTIPOLYGON(((${west} 21.0,${east} 21.0,${east} 21.1,${west} 21.1,${west} 21.0)))`;
const IN_A = { lat: 21.05, lng: 87.05 };
const IN_B = { lat: 21.05, lng: 87.15 };

type As = 'seller' | 'saver' | 'admin' | 'mod';

interface Saved {
  itemType: string;
  itemId: string;
  state: string;
  name: { bn: string | null } | null;
  price: string | null;
}

describe('Saved items and follows (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: Sql;
  const tokens: Partial<Record<As, string>> = {};

  async function clearSaves(): Promise<void> {
    await admin`delete from saved_posts where user_id::text like ${FIXTURE}`;
    await admin`delete from saved_places where user_id::text like ${FIXTURE}`;
    await admin`delete from saved_stores where user_id::text like ${FIXTURE}`;
    await admin`delete from store_follows where user_id::text like ${FIXTURE}`;
  }

  async function cleanUp(): Promise<void> {
    await clearSaves();
    await admin`delete from notifications where user_id::text like ${FIXTURE}`;
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from moderation_actions where tenant_id::text like ${FIXTURE}`;
    });
    await admin`delete from moderation_queue_items where tenant_id::text like ${FIXTURE}`;
    await admin`delete from member_trust_scores where tenant_id::text like ${FIXTURE}`;
    await admin`delete from outbox_events where aggregate_id::text like ${FIXTURE}`;
    await admin`delete from outbox_events where aggregate_table = 'posts' and payload->>'tenantId' like ${FIXTURE}`;
    await admin`delete from posts where tenant_id::text like ${FIXTURE}`;
    await admin`delete from places where tenant_id::text like ${FIXTURE}`;
    await admin`delete from stores where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_categories where tenant_id::text like ${FIXTURE}`;
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_settings where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from tenant_members where user_id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();

    await admin`
      insert into users (id, phone_e164) values
        (${SELLER}, '+8801722000001'), (${SAVER}, '+8801722000002'),
        (${ADMIN}, '+8801722000003'), (${MOD}, '+8801722000004')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Saved Partner', 'Saved Partner', '+8801722000099')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, name_bn, source_release, boundary, boundary_simplified)
      values
        (${AREA_A}, 3, 'upazila', 'saved-e2e-a', 'Saved A', 'সেভ এ', 'fixture', ${square(87.0, 87.1)}, ${square(87.0, 87.1)}),
        (${AREA_B}, 3, 'upazila', 'saved-e2e-b', 'Saved B', 'সেভ বি', 'fixture', ${square(87.1, 87.2)}, ${square(87.1, 87.2)})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values
        (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'saved-e2e-a', 'এ', 'A', st_point(87.05, 21.05)::geography, 'active'),
        (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'saved-e2e-b', 'বি', 'B', st_point(87.15, 21.05)::geography, 'active')`;
    await admin`
      insert into tenant_settings (tenant_id, post_moderation_mode_code)
      values (${TENANT_A}, 'post'), (${TENANT_B}, 'post')`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${M_SELLER}, ${TENANT_A}, ${SELLER}, 'member'), (${M_SAVER}, ${TENANT_A}, ${SAVER}, 'member'),
        (${M_ADMIN}, ${TENANT_A}, ${ADMIN}, 'tenant_admin'), (${M_MOD}, ${TENANT_A}, ${MOD}, 'moderator'),
        (${M_SELLER_B}, ${TENANT_B}, ${SELLER}, 'member')`;
    // Trusted seller: edits of a live post stay live (no re-review hold).
    await admin`
      insert into member_trust_scores (tenant_id, member_id, score, components, algorithm_version)
      values (${TENANT_A}, ${M_SELLER}, 90, '{}', 1)`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en, default_moderation_mode_code) values
        (${CATEGORY}, 'marketplace', 'saved-e2e-sale', 'বিক্রি', 'Sale', 'post'),
        (${PLACE_CATEGORY}, 'place', 'saved-e2e-place', 'জায়গা', 'Place', 'post')`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, ui_schema, status_code, published_at)
      values (${SCHEMA}, ${CATEGORY}, 1, ${admin.json({
        type: 'object',
        additionalProperties: false,
        properties: {
          price: {
            'x-field-type': 'money',
            type: 'string',
            'x-money-min': '1.00',
            'x-money-max': '10000000.00',
          },
        },
        required: ['price'],
      })}, ${admin.json({ order: ['price'], card: ['price'], labels: { price: { bn: 'দাম', en: 'Price' } } })},
      'published', now())`;
    await admin`
      insert into tenant_categories (tenant_id, category_id, is_enabled)
      values (${TENANT_A}, ${CATEGORY}, true), (${TENANT_B}, ${CATEGORY}, true)`;
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`
        insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code) values
          (${STORE}, ${TENANT_A}, ${M_SELLER}, 'saved-e2e-store', 'সেভ দোকান', 'active'),
          (${STORE_SUSPENDED}, ${TENANT_A}, ${M_SELLER}, 'saved-e2e-suspended', 'বন্ধ দোকান', 'suspended')`;
    });
    await admin`
      insert into places (id, tenant_id, category_id, slug, name_bn, status_code, location, source_code)
      values (${PLACE}, ${TENANT_A}, ${PLACE_CATEGORY}, 'saved-e2e-place', 'সেভ জায়গা', 'published',
              st_point(87.05, 21.05)::geography, 'agent_survey')`;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api', {
      exclude: [
        { path: 'health/live', method: RequestMethod.GET },
        { path: 'health/ready', method: RequestMethod.GET },
      ],
    });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    // As main.ts: the app's HTTP client sends a JSON content type on bodiless POSTs.
    allowEmptyJsonBody(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const signer = moduleRef.get(TokenService);
    for (const [name, userId, memberId, role] of [
      ['seller', SELLER, M_SELLER, 'member'],
      ['saver', SAVER, M_SAVER, 'member'],
      ['admin', ADMIN, M_ADMIN, 'tenant_admin'],
      ['mod', MOD, M_MOD, 'moderator'],
    ] as const) {
      tokens[name] = await signer.signAccessToken({ userId, tenantId: TENANT_A, memberId, role });
    }
  }, 60_000);

  afterEach(clearSaves);

  afterAll(async () => {
    await app.close();
    try {
      await cleanUp();
    } finally {
      await admin.end();
    }
  });

  const call = (
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
    url: string,
    as: As | 'anon',
    body?: unknown,
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        'x-tenant-id': TENANT_A,
        ...(as === 'anon' ? {} : { authorization: `Bearer ${tokens[as]}` }),
      },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });

  let n = 0x1000;
  const post = async (
    options: {
      tenant?: string;
      member?: string;
      at?: { lat: number; lng: number };
      status?: string;
    } = {},
  ): Promise<string> => {
    const id = `0191e3a0-5a0f-7000-8000-${(n++).toString(16).padStart(12, '0')}`;
    const at = options.at ?? IN_A;
    const status = options.status ?? 'live';
    const live = status === 'live' || status === 'expired';
    await admin`
      insert into posts
        (id, tenant_id, author_member_id, category_id, field_schema_id, title, fields, status_code,
         published_at, expires_at, location, geo_area_id)
      values
        (${id}, ${options.tenant ?? TENANT_A}, ${options.member ?? M_SELLER}, ${CATEGORY}, ${SCHEMA},
         ${`সেভের ফোন ${id.slice(-4)}`}, ${admin.json({ price: '8000.00' })}, ${status},
         ${live ? admin`now()` : null}, ${live ? admin`now() + interval '20 days'` : null},
         ${`SRID=4326;POINT(${at.lng} ${at.lat})`}, ${options.tenant === TENANT_B ? AREA_B : AREA_A})`;
    return id;
  };

  const list = async (query = '') =>
    (await call('GET', `/saved${query}`, 'saver')).json<{
      items: Saved[];
      nextCursor: string | null;
    }>();
  const savedCount = async (id: string) =>
    (await admin<{ saved_count: number }[]>`select saved_count from posts where id = ${id}`)[0]!
      .saved_count;

  describe('POST/DELETE /saved/:itemType/:itemId', () => {
    it('saves idempotently (201, then 200), unsaves idempotently (204), and keeps saved_count', async () => {
      const id = await post();
      const first = await call('POST', `/saved/post/${id}`, 'saver');
      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({ itemType: 'post', itemId: id, created: true });
      const again = await call('POST', `/saved/post/${id}`, 'saver');
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ created: false });
      expect(await savedCount(id)).toBe(1);
      expect(
        (await call('GET', `/posts/${id}/detail`, 'saver')).json<{ isSaved: boolean }>().isSaved,
      ).toBe(true);

      expect((await call('DELETE', `/saved/post/${id}`, 'saver')).statusCode).toBe(204);
      expect((await call('DELETE', `/saved/post/${id}`, 'saver')).statusCode).toBe(204);
      expect(await savedCount(id)).toBe(0);
      expect(
        (await call('GET', `/posts/${id}/detail`, 'saver')).json<{ isSaved: boolean }>().isSaved,
      ).toBe(false);
    });

    it('saves the way the phone app asks: a JSON content type with no body (found on a device)', async () => {
      const id = await post();
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/saved/post/${id}`,
        headers: {
          'x-tenant-id': TENANT_A,
          authorization: `Bearer ${tokens.saver}`,
          'content-type': 'application/json',
          'content-length': '0',
        },
      });
      expect(response.statusCode).toBe(201);
      expect(await savedCount(id)).toBe(1);
      // A body that is there but isn't JSON is still refused.
      const broken = await app.inject({
        method: 'POST',
        url: `/api/v1/saved/post/${id}`,
        headers: {
          'x-tenant-id': TENANT_A,
          authorization: `Bearer ${tokens.saver}`,
          'content-type': 'application/json',
        },
        payload: '{',
      });
      expect(broken.statusCode).toBe(400);
      expect((await call('DELETE', `/saved/post/${id}`, 'saver')).statusCode).toBe(204);
    });

    it('saves a post in another tenant, a place and a store: one list', async () => {
      const inB = await post({ tenant: TENANT_B, member: M_SELLER_B, at: IN_B });
      expect((await call('POST', `/saved/post/${inB}`, 'saver')).statusCode).toBe(201);
      expect((await call('POST', `/saved/place/${PLACE}`, 'saver')).statusCode).toBe(201);
      expect((await call('POST', `/saved/store/${STORE}`, 'saver')).statusCode).toBe(201);

      const all = await list();
      expect(all.items.map((i) => i.itemType)).toEqual(['store', 'place', 'post']);
      expect(all.items[2]).toMatchObject({ itemId: inB, state: 'available', price: '8000.00' });
      expect((await list('?type=place')).items.map((i) => i.itemId)).toEqual([PLACE]);

      const page1 = await list('?limit=2');
      expect(page1.items).toHaveLength(2);
      const page2 = await list(`?limit=2&cursor=${page1.nextCursor}`);
      expect(page2.items.map((i) => i.itemType)).toEqual(['post']);
      expect(page2.nextCursor).toBeNull();
    });

    it("refuses your own post or store, and what the public can't see", async () => {
      const own = await post({ member: M_SAVER });
      const ownSave = await call('POST', `/saved/post/${own}`, 'saver');
      expect(ownSave.statusCode).toBe(409);
      expect(ownSave.json<{ error: string }>().error).toBe('SAVE_OWN_ITEM');
      expect((await call('POST', `/saved/store/${STORE}`, 'seller')).statusCode).toBe(409);

      const draft = await post({ status: 'draft' });
      expect((await call('POST', `/saved/post/${draft}`, 'saver')).statusCode).toBe(404);
      expect((await call('POST', `/saved/store/${STORE_SUSPENDED}`, 'saver')).statusCode).toBe(404);
      expect(
        (await call('POST', `/saved/post/${own.replace(/.$/, 'f')}`, 'saver')).statusCode,
      ).toBe(404);
      expect((await call('POST', `/saved/banana/${own}`, 'saver')).statusCode).toBe(400);
      expect((await call('POST', `/saved/post/${own}`, 'anon')).statusCode).toBe(401);
    });
  });

  describe('isSaved on feed cards', () => {
    it("marks the viewer's saved posts after the shared page cache, never for someone else", async () => {
      const id = await post();
      await call('POST', `/saved/post/${id}`, 'saver');
      const card = async (as: As | 'anon') =>
        (await call('GET', `/feed?lat=${IN_A.lat}&lng=${IN_A.lng}&limit=50`, as))
          .json<{ items: { kind: string; id: string; isSaved?: boolean }[] }>()
          .items.find((item) => item.kind === 'post' && item.id === id);
      expect(await card('saver')).toMatchObject({ isSaved: true });
      // The same cached page, another viewer: not theirs.
      expect(await card('mod')).toMatchObject({ isSaved: false });
      expect(await card('anon')).toMatchObject({ isSaved: false });
    });
  });

  describe('GET /saved', () => {
    it('keeps sold, expired, deleted and removed posts, each with a clear state', async () => {
      const sold = await post();
      const expired = await post();
      const deleted = await post();
      const removed = await post();
      for (const id of [sold, expired, deleted, removed]) {
        expect((await call('POST', `/saved/post/${id}`, 'saver')).statusCode).toBe(201);
      }
      expect((await call('POST', `/posts/${sold}/sold`, 'seller', {})).statusCode).toBe(200);
      // What the expiry sweep does when the listing period ends.
      await admin`update posts set status_code = 'expired' where id = ${expired}`;
      expect((await call('DELETE', `/posts/${deleted}`, 'seller')).statusCode).toBe(204);
      expect(
        (await call('POST', `/moderation/${removed}/remove`, 'mod', { reasonCode: 'spam' }))
          .statusCode,
      ).toBe(200);

      const byId = new Map((await list()).items.map((i) => [i.itemId, i]));
      expect(byId.size).toBe(4);
      expect(byId.get(sold)).toMatchObject({ state: 'sold', price: '8000.00' });
      expect(byId.get(expired)).toMatchObject({ state: 'expired' });
      expect(byId.get(deleted)).toMatchObject({ state: 'deleted', price: null });
      expect(byId.get(deleted)!.name).not.toBeNull();
      expect(byId.get(removed)).toMatchObject({ state: 'removed', name: null, price: null });
    });
  });

  describe('POST/DELETE /stores/:id/follow', () => {
    it('follows and unfollows idempotently, with follower_count', async () => {
      const follow = await call('POST', `/stores/${STORE}/follow`, 'saver');
      expect(follow.statusCode).toBe(200);
      expect(follow.json()).toEqual({ storeId: STORE, following: true, followerCount: 1 });
      expect((await call('POST', `/stores/${STORE}/follow`, 'mod')).json()).toMatchObject({
        followerCount: 2,
      });
      expect((await call('POST', `/stores/${STORE}/follow`, 'saver')).json()).toMatchObject({
        followerCount: 2,
      });

      const unfollow = await call('DELETE', `/stores/${STORE}/follow`, 'saver');
      expect(unfollow.json()).toEqual({ storeId: STORE, following: false, followerCount: 1 });
      expect((await call('DELETE', `/stores/${STORE}/follow`, 'saver')).json()).toMatchObject({
        followerCount: 1,
      });
    });

    it('refuses your own store and a store that is not active', async () => {
      const own = await call('POST', `/stores/${STORE}/follow`, 'seller');
      expect(own.statusCode).toBe(409);
      expect(own.json<{ error: string }>().error).toBe('FOLLOW_OWN_STORE');
      expect((await call('POST', `/stores/${STORE_SUSPENDED}/follow`, 'saver')).statusCode).toBe(
        404,
      );
    });
  });

  describe('GET /tenant/analytics/store-activity', () => {
    it('averages posts per active store per month, for tenant admins only here', async () => {
      await admin`
        insert into posts (tenant_id, author_member_id, store_id, category_id, field_schema_id, title, fields,
                           status_code, published_at, location)
        select ${TENANT_A}, ${M_SELLER}, ${STORE}, ${CATEGORY}, ${SCHEMA}, 'দোকানের পোস্ট',
               ${admin.json({ price: '100.00' })}, 'live', now(), st_point(87.05, 21.05)::geography
        from generate_series(1, 4)`;
      const response = await call('GET', '/tenant/analytics/store-activity?months=2', 'admin');
      expect(response.statusCode).toBe(200);
      const { months } = response.json<{ months: Record<string, unknown>[] }>();
      expect(months).toHaveLength(2);
      expect(months[0]).toMatchObject({
        activeStores: 1,
        postingStores: 1,
        storePosts: 4,
        avgPostsPerActiveStore: '4.00',
      });
      expect((await call('GET', '/tenant/analytics/store-activity', 'saver')).statusCode).toBe(403);
      expect((await call('GET', '/tenant/analytics/store-activity', 'mod')).statusCode).toBe(403);
    });
  });

  describe('post.price_dropped', () => {
    const drops = (id: string) =>
      admin<{ payload: { from: string; to: string } }[]>`
        select payload from outbox_events where aggregate_id = ${id} and event_type = 'post.price_dropped'`;

    it('is emitted when a live post gets cheaper, never when it gets dearer or is not live', async () => {
      const id = await post();
      const cheaper = await call('PATCH', `/posts/${id}`, 'seller', {
        fields: { price: '7500.00' },
      });
      expect(cheaper.statusCode).toBe(200);
      expect((await drops(id)).map((e) => e.payload)).toEqual([
        expect.objectContaining({ tenantId: TENANT_A, from: '8000.00', to: '7500.00' }),
      ]);

      await call('PATCH', `/posts/${id}`, 'seller', { fields: { price: '9000.00' } });
      await call('PATCH', `/posts/${id}`, 'seller', { title: 'শুধু নাম বদল' });
      expect(await drops(id)).toHaveLength(1);

      const draft = await post({ status: 'draft' });
      await call('PATCH', `/posts/${draft}`, 'seller', { fields: { price: '10.00' } });
      expect(await drops(draft)).toHaveLength(0);
    });
  });
});
