import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/tokens/token.service';
import { ReviewPromptsService } from '../src/reviews/review-prompts.service';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';
import { startNotificationWorker, type NotificationWorker } from './support/notification-worker';

/**
 * Reviews end to end (ADR 061) over HTTP on real Postgres + Redis. The
 * store lives in tenant B; the buyers are members of tenant A (radius
 * discovery: they shop across the boundary). The whole path: no contact →
 * refused; the buyer calls the store (a lead, recorded by user although
 * they have no membership in B yet) → too soon → in the window → review
 * (published, membership in B created) → listed with the summary and the
 * seller tier → edited → the store replies → the owner can't delete it,
 * reports it → the moderator hides it (reports closed) → gone from the list.
 * After the window: refused. "How was it?": queued once, delivered in-app
 * with a link to the review form.
 */

const P = '0191e3a0-7e2e-7000-8000-';
const FIXTURE = `${P}%`;
const PARTNER = `${P}000000000001`;
const AREA_A = `${P}000000000011`;
const AREA_B = `${P}000000000012`;
const TENANT_A = `${P}000000000021`;
const TENANT_B = `${P}000000000022`;
const STORE = `${P}000000000071`;

type Who = 'buyer' | 'buyer2' | 'late' | 'owner' | 'mod';
const PEOPLE: Record<
  Who,
  { user: string; member: string; tenant: string; role: string; phone: string }
> = {
  buyer: {
    user: `${P}000000000031`,
    member: `${P}000000000041`,
    tenant: TENANT_A,
    role: 'member',
    phone: '+8801866000001',
  },
  buyer2: {
    user: `${P}000000000032`,
    member: `${P}000000000042`,
    tenant: TENANT_A,
    role: 'member',
    phone: '+8801867000002',
  },
  late: {
    user: `${P}000000000033`,
    member: `${P}000000000043`,
    tenant: TENANT_A,
    role: 'member',
    phone: '+8801868000003',
  },
  owner: {
    user: `${P}000000000034`,
    member: `${P}000000000044`,
    tenant: TENANT_B,
    role: 'member',
    phone: '+8801869000004',
  },
  mod: {
    user: `${P}000000000035`,
    member: `${P}000000000045`,
    tenant: TENANT_B,
    role: 'moderator',
    phone: '+8801860000005',
  },
};

jest.setTimeout(30_000);

describe('Reviews (e2e)', () => {
  let admin: Sql;
  let app: NestFastifyApplication;
  let worker: NotificationWorker;
  const tokens = {} as Record<Who, string>;

  const call = async (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    as: Who,
    body?: unknown,
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { 'x-tenant-id': PEOPLE[as].tenant, authorization: `Bearer ${tokens[as]}` },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });

  const backdateLeads = (who: Who, hours: number) =>
    admin`update lead_events set occurred_at = now() - make_interval(hours => ${hours})
          where actor_user_id = ${PEOPLE[who].user}`;

  /** Contact reveals are counted once per viewer (lead_dedupe_minutes, in Redis): a rerun starts clean. */
  async function clearRedis(): Promise<void> {
    const redis = new Redis(process.env.REDIS_URL!);
    try {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `*store:${STORE}*`, 'COUNT', 500);
        cursor = next;
        if (keys.length > 0) await redis.del(...keys);
      } while (cursor !== '0');
    } finally {
      redis.disconnect();
    }
  }

  async function cleanUp(): Promise<void> {
    await clearRedis();
    const tenants = [TENANT_A, TENANT_B];
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const table of [
        'moderation_actions',
        'reports',
        'review_responses',
        'media_attachments',
        'reviews',
        'review_prompts',
        'store_seller_scores',
        'lead_events',
        'member_trust_scores',
        'store_members',
        'stores',
        'tenant_members',
        'tenant_settings',
      ]) {
        await tx.unsafe(`delete from ${table} where tenant_id = any($1::uuid[])`, [tenants]);
      }
      await tx`delete from notification_deliveries where user_id::text like ${FIXTURE}`;
      await tx`delete from notifications where user_id::text like ${FIXTURE}`;
    });
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from user_profiles where user_id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();
    for (const person of Object.values(PEOPLE)) {
      await admin`insert into users (id, phone_e164, phone_verified_at) values (${person.user}, ${person.phone}, now())`;
    }
    await admin`insert into user_profiles (user_id, display_name) values (${PEOPLE.buyer.user}, 'করিম ক্রেতা')`;
    await admin`insert into partners (id, legal_name, display_name, phone_e164)
                values (${PARTNER}, 'Review Partner', 'Review Partner', '+8801866000099')`;
    await admin`insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
      (${AREA_A}, 3, 'upazila', 'review-e2e-a', 'Review A', 'fixture'),
      (${AREA_B}, 3, 'upazila', 'review-e2e-b', 'Review B', 'fixture')`;
    await admin`insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
      (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'review-e2e-a', 'এ', 'A', st_point(89.05, 22.75)::geography, 'active'),
      (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'review-e2e-b', 'বি', 'B', st_point(89.15, 22.75)::geography, 'active')`;
    for (const person of Object.values(PEOPLE)) {
      await admin`insert into tenant_members (id, tenant_id, user_id, role_code)
                  values (${person.member}, ${person.tenant}, ${person.user}, ${person.role})`;
    }
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code, phone_e164)
               values (${STORE}, ${TENANT_B}, ${PEOPLE.owner.member}, 'review-e2e-store', 'রিভিউ দোকান', 'active',
                       '+8801869000004')`;
    });
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api', {
      exclude: [
        { path: 'health/live', method: RequestMethod.GET },
        { path: 'health/ready', method: RequestMethod.GET },
      ],
    });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const signer = module.get(TokenService);
    for (const [who, person] of Object.entries(PEOPLE) as [Who, (typeof PEOPLE)[Who]][]) {
      tokens[who] = await signer.signAccessToken({
        userId: person.user,
        tenantId: person.tenant,
        memberId: person.member,
        role: person.role as 'member' | 'moderator',
      });
    }
    worker = await startNotificationWorker();
  }, 120_000);

  afterAll(async () => {
    try {
      await worker?.close();
      await app?.close();
      await cleanUp();
    } finally {
      await admin.end();
    }
  }, 60_000);

  let reviewId = '';

  it('no contact: the buyer cannot review', async () => {
    const eligibility = await call('GET', `/stores/${STORE}/reviews/eligibility`, 'buyer');
    expect(eligibility.json()).toMatchObject({ status: 'no_contact', myReview: null });
    const refused = await call('POST', `/stores/${STORE}/reviews`, 'buyer', {
      rating: 5,
      text: 'চমৎকার',
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      error: 'REVIEW_NOT_ELIGIBLE',
      details: { status: 'no_contact' },
    });
  });

  it('a call records the lead with the user, across the boundary; too soon to review yet', async () => {
    const reveal = await call('POST', `/stores/${STORE}/contact`, 'buyer', { channel: 'call' });
    expect(reveal.statusCode).toBe(200);
    const [lead] = await admin<{ actor_user_id: string | null }[]>`
      select actor_user_id from lead_events where store_id = ${STORE}`;
    expect(lead!.actor_user_id).toBe(PEOPLE.buyer.user);
    const eligibility = (await call('GET', `/stores/${STORE}/reviews/eligibility`, 'buyer')).json<{
      status: string;
      eligibleAt: string | null;
    }>();
    expect(eligibility.status).toBe('too_soon');
    expect(eligibility.eligibleAt).not.toBeNull();
  });

  it('in the window: the review is published and the buyer becomes a member of the store’s area', async () => {
    await backdateLeads('buyer', 30);
    expect(
      (await call('GET', `/stores/${STORE}/reviews/eligibility`, 'buyer')).json(),
    ).toMatchObject({ status: 'eligible' });
    const written = await call('POST', `/stores/${STORE}/reviews`, 'buyer', {
      rating: 5,
      text: 'দোকানদার খুব ভদ্র, ঠিক সময়ে ডেলিভারি দিয়েছেন।',
    });
    expect(written.statusCode).toBe(201);
    const body = written.json<{ review: { id: string; status: string }; needsReview: boolean }>();
    expect(body).toMatchObject({ review: { status: 'published', rating: 5 }, needsReview: false });
    reviewId = body.review.id;
    const members =
      await admin`select 1 from tenant_members where tenant_id = ${TENANT_B} and user_id = ${PEOPLE.buyer.user}`;
    expect(members.length).toBe(1);
    const again = await call('POST', `/stores/${STORE}/reviews`, 'buyer', { rating: 1 });
    expect(again.json()).toMatchObject({
      error: 'REVIEW_NOT_ELIGIBLE',
      details: { status: 'already_reviewed' },
    });
  });

  it('listed with the summary and a tier — never a raw score', async () => {
    const page = (await call('GET', `/stores/${STORE}/reviews`, 'buyer2')).json<{
      summary: Record<string, unknown>;
      items: { id: string; authorName: string | null; verifiedContact: boolean }[];
    }>();
    expect(page.summary).toMatchObject({
      average: 5,
      count: 1,
      histogram: { '5': 1 },
      tier: 'new',
    });
    expect(page.summary).not.toHaveProperty('score');
    expect(page.items).toEqual([
      expect.objectContaining({ id: reviewId, authorName: 'করিম ক্রেতা', verifiedContact: true }),
    ]);
    const storePage = (await call('GET', `/stores/review-e2e-store`, 'owner')).json<{
      sellerTier: string;
    }>();
    expect(storePage.sellerTier).toBe('new');
  });

  it('the author edits it within the window', async () => {
    const edited = await call('PATCH', `/stores/${STORE}/reviews/mine`, 'buyer', {
      rating: 4,
      text: 'ভালো, তবে প্যাকেজিং আরেকটু ভালো হতে পারত।',
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ review: { rating: 4, status: 'published' } });
  });

  it('the store replies; it cannot delete — it reports, and a moderator decides', async () => {
    const replied = await call('PUT', `/stores/${STORE}/reviews/${reviewId}/response`, 'owner', {
      text: 'ধন্যবাদ!',
    });
    expect(replied.json()).toEqual({ created: true });
    const listed = (await call('GET', `/stores/${STORE}/reviews`, 'buyer2')).json<{
      items: { response: { text: string } | null }[];
    }>();
    expect(listed.items[0]!.response).toMatchObject({ text: 'ধন্যবাদ!' });

    const del = await call('DELETE', `/stores/${STORE}/reviews/${reviewId}`, 'owner');
    expect(del.statusCode).toBe(404);
    const notReply = await call('PUT', `/stores/${STORE}/reviews/${reviewId}/response`, 'buyer2', {
      text: 'হাহা',
    });
    expect(notReply.json()).toMatchObject({ error: 'REVIEW_REPLY_FORBIDDEN' });

    const report = await call('POST', `/stores/${STORE}/reviews/${reviewId}/report`, 'owner', {
      reasonCode: 'fake_review',
      details: 'এই নামে কেউ কেনেনি',
    });
    expect(report.statusCode).toBe(201);
    const queue = (await call('GET', '/reviews/queue', 'mod')).json<{
      items: { id: string; openReports: number }[];
    }>();
    expect(queue.items).toEqual([expect.objectContaining({ id: reviewId, openReports: 1 })]);
    const decided = await call('POST', `/reviews/${reviewId}/decision`, 'mod', {
      decision: 'hide',
      reasonCode: 'fake_review',
      note: 'কোনো যোগাযোগের প্রমাণ মেলেনি',
    });
    expect(decided.json()).toEqual({ status: 'hidden', reportsClosed: 1 });
    const after = (await call('GET', `/stores/${STORE}/reviews`, 'buyer2')).json<{
      items: unknown[];
      summary: { count: number };
    }>();
    expect(after.items).toEqual([]);
    expect(after.summary.count).toBe(0);
    const forbidden = await call('GET', '/reviews/queue', 'buyer');
    expect(forbidden.statusCode).toBe(403);
  });

  it('after the window: rejected', async () => {
    await call('POST', `/stores/${STORE}/contact`, 'late', { channel: 'call' });
    await backdateLeads('late', 24 * 100);
    const refused = await call('POST', `/stores/${STORE}/reviews`, 'late', { rating: 3 });
    expect(refused.json()).toMatchObject({
      error: 'REVIEW_NOT_ELIGIBLE',
      details: { status: 'expired' },
    });
  });

  it('"how was it?" goes out once, in-app, opening the review form', async () => {
    await call('POST', `/stores/${STORE}/contact`, 'buyer2', { channel: 'whatsapp' }).catch(
      () => undefined,
    );
    await call('POST', `/stores/${STORE}/contact`, 'buyer2', { channel: 'call' });
    await backdateLeads('buyer2', 49);
    const prompts = worker.module.get(ReviewPromptsService);
    const first = await prompts.run({ batchSize: 50, maxBatches: 1 });
    expect(first.rows).toBe(1);
    expect((await prompts.run({ batchSize: 50, maxBatches: 1 })).rows).toBe(0);
    expect(await worker.dispatch((n) => n.type === 'review_prompt')).toBe(1);
    const [note] = await admin<{ title: string; deep_link: string }[]>`
      select title, deep_link from notifications where user_id = ${PEOPLE.buyer2.user} and type_code = 'review_prompt'`;
    expect(note).toEqual({ title: 'রিভিউ দোকান কেমন লাগল?', deep_link: `/stores/${STORE}/review` });
  });
});
