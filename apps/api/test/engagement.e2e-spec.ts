import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/tokens/token.service';
import { EngagementWorkerModule } from '../src/engagement/engagement-worker.module';
import { PostViewsFlushService } from '../src/engagement/post-views-flush.service';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * Post detail, contact tracking, views, share links and reports end to end
 * (ADR 036) on real Postgres + Redis.
 *
 * Tenant A (default settings) and tenant B next to it
 * (require_login_for_contact on); contact reveals capped at 3 a day. SELLER posts in A; BUYER_1..3
 * are members of A; MOD moderates A. The seller's number is +8801744000001
 * and must never appear in a detail response, in any spelling.
 */

const FIXTURE = '0191e3a0-e6e0-7000-8000-%';
const PARTNER = '0191e3a0-e6e0-7000-8000-000000000001';
const AREA_A = '0191e3a0-e6e0-7000-8000-000000000011';
const AREA_B = '0191e3a0-e6e0-7000-8000-000000000012';
const TENANT_A = '0191e3a0-e6e0-7000-8000-000000000021';
const TENANT_B = '0191e3a0-e6e0-7000-8000-000000000022';
const SELLER = '0191e3a0-e6e0-7000-8000-000000000031';
const BUYER_1 = '0191e3a0-e6e0-7000-8000-000000000032';
const BUYER_2 = '0191e3a0-e6e0-7000-8000-000000000033';
const BUYER_3 = '0191e3a0-e6e0-7000-8000-000000000034';
const MOD = '0191e3a0-e6e0-7000-8000-000000000035';
const M_SELLER = '0191e3a0-e6e0-7000-8000-000000000041';
const M_BUYER_1 = '0191e3a0-e6e0-7000-8000-000000000042';
const M_BUYER_2 = '0191e3a0-e6e0-7000-8000-000000000043';
const M_BUYER_3 = '0191e3a0-e6e0-7000-8000-000000000044';
const M_MOD = '0191e3a0-e6e0-7000-8000-000000000045';
const M_SELLER_B = '0191e3a0-e6e0-7000-8000-000000000046';
const CATEGORY = '0191e3a0-e6e0-7000-8000-000000000051';
const SCHEMA_V1 = '0191e3a0-e6e0-7000-8000-000000000061';
const SCHEMA_V2 = '0191e3a0-e6e0-7000-8000-000000000062';
const MEDIA = '0191e3a0-e6e0-7000-8000-000000000071';

const SELLER_PHONE = '+8801744000001';
/** Every way the number could leak: E.164, local, digits only, Bengali digits. */
const PHONE_SPELLINGS = [
  '+8801744000001',
  '8801744000001',
  '01744000001',
  '1744000001',
  '০১৭৪৪০০০০০১',
];
// Its own patch of map, far from every other suite's tenants.
const square = (west: number, east: number) =>
  `SRID=4326;MULTIPOLYGON(((${west} 21.4,${east} 21.4,${east} 21.5,${west} 21.5,${west} 21.4)))`;
const IN_A = { lat: 21.45, lng: 92.05 };
const IN_B = { lat: 21.45, lng: 92.15 };

type As = 'seller' | 'buyer1' | 'buyer2' | 'buyer3' | 'mod' | 'anon';

interface Detail {
  id: string;
  status: string;
  fields: { key: string; label: { bn: string | null }; value: unknown; optionLabels?: unknown[] }[];
  media: { variants: { thumb: { url: string; width: number }; full: { url: string } } | null }[];
  seller: { name: string | null; badges: string[]; memberSince: string | null };
  contact: { name: string | null; channels: string[]; loginRequired: boolean };
  share: { code: string; url: string } | null;
  similar: { id: string }[];
  distanceMeters: number | null;
  stats?: { views: number; contacts: { call: number; total: number }; saves: number };
  isMine: boolean;
}

describe('Post engagement (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: Sql;
  let redis: Redis;
  let flush: PostViewsFlushService;
  const tokens: Partial<Record<As, string>> = {};

  async function clearRedis(): Promise<void> {
    const keys = await redis.keys('eng:*');
    if (keys.length > 0) await redis.del(...keys);
  }

  async function cleanUp(): Promise<void> {
    await admin`delete from notifications where user_id::text like ${FIXTURE}`;
    await admin.begin(async (tx) => {
      // moderation_actions is append-only (trigger); teardown bypasses it.
      await tx`set local session_replication_role = replica`;
      await tx`delete from moderation_actions where tenant_id::text like ${FIXTURE}`;
    });
    await admin`delete from moderation_queue_items where tenant_id::text like ${FIXTURE}`;
    await admin`delete from member_trust_scores where tenant_id::text like ${FIXTURE}`;
    await admin`delete from reports where tenant_id::text like ${FIXTURE}`;
    await admin`delete from lead_events where tenant_id::text like ${FIXTURE}`;
    await admin`delete from post_short_links where tenant_id::text like ${FIXTURE}`;
    await admin`delete from outbox_events where aggregate_table = 'posts' and aggregate_id::text like ${FIXTURE}`;
    await admin`delete from media_attachments where tenant_id::text like ${FIXTURE}`;
    await admin`delete from media_assets where tenant_id::text like ${FIXTURE}`;
    await admin`delete from posts where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_categories where tenant_id::text like ${FIXTURE}`;
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_settings where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from tenant_members where user_id::text like ${FIXTURE}`;
    await admin`delete from user_profiles where user_id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    redis = new Redis(process.env.REDIS_URL!);
    await cleanUp();
    await clearRedis();

    await admin`
      insert into users (id, phone_e164, phone_verified_at) values
        (${SELLER}, ${SELLER_PHONE}, now()), (${BUYER_1}, '+8801744000002', now()),
        (${BUYER_2}, '+8801744000003', now()), (${BUYER_3}, '+8801744000004', now()),
        (${MOD}, '+8801744000005', now())`;
    await admin`insert into user_profiles (user_id, display_name) values (${SELLER}, 'রহিম মিয়া')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Engagement Partner', 'Engagement Partner', '+8801744000099')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, name_bn, source_release, boundary, boundary_simplified)
      values
        (${AREA_A}, 3, 'upazila', 'engagement-a', 'Engagement A', 'এনগেজমেন্ট এ', 'fixture', ${square(92.0, 92.1)}, ${square(92.0, 92.1)}),
        (${AREA_B}, 3, 'upazila', 'engagement-b', 'Engagement B', 'এনগেজমেন্ট বি', 'fixture', ${square(92.1, 92.2)}, ${square(92.1, 92.2)})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values
        (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'engagement-a', 'এ', 'A', st_point(92.05, 21.45)::geography, 'active'),
        (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'engagement-b', 'বি', 'B', st_point(92.15, 21.45)::geography, 'active')`;
    await admin.begin(async (tx) => {
      // Platform-scope overrides need platform staff (0003 trigger). Set before
      // the app starts: SettingsService caches what it reads.
      await tx`select set_config('app.role', 'platform_admin', true)`;
      await tx`
        insert into tenant_settings (tenant_id, post_moderation_mode_code, setting_overrides) values
          (${TENANT_A}, 'post', '{}'),
          (${TENANT_B}, 'post', ${tx.json({ require_login_for_contact: true })})`;
    });
    // A platform-wide limit (one viewer, every tenant): lowered for this
    // suite only (no other suite reveals contacts), restored in afterAll.
    await admin`update platform_settings set value = '3' where key = 'contact_reveals_per_user_per_day'`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${M_SELLER}, ${TENANT_A}, ${SELLER}, 'member'), (${M_BUYER_1}, ${TENANT_A}, ${BUYER_1}, 'member'),
        (${M_BUYER_2}, ${TENANT_A}, ${BUYER_2}, 'member'), (${M_BUYER_3}, ${TENANT_A}, ${BUYER_3}, 'member'),
        (${M_MOD}, ${TENANT_A}, ${MOD}, 'moderator'), (${M_SELLER_B}, ${TENANT_B}, ${SELLER}, 'member')`;
    await admin`
      insert into member_trust_scores (tenant_id, member_id, score, components, algorithm_version)
      values (${TENANT_A}, ${M_SELLER}, 75, '{}', 1)`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en, default_moderation_mode_code)
      values (${CATEGORY}, 'marketplace', 'engagement-phones', 'মোবাইল', 'Phones', 'post')`;
    // v1 (the posts') calls it "অবস্থা" with option "পুরনো"; v2 renamed both.
    const jsonSchema = admin.json({
      type: 'object',
      additionalProperties: false,
      properties: {
        condition: { 'x-field-type': 'select', type: 'string', enum: ['used', 'new'] },
      },
      required: [],
    });
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, ui_schema, status_code, published_at)
      values
        (${SCHEMA_V1}, ${CATEGORY}, 1, ${jsonSchema}, ${admin.json({
          order: ['condition'],
          card: ['condition'],
          labels: { condition: { bn: 'অবস্থা', en: 'Condition' } },
          options: {
            condition: { used: { bn: 'পুরনো', en: 'Used' }, new: { bn: 'নতুন', en: 'New' } },
          },
        })}, 'retired', now() - interval '1 day'),
        (${SCHEMA_V2}, ${CATEGORY}, 2, ${jsonSchema}, ${admin.json({
          order: ['condition'],
          card: ['condition'],
          labels: { condition: { bn: 'কন্ডিশন', en: 'Condition (v2)' } },
          options: {
            condition: { used: { bn: 'ব্যবহৃত', en: 'Used' }, new: { bn: 'নতুন', en: 'New' } },
          },
        })}, 'published', now())`;
    await admin`
      insert into tenant_categories (tenant_id, category_id, is_enabled)
      values (${TENANT_A}, ${CATEGORY}, true), (${TENANT_B}, ${CATEGORY}, true)`;

    const moduleRef = await Test.createTestingModule({
      // The flush service alone: no BullMQ worker, which would compete with
      // other suites' workers for jobs on the shared posts queue.
      imports: [AppModule, EngagementWorkerModule],
    }).compile();
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
    flush = moduleRef.get(PostViewsFlushService);

    const signer = moduleRef.get(TokenService);
    for (const [name, userId, memberId, role] of [
      ['seller', SELLER, M_SELLER, 'member'],
      ['buyer1', BUYER_1, M_BUYER_1, 'member'],
      ['buyer2', BUYER_2, M_BUYER_2, 'member'],
      ['buyer3', BUYER_3, M_BUYER_3, 'member'],
      ['mod', MOD, M_MOD, 'moderator'],
    ] as const) {
      tokens[name] = await signer.signAccessToken({ userId, tenantId: TENANT_A, memberId, role });
    }
  }, 60_000);

  afterAll(async () => {
    await app.close();
    try {
      await cleanUp();
      await clearRedis();
      await admin`update platform_settings set value = '30' where key = 'contact_reveals_per_user_per_day'`;
    } finally {
      await admin.end();
      redis.disconnect();
    }
  });

  const call = (
    method: 'GET' | 'POST',
    url: string,
    as: As,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        'x-tenant-id': TENANT_A,
        ...(as === 'anon' ? {} : { authorization: `Bearer ${tokens[as]}` }),
        ...headers,
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
      showPhone?: boolean;
      showWhatsapp?: boolean;
    } = {},
  ): Promise<string> => {
    const id = `0191e3a0-e6e0-7000-8000-${(n++).toString(16).padStart(12, '0')}`;
    const at = options.at ?? IN_A;
    const status = options.status ?? 'live';
    await admin`
      insert into posts
        (id, tenant_id, author_member_id, category_id, field_schema_id, title, fields, status_code,
         published_at, bumped_at, expires_at, location, geo_area_id, contact_name, contact_phone_e164,
         show_phone, show_whatsapp)
      values
        (${id}, ${options.tenant ?? TENANT_A}, ${options.member ?? M_SELLER}, ${CATEGORY}, ${SCHEMA_V1},
         'স্যামসাং ফোন', ${admin.json({ condition: 'used' })}, ${status},
         ${status === 'live' ? admin`now()` : null}, ${status === 'live' ? admin`now()` : null},
         ${status === 'live' ? admin`now() + interval '20 days'` : null},
         ${`SRID=4326;POINT(${at.lng} ${at.lat})`}, ${options.tenant === TENANT_B ? AREA_B : AREA_A},
         'রহিম', ${SELLER_PHONE}, ${options.showPhone ?? true}, ${options.showWhatsapp ?? false})`;
    return id;
  };

  const leads = (postId: string) =>
    admin<
      {
        tenant_id: string;
        channel_code: string;
        source_code: string;
        store_id: string | null;
        target_member_id: string | null;
        actor_member_id: string | null;
        anon_session_hash: string | null;
      }[]
    >`select tenant_id, channel_code, source_code, store_id, target_member_id, actor_member_id, anon_session_hash
      from lead_events where post_id = ${postId} order by occurred_at, id`;

  describe('GET /posts/:id/detail', () => {
    it('never contains the phone number, for anyone, in any spelling', async () => {
      const id = await post({ showWhatsapp: true });
      for (const as of ['anon', 'buyer1', 'seller', 'mod'] as const) {
        const response = await call('GET', `/posts/${id}/detail`, as);
        expect(response.statusCode).toBe(200);
        for (const spelling of PHONE_SPELLINGS) expect(response.body).not.toContain(spelling);
      }
    });

    it("gives the whole post: its own schema version's labels, every photo variant, the seller, the channels, a share link", async () => {
      const id = await post({ showWhatsapp: true });
      await admin`
        insert into media_assets
          (id, tenant_id, uploaded_by_user_id, kind_code, visibility_code, storage_key, mime_type, byte_size,
           checksum_sha256, status_code, thumbhash, variants)
        values (${MEDIA}, ${TENANT_A}, ${SELLER}, 'image', 'public', 'engagement/original', 'image/webp', 100,
                ${'e'.repeat(64)}, 'ready', 'thumbhash==', ${admin.json({
                  thumb: { key: 'engagement/thumb.webp', width: 200, height: 150, bytes: 10 },
                  card: { key: 'engagement/card.webp', width: 600, height: 450, bytes: 20 },
                  full: { key: 'engagement/full.webp', width: 1200, height: 900, bytes: 30 },
                })})`;
      await admin`insert into media_attachments (tenant_id, media_asset_id, post_id) values (${TENANT_A}, ${MEDIA}, ${id})`;

      const detail = (
        await call('GET', `/posts/${id}/detail?lat=21.45&lng=92.06`, 'buyer1')
      ).json<Detail>();
      expect(detail.fields).toEqual([
        {
          key: 'condition',
          type: 'select',
          label: { bn: 'অবস্থা', en: 'Condition' },
          value: 'used',
          optionLabels: [{ bn: 'পুরনো', en: 'Used' }],
        },
      ]);
      expect(detail.media).toHaveLength(1);
      expect(detail.media[0]!.variants!.thumb).toMatchObject({ width: 200 });
      expect(detail.media[0]!.variants!.full.url).toMatch(/engagement\/full\.webp$/);
      expect(detail.seller).toMatchObject({
        name: 'রহিম মিয়া',
        badges: ['trusted', 'phone_verified'],
      });
      expect(detail.seller.memberSince).not.toBeNull();
      expect(detail.contact).toEqual({
        name: 'রহিম',
        channels: ['call', 'whatsapp', 'sms'],
        allowChat: true,
        loginRequired: false,
      });
      expect(detail.share!.url).toBe(`https://engagement-a.amarelaka.test/s/${detail.share!.code}`);
      // ~1 km east of the post at this latitude.
      expect(detail.distanceMeters).toBeGreaterThan(900);
      expect(detail.distanceMeters).toBeLessThan(1_100);
      expect(detail.isMine).toBe(false);
      expect(detail.stats).toBeUndefined();
    });

    it('lists similar posts nearby, across the tenant boundary, never the post itself', async () => {
      // Near A's eastern edge (lng 92.10): B's post is ~1 km away, well inside the 5 km radius.
      const id = await post({ at: { lat: 21.45, lng: 92.095 } });
      const nearby = await post({ at: { lat: 21.451, lng: 92.093 } });
      const acrossBoundary = await post({
        tenant: TENANT_B,
        member: M_SELLER_B,
        at: { lat: 21.45, lng: 92.105 },
      });
      const draft = await post({ status: 'draft' });
      const similar = (await call('GET', `/posts/${id}/detail`, 'anon'))
        .json<Detail>()
        .similar.map((s) => s.id);
      expect(similar).toEqual(expect.arrayContaining([nearby, acrossBoundary]));
      expect(similar).not.toContain(id);
      expect(similar).not.toContain(draft);
    });

    it('shows the seller-facing counters to the owner and staff only', async () => {
      const id = await post();
      await admin`update posts set view_count = 4 where id = ${id}`;
      expect((await call('GET', `/posts/${id}/detail`, 'seller')).json<Detail>()).toMatchObject({
        isMine: true,
        stats: { views: 4, contacts: { call: 0, total: 0 }, saves: 0 },
      });
      expect((await call('GET', `/posts/${id}/detail`, 'mod')).json<Detail>().stats).toBeDefined();
      expect(
        (await call('GET', `/posts/${id}/detail`, 'buyer1')).json<Detail>().stats,
      ).toBeUndefined();
    });

    it("is a 404 for a post the caller can't see", async () => {
      const draft = await post({ status: 'draft' });
      expect((await call('GET', `/posts/${draft}/detail`, 'buyer1')).statusCode).toBe(404);
      expect((await call('GET', `/posts/${draft}/detail`, 'seller')).statusCode).toBe(200);
    });

    it('GET /posts/:id no longer hands buyers the number either', async () => {
      const id = await post({ showWhatsapp: true });
      const view = (await call('GET', `/posts/${id}`, 'anon')).json<{ contact: unknown }>();
      expect(view.contact).toEqual({ name: 'রহিম', phone: null, whatsapp: true });
      const own = (await call('GET', `/posts/${id}`, 'seller')).json<{
        contact: { phone: string };
      }>();
      expect(own.contact.phone).toBe(SELLER_PHONE);
    });
  });

  describe('POST /posts/:id/contact', () => {
    beforeEach(clearRedis);

    it('reveals the number with a prefilled Bengali message, and writes the lead', async () => {
      const id = await post({ showWhatsapp: true });
      const response = await call('POST', `/posts/${id}/contact`, 'buyer1', {
        channel: 'whatsapp',
      });
      expect(response.statusCode).toBe(200);
      const reveal = response.json<{ phone: string; href: string; message: string }>();
      expect(reveal.phone).toBe(SELLER_PHONE);
      expect(reveal.message).toContain('আমার এলাকা');
      expect(reveal.message).toContain('স্যামসাং ফোন');
      expect(reveal.message).toMatch(/https:\/\/engagement-a\.amarelaka\.test\/s\/[a-z0-9]+$/);
      expect(reveal.href.startsWith('https://wa.me/8801744000001?text=')).toBe(true);

      const [lead] = await leads(id);
      expect(lead).toMatchObject({
        tenant_id: TENANT_A,
        channel_code: 'whatsapp_click',
        source_code: 'post_detail',
        target_member_id: M_SELLER,
        actor_member_id: M_BUYER_1,
      });
      expect(lead!.anon_session_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('counts a double tap once; another channel is another lead', async () => {
      const id = await post();
      await call('POST', `/posts/${id}/contact`, 'buyer1', { channel: 'call' });
      const again = await call('POST', `/posts/${id}/contact`, 'buyer1', { channel: 'call' });
      expect(again.statusCode).toBe(200);
      await call('POST', `/posts/${id}/contact`, 'buyer1', { channel: 'sms' });
      expect((await leads(id)).map((l) => l.channel_code)).toEqual(['call_click', 'sms_click']);
    });

    it('lets a guest reveal (the default), recorded without a member', async () => {
      const id = await post();
      const response = await call(
        'POST',
        `/posts/${id}/contact`,
        'anon',
        { channel: 'call' },
        {
          'x-install-id': 'guest-install-0001',
        },
      );
      expect(response.statusCode).toBe(200);
      expect(response.json<{ href: string }>().href).toBe(`tel:${SELLER_PHONE}`);
      expect((await leads(id))[0]).toMatchObject({ actor_member_id: null });
    });

    it('asks a guest to sign in where the tenant requires it', async () => {
      const id = await post({ tenant: TENANT_B, member: M_SELLER_B, at: IN_B });
      const guest = await call('POST', `/posts/${id}/contact`, 'anon', { channel: 'call' });
      expect(guest.statusCode).toBe(401);
      expect(guest.json<{ error: string }>().error).toBe('CONTACT_LOGIN_REQUIRED');
      expect(await leads(id)).toHaveLength(0);
      expect(
        (await call('GET', `/posts/${id}/detail`, 'anon')).json<Detail>().contact.loginRequired,
      ).toBe(true);
      expect(
        (await call('POST', `/posts/${id}/contact`, 'buyer1', { channel: 'call' })).statusCode,
      ).toBe(200);
    });

    it('refuses a channel the seller turned off, and the seller themselves', async () => {
      const id = await post({ showWhatsapp: false });
      const whatsapp = await call('POST', `/posts/${id}/contact`, 'buyer1', {
        channel: 'whatsapp',
      });
      expect(whatsapp.statusCode).toBe(409);
      expect(whatsapp.json<{ error: string }>().error).toBe('CONTACT_CHANNEL_UNAVAILABLE');
      const hidden = await post({ showPhone: false });
      expect(
        (await call('POST', `/posts/${hidden}/contact`, 'buyer1', { channel: 'call' })).statusCode,
      ).toBe(409);
      const own = await call('POST', `/posts/${id}/contact`, 'seller', { channel: 'call' });
      expect(own.json<{ error: string }>().error).toBe('CONTACT_OWN_POST');
      expect(await leads(id)).toHaveLength(0);
    });

    it('caps new reveals per viewer per day (repeat taps are free)', async () => {
      const posts = [await post(), await post(), await post(), await post()];
      for (const id of posts.slice(0, 3)) {
        expect(
          (await call('POST', `/posts/${id}/contact`, 'buyer2', { channel: 'call' })).statusCode,
        ).toBe(200);
      }
      // A repeat of an earlier reveal doesn't use the allowance.
      expect(
        (await call('POST', `/posts/${posts[0]}/contact`, 'buyer2', { channel: 'call' }))
          .statusCode,
      ).toBe(200);
      const fourth = await call('POST', `/posts/${posts[3]}/contact`, 'buyer2', {
        channel: 'call',
      });
      expect(fourth.statusCode).toBe(429);
      expect(fourth.json<{ error: string }>().error).toBe('CONTACT_LIMIT_REACHED');
      expect(await leads(posts[3]!)).toHaveLength(0);
    });
  });

  describe('POST /posts/:id/view', () => {
    beforeEach(clearRedis);

    const views = async (id: string) =>
      (await admin<{ view_count: number }[]>`select view_count from posts where id = ${id}`)[0]!
        .view_count;

    it('counts one view per viewer per window, only after the batched flush', async () => {
      const id = await post();
      const view = (as: As, installId?: string) =>
        call(
          'POST',
          `/posts/${id}/view`,
          as,
          undefined,
          installId ? { 'x-install-id': installId } : {},
        );

      expect((await view('anon', 'device-aaaa-0001')).statusCode).toBe(204);
      await view('anon', 'device-aaaa-0001');
      await view('buyer1');
      await view('buyer1', 'device-bbbb-0002'); // still buyer1
      await view('seller'); // the owner's own views never count
      expect(await views(id)).toBe(0); // nothing synchronous

      await flush.flush({ batchSize: 100, maxBatches: 10 });
      expect(await views(id)).toBe(2);

      await view('anon', 'device-cccc-0003');
      await flush.flush({ batchSize: 100, maxBatches: 10 });
      expect(await views(id)).toBe(3);
    });

    it('is a 404 for a post the public cannot see', async () => {
      const draft = await post({ status: 'draft' });
      expect((await call('POST', `/posts/${draft}/view`, 'anon')).statusCode).toBe(404);
    });
  });

  describe('POST /posts/:id/report', () => {
    beforeEach(clearRedis);

    it('auto-hides at the threshold, queues it for moderators, and approval restores it as it was', async () => {
      const id = await post();
      const [before] = await admin<
        { expires_at: Date }[]
      >`select expires_at from posts where id = ${id}`;

      const first = await call('POST', `/posts/${id}/report`, 'buyer1', {
        reasonCode: 'scam',
        text: 'টাকা আগে চায়',
      });
      expect(first.statusCode).toBe(201);
      const filed = first.json<{ reportId: string; created: boolean }>();
      expect(filed.created).toBe(true);
      expect(filed.reportId).toMatch(/^[0-9a-f-]{36}$/);
      // The same buyer again: the open report, nothing new.
      expect(
        (await call('POST', `/posts/${id}/report`, 'buyer1', { reasonCode: 'spam' })).json(),
      ).toMatchObject({
        created: false,
      });
      await call('POST', `/posts/${id}/report`, 'buyer2', { reasonCode: 'fake_listing' });
      expect((await call('GET', `/posts/${id}/detail`, 'anon')).statusCode).toBe(200);

      await call('POST', `/posts/${id}/report`, 'buyer3', { reasonCode: 'scam' });
      expect((await call('GET', `/posts/${id}/detail`, 'anon')).statusCode).toBe(404);
      expect((await call('GET', `/posts/${id}/detail`, 'seller')).json<Detail>().status).toBe(
        'pending',
      );

      const queue = (await call('GET', '/moderation/queue?limit=100', 'mod')).json<{
        items: { postId: string; source: string; reasons: string[] }[];
      }>();
      expect(queue.items.find((i) => i.postId === id)).toMatchObject({
        source: 'report',
        reasons: ['reported'],
      });

      expect((await call('POST', `/moderation/${id}/approve`, 'mod')).statusCode).toBe(200);
      const [after] = await admin<{ status_code: string; expires_at: Date }[]>`
        select status_code, expires_at from posts where id = ${id}`;
      expect(after).toEqual({ status_code: 'live', expires_at: before!.expires_at });
      const reports =
        await admin`select status_code, resolution_code from reports where post_id = ${id}`;
      expect(reports).toHaveLength(3);
      expect(new Set(reports.map((r) => `${r.status_code}/${r.resolution_code}`))).toEqual(
        new Set(['dismissed/no_action']),
      );
    });

    it('needs a signed-in member and refuses the author', async () => {
      const id = await post();
      expect(
        (await call('POST', `/posts/${id}/report`, 'anon', { reasonCode: 'scam' })).statusCode,
      ).toBe(401);
      const own = await call('POST', `/posts/${id}/report`, 'seller', { reasonCode: 'scam' });
      expect(own.statusCode).toBe(409);
      expect(own.json<{ error: string }>().error).toBe('REPORT_OWN_POST');
      expect(
        (await call('POST', `/posts/${id}/report`, 'buyer1', { reasonCode: 'nonsense' }))
          .statusCode,
      ).toBe(400);
    });
  });

  describe('GET /s/:code', () => {
    it('resolves a share link to its post and URL', async () => {
      const id = await post();
      const { share } = (await call('GET', `/posts/${id}/detail`, 'anon')).json<Detail>();
      const resolved = await call('GET', `/s/${share!.code}`, 'anon');
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json()).toEqual({
        code: share!.code,
        postId: id,
        tenantId: TENANT_A,
        tenantSlug: 'engagement-a',
        url: share!.url,
      });
      // The same code every time.
      expect((await call('GET', `/posts/${id}/detail`, 'buyer1')).json<Detail>().share!.code).toBe(
        share!.code,
      );
      expect((await call('GET', '/s/nosuchcode', 'anon')).statusCode).toBe(404);
    });
  });
});
