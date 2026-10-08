import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Sql } from 'postgres';
import {
  ANALYTICS_COUNTER_STORE,
  type AnalyticsCounterStore,
} from '../src/analytics/seller/analytics-counter.store';
import { addDays, localDay } from '../src/analytics/seller/analytics-day';
import { AnalyticsRollupService } from '../src/analytics/seller/analytics-rollup.service';
import { AnalyticsTracker } from '../src/analytics/seller/analytics-tracker.service';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/tokens/token.service';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * Seller analytics end to end (ADR 055): real events through the API
 * (views, contacts, a save, a share link, a map tap, the store page) show up
 * live for today; the nightly rollup turns a finished day into
 * analytics_daily (contacts from lead_events, also lead_daily_stats); the
 * screen adds both, compares with the previous period, lists top posts and
 * the searches that led there; a scrubbed post is gone; only the owner and
 * managers see a store's numbers.
 */

const P = '0191e3a0-a0c9-7000-8000-';
const FIXTURE = `${P}%`;
const PARTNER = `${P}000000000001`;
const AREA_A = `${P}000000000011`;
const AREA_B = `${P}000000000012`;
const TENANT_A = `${P}000000000021`;
const TENANT_B = `${P}000000000022`;
const OWNER = `${P}000000000031`;
const MANAGER = `${P}000000000032`;
const EDITOR = `${P}000000000033`;
const BUYER_1 = `${P}000000000034`;
const BUYER_2 = `${P}000000000035`;
const M_OWNER = `${P}000000000041`;
const M_MANAGER = `${P}000000000042`;
const M_EDITOR = `${P}000000000043`;
const M_BUYER_1 = `${P}000000000044`;
const M_BUYER_2 = `${P}000000000045`;
const M_OWNER_B = `${P}000000000046`;
const STORE = `${P}000000000051`;
const CATEGORY = `${P}000000000061`;
const SCHEMA = `${P}000000000062`;
const POST_1 = `${P}000000000071`;
const POST_2 = `${P}000000000072`;
const POST_B = `${P}000000000073`;
const SHARE_CODE = 'anlx7k2q';

const square = (west: number, east: number) =>
  `SRID=4326;MULTIPOLYGON(((${west} 24.5,${east} 24.5,${east} 24.6,${west} 24.6,${west} 24.5)))`;
const point = (lng: number) => `SRID=4326;POINT(${lng} 24.55)`;

type Role = 'owner' | 'manager' | 'editor' | 'buyer1' | 'buyer2';

interface Metrics {
  views: number;
  uniqueViewers: number;
  contacts: { total: number; call: number; whatsapp: number; sms: number; chat: number };
  uniqueContacters: number;
  saves: number;
  shares: number;
  searchAppearances: number;
  mapTaps: number;
  conversionRate: number;
}
interface Analytics {
  scope: string;
  period: { days: number; from: string; to: string; available: number[] };
  summary: { bn: string; en: string };
  totals: Metrics;
  previous: Metrics;
  trend: Record<string, number | null>;
  daily: { date: string; views: number; contacts: number }[];
  topPosts: { postId: string; metrics: Metrics }[];
  topQueries: { query: string; searchers: number; clicks: number }[];
}

describe('Seller analytics (e2e)', () => {
  let app: NestFastifyApplication;
  let moduleRef: TestingModule;
  let admin: Sql;
  let tracker: AnalyticsTracker;
  let counters: AnalyticsCounterStore;
  const tokens = {} as Record<Role, string>;
  const today = localDay(new Date());
  const yesterday = addDays(today, -1);

  const call = (
    method: 'GET' | 'POST',
    url: string,
    options: { as?: Role; installId?: string; body?: unknown; tenant?: string } = {},
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        'x-tenant-id': options.tenant ?? TENANT_A,
        ...(options.as ? { authorization: `Bearer ${tokens[options.as]}` } : {}),
        ...(options.installId ? { 'x-install-id': options.installId } : {}),
      },
      ...(options.body === undefined ? {} : { payload: options.body as Record<string, unknown> }),
    });
  const analytics = async (url: string, as: Role = 'owner') => {
    await tracker.settle();
    const response = await call('GET', url, { as });
    expect(response.statusCode).toBe(200);
    return response.json<Analytics>();
  };

  async function cleanUp(): Promise<void> {
    const tenants = [TENANT_A, TENANT_B];
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from analytics_daily where tenant_id in ${tx(tenants)}`;
      await tx`delete from lead_daily_stats where tenant_id in ${tx(tenants)}`;
      await tx`delete from lead_events where tenant_id in ${tx(tenants)}`;
      await tx`delete from search_queries where tenant_id in ${tx(tenants)}`;
      await tx`delete from saved_posts where tenant_id in ${tx(tenants)}`;
      await tx`delete from post_short_links where tenant_id in ${tx(tenants)}`;
      await tx`delete from moderation_actions where tenant_id in ${tx(tenants)}`;
      await tx`delete from posts where tenant_id in ${tx(tenants)}`;
      await tx`delete from store_members where tenant_id in ${tx(tenants)}`;
      await tx`delete from stores where tenant_id in ${tx(tenants)}`;
      await tx`delete from tenant_categories where tenant_id in ${tx(tenants)}`;
      await tx`delete from tenant_members where tenant_id in ${tx(tenants)}`;
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
    await admin`
      insert into users (id, phone_e164) values
        (${OWNER}, '+8801799400001'), (${MANAGER}, '+8801799400002'), (${EDITOR}, '+8801799400003'),
        (${BUYER_1}, '+8801799400004'), (${BUYER_2}, '+8801799400005')`;
    await admin`insert into partners (id, legal_name, display_name, phone_e164)
                values (${PARTNER}, 'Analytics E2E', 'Analytics E2E', '+8801799400099')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release, boundary, boundary_simplified)
      values (${AREA_A}, 3, 'upazila', 'analytics-e2e-a', 'Analytics A', 'fixture', ${square(89.5, 89.6)}, ${square(89.5, 89.6)}),
             (${AREA_B}, 3, 'upazila', 'analytics-e2e-b', 'Analytics B', 'fixture', ${square(89.7, 89.8)}, ${square(89.7, 89.8)})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code, timezone)
      values (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'analytics-e2e-a', 'এ', 'A', ${point(89.55)}, 'active', 'Asia/Dhaka'),
             (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'analytics-e2e-b', 'বি', 'B', ${point(89.75)}, 'active', 'Asia/Dhaka')`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${M_OWNER}, ${TENANT_A}, ${OWNER}, 'member'), (${M_MANAGER}, ${TENANT_A}, ${MANAGER}, 'member'),
        (${M_EDITOR}, ${TENANT_A}, ${EDITOR}, 'member'), (${M_BUYER_1}, ${TENANT_A}, ${BUYER_1}, 'member'),
        (${M_BUYER_2}, ${TENANT_A}, ${BUYER_2}, 'member'), (${M_OWNER_B}, ${TENANT_B}, ${OWNER}, 'member')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en, default_moderation_mode_code, default_post_expiry_days)
      values (${CATEGORY}, 'marketplace', 'analytics-e2e-sale', 'বিক্রি', 'Sale', 'post', 30)`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, status_code, published_at)
      values (${SCHEMA}, ${CATEGORY}, 1, '{}'::jsonb, 'published', now())`;
    await admin`insert into tenant_categories (tenant_id, category_id, is_enabled)
                values (${TENANT_A}, ${CATEGORY}, true), (${TENANT_B}, ${CATEGORY}, true)`;
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`
        insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code, location)
        values (${STORE}, ${TENANT_A}, ${M_OWNER}, 'analytics-e2e-store', 'হিসাবের দোকান', 'active', ${point(89.55)})`;
      await tx`
        insert into store_members (tenant_id, store_id, member_id, role_code, accepted_at) values
          (${TENANT_A}, ${STORE}, ${M_MANAGER}, 'manager', now()),
          (${TENANT_A}, ${STORE}, ${M_EDITOR}, 'editor', now())`;
      for (const [id, tenant, member, store, title, lng] of [
        [POST_1, TENANT_A, M_OWNER, STORE, 'স্যামসাং মোবাইল', 89.551],
        [POST_2, TENANT_A, M_OWNER, STORE, 'পুরনো ফ্রিজ', 89.552],
        [POST_B, TENANT_B, M_OWNER_B, null, 'ভ্যান গাড়ি', 89.751],
      ] as const) {
        await tx`
          insert into posts (id, tenant_id, author_member_id, store_id, category_id, field_schema_id, title,
                             status_code, published_at, bumped_at, location, price_type_code, show_phone,
                             show_whatsapp, contact_phone_e164)
          values (${id}, ${tenant}, ${member}, ${store}, ${CATEGORY}, ${SCHEMA}, ${title}, 'live',
                  now() - interval '1 day', now() - interval '1 day', ${point(lng)}, 'fixed', true, true,
                  '+8801799400010')`;
      }
      await tx`insert into post_short_links (tenant_id, post_id, code) values (${TENANT_A}, ${POST_1}, ${SHARE_CODE})`;
    });

    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
    tracker = moduleRef.get(AnalyticsTracker);
    counters = moduleRef.get(ANALYTICS_COUNTER_STORE);
    const signer = moduleRef.get(TokenService);
    for (const [role, userId, memberId] of [
      ['owner', OWNER, M_OWNER],
      ['manager', MANAGER, M_MANAGER],
      ['editor', EDITOR, M_EDITOR],
      ['buyer1', BUYER_1, M_BUYER_1],
      ['buyer2', BUYER_2, M_BUYER_2],
    ] as const) {
      tokens[role] = await signer.signAccessToken({
        userId,
        tenantId: TENANT_A,
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

  it("today, live: views (deduped, never the seller's own), contacts by channel, a save, a share, a map tap", async () => {
    for (const installId of [
      'anl-install-0001',
      'anl-install-0002',
      'anl-install-0003',
      'anl-install-0001',
    ]) {
      expect((await call('POST', `/posts/${POST_1}/view`, { installId })).statusCode).toBe(204);
    }
    expect((await call('POST', `/posts/${POST_1}/view`, { as: 'owner' })).statusCode).toBe(204);
    expect(
      (await call('POST', `/posts/${POST_1}/contact`, { as: 'buyer1', body: { channel: 'call' } }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await call('POST', `/posts/${POST_1}/contact`, {
          as: 'buyer2',
          body: { channel: 'whatsapp' },
        })
      ).statusCode,
    ).toBe(200);
    expect((await call('POST', `/saved/post/${POST_1}`, { as: 'buyer1' })).statusCode).toBeLessThan(
      300,
    );
    expect((await call('GET', `/s/${SHARE_CODE}`)).statusCode).toBe(200);
    expect((await call('GET', `/map/features/posts/${POST_1}?tenant=${TENANT_A}`)).statusCode).toBe(
      200,
    );

    const mine = await analytics('/posts/me/analytics?period=7d');
    expect(mine.scope).toBe('posts');
    expect(mine.totals).toMatchObject({
      views: 3,
      uniqueViewers: 3,
      contacts: { total: 2, call: 1, whatsapp: 1, sms: 0, chat: 0 },
      uniqueContacters: 2,
      saves: 1,
      shares: 1,
      mapTaps: 1,
      conversionRate: 0.6667,
    });
    expect(mine.summary.bn).toBe('গত ৭ দিনে ৩ জন আপনার পোস্ট দেখেছেন, ২ জন যোগাযোগ করেছেন।');
    expect(mine.daily.at(-1)).toEqual({ date: today, views: 3, contacts: 2 });
    expect(mine.topPosts[0]).toMatchObject({
      postId: POST_1,
      metrics: { views: 3, uniqueViewers: 3 },
    });
  });

  it("the store's numbers add its page to its posts", async () => {
    expect(
      (await call('GET', '/stores/analytics-e2e-store', { installId: 'anl-install-0009' }))
        .statusCode,
    ).toBe(200);
    expect(
      (await call('GET', '/stores/analytics-e2e-store', { installId: 'anl-install-0009' }))
        .statusCode,
    ).toBe(200);
    const store = await analytics(`/stores/${STORE}/analytics?period=30d`);
    expect(store.scope).toBe('store');
    expect(store.totals).toMatchObject({ views: 4, uniqueViewers: 4, contacts: { total: 2 } });
    expect(store.summary.bn).toBe('গত ৩০ দিনে ৪ জন আপনার দোকান দেখেছেন, ২ জন যোগাযোগ করেছেন।');
  });

  it("only the store's owner and managers see its numbers; the period must be one of the settings'", async () => {
    expect((await call('GET', `/stores/${STORE}/analytics`, { as: 'manager' })).statusCode).toBe(
      200,
    );
    const editor = await call('GET', `/stores/${STORE}/analytics`, { as: 'editor' });
    expect(editor.statusCode).toBe(403);
    expect(editor.json<{ error: string }>().error).toBe('ANALYTICS_FORBIDDEN');
    expect((await call('GET', `/stores/${STORE}/analytics`, { as: 'buyer1' })).statusCode).toBe(
      403,
    );
    expect((await call('GET', `/stores/${STORE}/analytics`)).statusCode).toBe(401);
    const bad = await call('GET', '/posts/me/analytics?period=10d', { as: 'owner' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json<{ details: { available: number[] } }>().details.available).toEqual([7, 30, 90]);
    const fallback = await analytics('/posts/me/analytics');
    expect(fallback.period.days).toBe(7);
  });

  it('the nightly rollup turns a finished day into history (contacts from lead_events), and the screen adds it', async () => {
    // Yesterday: 10 views in Redis, two calls on record.
    const ttls = { counters: 3600, uniques: 3600 };
    await counters.increment(
      yesterday,
      { tenantId: TENANT_A, type: 'post', id: POST_1 },
      'views',
      10,
      ttls,
    );
    await admin`
      insert into lead_events (tenant_id, channel_code, source_code, post_id, store_id, target_member_id, anon_session_hash, occurred_at)
      values (${TENANT_A}, 'call_click', 'post_detail', ${POST_1}, ${STORE}, ${M_OWNER}, 'anl-a', (${yesterday}::date + time '12:00') at time zone 'Asia/Dhaka'),
             (${TENANT_A}, 'call_click', 'post_detail', ${POST_1}, ${STORE}, ${M_OWNER}, 'anl-b', (${yesterday}::date + time '13:00') at time zone 'Asia/Dhaka')`;

    const rollup = moduleRef.get(AnalyticsRollupService);
    const first = await rollup.rollup({ batchSize: 100, maxBatches: 1000 });
    const again = await rollup.rollup({ batchSize: 100, maxBatches: 1000 });
    expect(again.rows).toBe(first.rows); // idempotent: the same rows, the same numbers
    const [row] = await admin<{ metrics: Record<string, number> }[]>`
      select metrics from analytics_daily
      where entity_type = 'post' and entity_id = ${POST_1} and stat_date = ${yesterday}::date`;
    expect(row!.metrics).toMatchObject({ views: 10, contacts_call: 2, unique_contacters: 2 });
    const [leads] = await admin<{ event_count: number }[]>`
      select event_count from lead_daily_stats
      where post_id = ${POST_1} and stat_date = ${yesterday}::date and channel_code = 'call_click'`;
    expect(leads!.event_count).toBe(2);

    // A day in the previous 7-day period, for the trend.
    await admin`
      insert into analytics_daily (tenant_id, entity_type, entity_id, stat_date, metrics)
      values (${TENANT_A}, 'post', ${POST_1}, ${addDays(today, -10)}::date, '{"views": 5, "contacts_call": 1}'::jsonb)`;

    const mine = await analytics('/posts/me/analytics?period=7d');
    expect(mine.totals.views).toBe(13);
    expect(mine.totals.contacts.call).toBe(3);
    expect(mine.previous.views).toBe(5);
    expect(mine.trend.views).toBe(160);
    expect(mine.daily.find((d) => d.date === yesterday)).toEqual({
      date: yesterday,
      views: 10,
      contacts: 2,
    });
  });

  it('lists the searches that led here, only those enough different people made', async () => {
    await admin`
      insert into search_queries (tenant_id, searcher_hash, q_normalized, filters_hash, result_count, clicked_post_id)
      values (${TENANT_A}, ${'a'.repeat(64)}, 'samsung mobile', '0000000000000000', 3, ${POST_1}),
             (${TENANT_A}, ${'b'.repeat(64)}, 'samsung mobile', '0000000000000000', 3, ${POST_1}),
             (${TENANT_A}, ${'c'.repeat(64)}, 'rahim er number', '0000000000000000', 1, ${POST_1})`;
    const mine = await analytics('/posts/me/analytics?period=7d');
    expect(mine.topQueries).toEqual([{ query: 'samsung mobile', searchers: 2, clicks: 2 }]);
  });

  it("my posts span every area; a store's only its own", async () => {
    await admin`
      insert into analytics_daily (tenant_id, entity_type, entity_id, stat_date, metrics)
      values (${TENANT_B}, 'post', ${POST_B}, ${yesterday}::date, '{"views": 100}'::jsonb)`;
    const mine = await analytics('/posts/me/analytics?period=7d');
    expect(mine.topPosts[0]).toMatchObject({ postId: POST_B, metrics: { views: 100 } });
    const store = await analytics(`/stores/${STORE}/analytics?period=7d`);
    expect(store.topPosts.map((p) => p.postId)).not.toContain(POST_B);
  });

  it('a scrubbed post is excluded everywhere', async () => {
    await admin`
      insert into analytics_daily (tenant_id, entity_type, entity_id, stat_date, metrics)
      values (${TENANT_A}, 'post', ${POST_2}, ${yesterday}::date, '{"views": 7}'::jsonb)`;
    const before = await analytics(`/stores/${STORE}/analytics?period=7d`);
    expect(before.topPosts.map((p) => p.postId)).toContain(POST_2);

    await admin.begin(async (tx) => {
      // The real privacy scrub (0027), as a moderator's hard removal runs it.
      await tx`select set_config('app.role', 'system', true)`;
      await tx`select set_config('app.tenant_id', ${TENANT_A}, true)`;
      await tx`
        insert into moderation_actions (tenant_id, post_id, actor_user_id, action_code, reason_code, reason_text, evidence_refs)
        values (${TENANT_A}, ${POST_2}, ${MANAGER}, 'moderator_removed', 'doxxing', 'fixture', '["e1"]')`;
      await tx`select public.scrub_post(${POST_2}::uuid, 'doxxing', 'moderator_removed')`;
    });
    const [flag] = await admin<{ subject_scrubbed: boolean }[]>`
      select subject_scrubbed from analytics_daily where entity_id = ${POST_2}`;
    expect(flag!.subject_scrubbed).toBe(true);
    const after = await analytics(`/stores/${STORE}/analytics?period=7d`);
    expect(after.topPosts.map((p) => p.postId)).not.toContain(POST_2);
    expect(after.totals.views).toBe(before.totals.views - 7);
  });
});
