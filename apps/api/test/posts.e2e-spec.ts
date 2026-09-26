import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/tokens/token.service';
import { PostExpiryService } from '../src/posts/post-expiry.service';
import { PostsWorkerModule } from '../src/posts/posts-worker.module';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * /api/v1/posts end to end on real Postgres + PostGIS + Redis.
 *
 * Two square upazilas at latitude 24.05 with an 8.1 km gap (as in
 * cross-tenant-discovery.db-spec.ts), buffer 5 km:
 *
 *   A (post-moderated): lng 90.00–90.10     B (pre-moderated): lng 90.18–90.28
 *
 * The owner, another member and a moderator are all members of A and call
 * through A (X-Tenant-Id).
 */

const FIXTURE = '0191e3a0-7057-7000-8000-%';
const PARTNER = '0191e3a0-7057-7000-8000-000000000001';
const AREA_A = '0191e3a0-7057-7000-8000-000000000011';
const AREA_B = '0191e3a0-7057-7000-8000-000000000012';
const TENANT_A = '0191e3a0-7057-7000-8000-000000000021';
const TENANT_B = '0191e3a0-7057-7000-8000-000000000022';
const OWNER = '0191e3a0-7057-7000-8000-000000000031';
const OTHER = '0191e3a0-7057-7000-8000-000000000032';
const MOD = '0191e3a0-7057-7000-8000-000000000033';
const OWNER_MEMBER = '0191e3a0-7057-7000-8000-000000000041';
const OTHER_MEMBER = '0191e3a0-7057-7000-8000-000000000042';
const MOD_MEMBER = '0191e3a0-7057-7000-8000-000000000043';
const CATEGORY = '0191e3a0-7057-7000-8000-000000000051';
const SCHEMA = '0191e3a0-7057-7000-8000-000000000061';
const MEDIA_READY = '0191e3a0-7057-7000-8000-000000000071';
const MEDIA_READY_2 = '0191e3a0-7057-7000-8000-000000000072';
const MEDIA_PROCESSING = '0191e3a0-7057-7000-8000-000000000073';
const MEDIA_OTHERS = '0191e3a0-7057-7000-8000-000000000074';

const INSIDE_A = { lat: 24.05, lng: 90.05 };
const BUFFER_NEAR_B = { lat: 24.05, lng: 90.145 }; // 4.6 km from A, 3.6 km from B
const BEYOND = { lat: 24.05, lng: 91.0 };

const square = (west: number, east: number) =>
  `SRID=4326;MULTIPOLYGON(((${west} 24,${east} 24,${east} 24.1,${west} 24.1,${west} 24)))`;

interface Post {
  id: string;
  tenantId: string;
  status: string;
  outsideBoundary: boolean;
  ownershipResolution: string;
  expiresAt: string | null;
  publishedAt: string | null;
  isSold: boolean;
  soldPrice: string | null;
  hiddenByOwner?: boolean;
  isMine: boolean;
  media: { id: string }[];
  geoAreaId: string | null;
  fieldSchemaVersion: number | null;
}

describe('Posts (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: Sql;
  let expiry: PostExpiryService;
  const tokens: Record<string, string> = {};

  async function cleanUp(): Promise<void> {
    await admin`delete from outbox_events where aggregate_table = 'posts' and payload->>'tenantId' like ${FIXTURE}`;
    await admin`delete from media_attachments where tenant_id::text like ${FIXTURE}`;
    await admin`delete from posts where tenant_id::text like ${FIXTURE}`;
    await admin`delete from media_assets where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_categories where tenant_id::text like ${FIXTURE}`;
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_settings where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    // Implicit memberships can land outside the fixture tenants; drop them too.
    await admin`delete from tenant_members where user_id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  // This suite is about posts, not moderation (moderation.e2e-spec.ts): a
  // clean submission in a post-moderated tenant should go live. Per-tenant
  // overrides, so e2e suites running in parallel never see them.
  const OVERRIDES = { trust_auto_approve_threshold: 0, moderation_sample_rate_percent: 0 };
  // It also creates far more posts than one person may in a day. Those limits
  // count across every tenant, so only platform_settings can raise them; a
  // higher cap can't break a suite running alongside. Set before the app (and
  // its settings cache) starts; restored after.
  const LIMITS = { post_max_per_day_per_user: 200, post_max_active_per_user: 200 };
  let savedLimits: { key: string; value: unknown }[] = [];

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();
    savedLimits = await admin<{ key: string; value: unknown }[]>`
      select key, value from platform_settings where key in ${admin(Object.keys(LIMITS))}`;
    for (const [key, value] of Object.entries(LIMITS)) {
      await admin`update platform_settings set value = to_jsonb(${value}::int) where key = ${key}`;
    }

    await admin`
      insert into users (id, phone_e164) values
        (${OWNER}, '+8801766000001'), (${OTHER}, '+8801766000002'), (${MOD}, '+8801766000003')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Posts E2E Partner', 'Posts E2E Partner', '+8801766000099')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release, boundary, boundary_simplified)
      values
        (${AREA_A}, 3, 'upazila', 'posts-e2e-a', 'Posts E2E A', 'fixture', ${square(90.0, 90.1)}, ${square(90.0, 90.1)}),
        (${AREA_B}, 3, 'upazila', 'posts-e2e-b', 'Posts E2E B', 'fixture', ${square(90.18, 90.28)}, ${square(90.18, 90.28)})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values
        (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'posts-e2e-a', 'এ', 'A', st_point(90.05, 24.05)::geography, 'active'),
        (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'posts-e2e-b', 'বি', 'B', st_point(90.23, 24.05)::geography, 'active')`;
    await admin.begin(async (tx) => {
      // These keys are platform-scope overrides (0003 trigger): platform staff only.
      await tx`select set_config('app.role', 'platform_admin', true)`;
      await tx`
        insert into tenant_settings (tenant_id, post_moderation_mode_code, setting_overrides)
        values (${TENANT_A}, 'post', ${tx.json(OVERRIDES)}), (${TENANT_B}, 'pre', ${tx.json(OVERRIDES)})`;
    });
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${OWNER_MEMBER}, ${TENANT_A}, ${OWNER}, 'member'),
        (${OTHER_MEMBER}, ${TENANT_A}, ${OTHER}, 'member'),
        (${MOD_MEMBER}, ${TENANT_A}, ${MOD}, 'moderator')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en, default_moderation_mode_code, default_post_expiry_days)
      values (${CATEGORY}, 'marketplace', 'posts-e2e-to-let', 'টু-লেট', 'To-Let', 'post', 30)`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, ui_schema, status_code, published_at)
      values (${SCHEMA}, ${CATEGORY}, 1, ${admin.json({
        type: 'object',
        additionalProperties: false,
        properties: {
          price: {
            'x-field-type': 'money',
            type: 'string',
            'x-money-min': '100.00',
            'x-money-max': '10000000.00',
          },
        },
        required: ['price'],
      })}, ${admin.json({
        order: ['price'],
        labels: { price: { bn: 'ভাড়া', en: 'Rent' } },
      })}, 'published', now())`;
    await admin`
      insert into tenant_categories (tenant_id, category_id, is_enabled)
      values (${TENANT_A}, ${CATEGORY}, true), (${TENANT_B}, ${CATEGORY}, true)`;
    const asset = (id: string, userId: string, status: string) => admin`
      insert into media_assets
        (id, tenant_id, uploaded_by_user_id, kind_code, visibility_code, storage_key, mime_type, byte_size, checksum_sha256, status_code)
      values (${id}, ${TENANT_A}, ${userId}, 'image', 'public', ${`posts-e2e/${id}`}, 'image/webp', 100, ${`chk-${id}`}, ${status})`;
    await asset(MEDIA_READY, OWNER, 'ready');
    await asset(MEDIA_READY_2, OWNER, 'ready');
    await asset(MEDIA_PROCESSING, OWNER, 'processing');
    await asset(MEDIA_OTHERS, OTHER, 'ready');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, PostsWorkerModule],
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
    expiry = moduleRef.get(PostExpiryService);

    const signer = moduleRef.get(TokenService);
    for (const [name, userId, memberId, role] of [
      ['owner', OWNER, OWNER_MEMBER, 'member'],
      ['other', OTHER, OTHER_MEMBER, 'member'],
      ['mod', MOD, MOD_MEMBER, 'moderator'],
    ] as const) {
      tokens[name] = await signer.signAccessToken({ userId, tenantId: TENANT_A, memberId, role });
    }
  });

  afterAll(async () => {
    await app.close();
    try {
      for (const { key, value } of savedLimits) {
        await admin`update platform_settings set value = ${admin.json(value as never)} where key = ${key}`;
      }
      await cleanUp();
    } finally {
      await admin.end();
    }
  });

  type As = 'owner' | 'other' | 'mod' | 'anon';
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    as: As,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url: `/api/v1/posts${url}`,
      headers: {
        'x-tenant-id': TENANT_A,
        ...(as === 'anon' ? {} : { authorization: `Bearer ${tokens[as]}` }),
        ...headers,
      },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });

  // A fresh title each time: the duplicate pre-filter holds a repeat of the
  // author's own post (same title + photos) from the last 24 hours.
  let titleCounter = 0;
  const draftBody = (overrides: Record<string, unknown> = {}) => ({
    categoryId: CATEGORY,
    title: `মিরপুরে ২ রুমের ফ্ল্যাট ভাড়া ${++titleCounter}`,
    description: 'Gas, lift, near the main road.',
    fields: { price: '15000.00' },
    location: INSIDE_A,
    ...overrides,
  });

  const create = async (
    overrides: Record<string, unknown> = {},
    as: As = 'owner',
  ): Promise<Post> => {
    const response = await call('POST', '', as, draftBody(overrides));
    expect(response.statusCode).toBe(201);
    return response.json<Post>();
  };
  const liveInA = async (): Promise<Post> => create({ submit: true });
  const setStatus = (id: string, status: string, extra = '') =>
    admin.unsafe(`update posts set status_code = '${status}'${extra} where id = '${id}'`);
  const events = async (id: string) =>
    (
      await admin<{ event_type: string }[]>`
        select event_type from outbox_events
        where aggregate_id = ${id} and event_type like 'post.%' order by id`
    ).map((row) => row.event_type);

  describe('create', () => {
    it('keeps a draft, pinned to the current field schema, in the tenant the point falls in', async () => {
      const post = await create();
      expect(post).toMatchObject({
        status: 'draft',
        tenantId: TENANT_A,
        outsideBoundary: false,
        ownershipResolution: 'inside_boundary',
        geoAreaId: AREA_A,
        fieldSchemaVersion: 1,
        isMine: true,
        expiresAt: null,
      });
      expect(await events(post.id)).toEqual(['post.created']);
    });

    it('goes live straight away when submitted in a post-moderated tenant, with the category expiry', async () => {
      const post = await liveInA();
      expect(post.status).toBe('live');
      const days = (Date.parse(post.expiresAt!) - Date.parse(post.publishedAt!)) / 86_400_000;
      expect(days).toBeCloseTo(30, 5);
      expect(await events(post.id)).toEqual(['post.created', 'post.submitted', 'post.live']);
    });

    it('rejects fields that fail the category schema, and writes nothing', async () => {
      const response = await call('POST', '', 'owner', draftBody({ fields: { price: 'free' } }));
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: 'FIELD_VALIDATION_FAILED' });
    });

    it('rejects a title longer than post_title_max_length', async () => {
      const response = await call('POST', '', 'owner', draftBody({ title: 'ক'.repeat(121) }));
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: 'POST_TEXT_TOO_LONG' });
    });
  });

  describe('tenant assignment (boundary + buffer)', () => {
    it('inside a boundary → that tenant', async () => {
      const ownership = await call(
        'GET',
        `/ownership?lat=${INSIDE_A.lat}&lng=${INSIDE_A.lng}`,
        'owner',
      );
      expect(ownership.json()).toEqual({
        tenantId: TENANT_A,
        resolution: 'inside_boundary',
        outsideBoundary: false,
        needsReview: false,
      });
    });

    it('within a neighbour’s buffer → the nearest tenant, outside_boundary, its moderation mode', async () => {
      const post = await create({ location: BUFFER_NEAR_B, submit: true });
      expect(post).toMatchObject({
        tenantId: TENANT_B,
        outsideBoundary: true,
        ownershipResolution: 'within_buffer',
        status: 'pending', // B is pre-moderated
      });
      const [membership] = await admin`
        select 1 from tenant_members where tenant_id = ${TENANT_B} and user_id = ${OWNER}`;
      expect(membership).toBeDefined(); // implicit membership in the owning tenant
    });

    it('beyond every buffer → the poster’s tenant, flagged for moderation even in a post-moderated tenant', async () => {
      const post = await create({ location: BEYOND, submit: true });
      expect(post).toMatchObject({
        tenantId: TENANT_A,
        outsideBoundary: true,
        ownershipResolution: 'beyond_buffer_fallback',
        status: 'pending',
      });
    });
  });

  describe('idempotent create', () => {
    it('returns the same post for the same key and body, and refuses the key for another body', async () => {
      const key = `tap-${Date.now()}`;
      const body = draftBody();
      const first = await call('POST', '', 'owner', body, { 'idempotency-key': key });
      const again = await call('POST', '', 'owner', body, { 'idempotency-key': key });
      expect(first.statusCode).toBe(201);
      expect(again.statusCode).toBe(200);
      expect(again.json<Post>().id).toBe(first.json<Post>().id);

      const different = await call('POST', '', 'owner', draftBody({ title: 'অন্য পোস্ট' }), {
        'idempotency-key': key,
      });
      expect(different.statusCode).toBe(422);
      expect(different.json()).toMatchObject({ error: 'IDEMPOTENCY_KEY_REUSED' });

      const [count] = await admin<{ n: number }[]>`
        select count(*)::int as n from posts where title = ${body.title}`;
      expect(count!.n).toBe(1);
    });
  });

  describe('media', () => {
    it('attaches the caller’s own ready photos, in order', async () => {
      const post = await create({ mediaIds: [MEDIA_READY_2, MEDIA_READY] });
      expect(post.media.map((m) => m.id)).toEqual([MEDIA_READY_2, MEDIA_READY]);
    });

    it('refuses photos that are still processing, someone else’s, or already used', async () => {
      for (const mediaId of [MEDIA_PROCESSING, MEDIA_OTHERS, MEDIA_READY]) {
        const response = await call('POST', '', 'owner', draftBody({ mediaIds: [mediaId] }));
        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({ error: 'POST_MEDIA_INVALID' });
      }
    });

    it('explains when photos were uploaded for another area than the one the post lands in', async () => {
      await admin`delete from media_attachments where media_asset_id = ${MEDIA_READY_2}`;
      const response = await call(
        'POST',
        '',
        'owner',
        draftBody({ location: BUFFER_NEAR_B, mediaIds: [MEDIA_READY_2] }),
      );
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: 'POST_MEDIA_TENANT_MISMATCH',
        details: { owningTenantId: TENANT_B },
      });
    });
  });

  describe('transitions over HTTP', () => {
    it('draft → pending (→ live, post-moderated) via submit; submitting again is illegal', async () => {
      const post = await create();
      const submitted = await call('POST', `/${post.id}/submit`, 'owner');
      expect(submitted.json<Post>().status).toBe('live');
      const again = await call('POST', `/${post.id}/submit`, 'owner');
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({
        error: 'POST_ILLEGAL_TRANSITION',
        details: { from: 'live', to: 'pending' },
      });
    });

    it('rejected → pending and removed → pending wait for a human, even in a post-moderated tenant', async () => {
      for (const status of ['rejected', 'removed']) {
        const post = await create({ submit: true });
        await setStatus(post.id, status);
        const response = await call('POST', `/${post.id}/submit`, 'owner');
        expect(response.statusCode).toBe(200);
        expect(response.json<Post>().status).toBe('pending');
      }
    });

    it('live → sold with an optional price; sold is final', async () => {
      const post = await liveInA();
      const sold = await call('POST', `/${post.id}/sold`, 'owner', { soldPrice: '14000.00' });
      expect(sold.json<Post>()).toMatchObject({
        status: 'sold',
        isSold: true,
        soldPrice: '14000.00',
      });
      for (const action of ['/sold', '/submit', '/repost']) {
        const response = await call(
          'POST',
          `/${post.id}${action}`,
          'owner',
          action === '/sold' ? {} : undefined,
        );
        expect(response.statusCode).toBe(409);
      }
      expect(await events(post.id)).toContain('post.sold');
    });

    it('draft → sold and live → repost are illegal', async () => {
      const draft = await create();
      expect((await call('POST', `/${draft.id}/sold`, 'owner', {})).statusCode).toBe(409);
      const live = await liveInA();
      expect((await call('POST', `/${live.id}/repost`, 'owner')).statusCode).toBe(409);
    });

    it('live → expired by the sweep, then expired → live by repost with a fresh expiry', async () => {
      const post = await liveInA();
      await admin`update posts set expires_at = now() - interval '1 minute' where id = ${post.id}`;
      expect(await expiry.expireDue()).toBeGreaterThanOrEqual(1);
      const expired = await call('GET', `/${post.id}`, 'owner');
      expect(expired.json<Post>().status).toBe('expired');

      const reposted = await call('POST', `/${post.id}/repost`, 'owner');
      expect(reposted.json<Post>().status).toBe('live');
      expect(Date.parse(reposted.json<Post>().expiresAt!)).toBeGreaterThan(Date.now());
      expect(await events(post.id)).toEqual(
        expect.arrayContaining(['post.expired', 'post.reposted']),
      );
    });

    it('only the author may change a post', async () => {
      const post = await liveInA();
      const response = await call('PATCH', `/${post.id}`, 'other', { title: 'hijacked' });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: 'POST_NOT_OWNER' });
    });
  });

  describe('edit and re-review', () => {
    it('a title edit keeps a live post live in a post-moderated tenant, flagged for re-review', async () => {
      const post = await liveInA();
      const edited = await call('PATCH', `/${post.id}`, 'owner', { title: 'নতুন শিরোনাম' });
      expect(edited.json<Post>().status).toBe('live');
      const [event] = await admin<{ payload: { rereview: boolean; changed: string[] } }[]>`
        select payload from outbox_events where aggregate_id = ${post.id} and event_type = 'post.edited'`;
      expect(event!.payload).toMatchObject({ rereview: true, changed: ['title'] });
    });

    it('sends a live post back to moderation in a pre-moderated tenant', async () => {
      const post = await create({ location: BUFFER_NEAR_B, submit: true });
      await setStatus(
        post.id,
        'live',
        ", published_at = now(), expires_at = now() + interval '30 days'",
      );
      const edited = await call('PATCH', `/${post.id}`, 'owner', { fields: { price: '20000.00' } });
      expect(edited.json<Post>().status).toBe('pending');
    });

    it('does not re-review a change outside post_rereview_fields', async () => {
      const post = await create({ location: BUFFER_NEAR_B, submit: true });
      await setStatus(
        post.id,
        'live',
        ", published_at = now(), expires_at = now() + interval '30 days'",
      );
      const edited = await call('PATCH', `/${post.id}`, 'owner', { allowChat: false });
      expect(edited.json<Post>().status).toBe('live');
    });
  });

  describe('visibility per role', () => {
    it('draft: owner and moderator only', async () => {
      const post = await create();
      expect((await call('GET', `/${post.id}`, 'owner')).statusCode).toBe(200);
      expect((await call('GET', `/${post.id}`, 'mod')).statusCode).toBe(200);
      expect((await call('GET', `/${post.id}`, 'other')).statusCode).toBe(404);
      expect((await call('GET', `/${post.id}`, 'anon')).statusCode).toBe(404);
    });

    it('live: public; hidden: owner and moderator only, and reversible', async () => {
      const post = await liveInA();
      expect((await call('GET', `/${post.id}`, 'anon')).statusCode).toBe(200);
      expect((await call('POST', `/${post.id}/hide`, 'owner')).json<Post>().hiddenByOwner).toBe(
        true,
      );
      expect((await call('GET', `/${post.id}`, 'anon')).statusCode).toBe(404);
      expect((await call('GET', `/${post.id}`, 'other')).statusCode).toBe(404);
      expect((await call('GET', `/${post.id}`, 'mod')).statusCode).toBe(200);
      await call('POST', `/${post.id}/unhide`, 'owner');
      expect((await call('GET', `/${post.id}`, 'anon')).statusCode).toBe(200);
    });

    it('sold: public, marked sold', async () => {
      const post = await liveInA();
      await call('POST', `/${post.id}/sold`, 'owner', {});
      const response = await call('GET', `/${post.id}`, 'anon');
      expect(response.statusCode).toBe(200);
      expect(response.json<Post>()).toMatchObject({ isSold: true, isMine: false });
      expect(response.json<Post>().hiddenByOwner).toBeUndefined(); // owner-only field
    });

    it('a neighbour tenant’s live post is readable from here (radius discovery), its pending one is not', async () => {
      const post = await create({ location: BUFFER_NEAR_B, submit: true });
      expect((await call('GET', `/${post.id}`, 'other')).statusCode).toBe(404);
      await setStatus(
        post.id,
        'live',
        ", published_at = now(), expires_at = now() + interval '30 days'",
      );
      const response = await call('GET', `/${post.id}`, 'other');
      expect(response.statusCode).toBe(200);
      expect(response.json<Post>().tenantId).toBe(TENANT_B);
    });

    it('scrubbed: the scrubbed shape only', async () => {
      const post = await liveInA();
      await admin`
        update posts set scrubbed_at = now(), scrub_reason = 'privacy', location = null, geo_area_id = null
        where id = ${post.id}`;
      const response = await call('GET', `/${post.id}`, 'anon');
      const { scrubbedAt, ...shape } = response.json<Record<string, unknown>>();
      expect(typeof scrubbedAt).toBe('string');
      // Nothing else: no title, fields, location, media or author.
      expect(shape).toEqual({
        id: post.id,
        tenantId: TENANT_A,
        status: 'live',
        scrubbed: true,
        isSold: false,
      });
    });
  });

  describe('delete', () => {
    it('soft-deletes with user_deleted, keeps the status, and hides it from everyone but owner and staff', async () => {
      const post = await liveInA();
      expect((await call('DELETE', `/${post.id}`, 'owner')).statusCode).toBe(204);
      const [row] = await admin<{ status_code: string; deletion_reason_code: string }[]>`
        select status_code, deletion_reason_code from posts where id = ${post.id}`;
      expect(row).toEqual({ status_code: 'live', deletion_reason_code: 'user_deleted' });
      expect((await call('GET', `/${post.id}`, 'anon')).statusCode).toBe(404);
      expect((await call('GET', `/${post.id}`, 'owner')).statusCode).toBe(200);
      expect((await call('POST', `/${post.id}/hide`, 'owner')).statusCode).toBe(404);
    });

    it('keeps a sold post as sales history instead', async () => {
      const post = await liveInA();
      await call('POST', `/${post.id}/sold`, 'owner', {});
      const response = await call('DELETE', `/${post.id}`, 'owner');
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: 'POST_NOT_EDITABLE' });
    });
  });

  describe('GET /me', () => {
    it('lists the owner’s posts across tenants, hidden ones included, filterable and paged', async () => {
      const hidden = await liveInA();
      await call('POST', `/${hidden.id}/hide`, 'owner');

      const all = await call('GET', '/me?limit=50', 'owner');
      const items = all.json<{ items: Post[] }>().items;
      expect(items.map((p) => p.id)).toContain(hidden.id);
      expect(items.some((p) => p.tenantId === TENANT_B)).toBe(true);
      expect(items.every((p) => p.isMine)).toBe(true);

      const drafts = await call('GET', '/me?status=draft', 'owner');
      expect(drafts.json<{ items: Post[] }>().items.every((p) => p.status === 'draft')).toBe(true);

      const page = await call('GET', '/me?limit=2', 'owner');
      const { nextCursor } = page.json<{ nextCursor: string | null }>();
      expect(nextCursor).not.toBeNull();
      const next = await call('GET', `/me?limit=2&cursor=${nextCursor}`, 'owner');
      expect(next.json<{ items: Post[] }>().items[0]!.id < nextCursor!).toBe(true);
    });

    it('needs a signed-in user', async () => {
      expect((await call('GET', '/me', 'anon')).statusCode).toBe(401);
    });
  });
});
