import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/tokens/token.service';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';
import { startNotificationWorker, type NotificationWorker } from './support/notification-worker';

/**
 * Trust-based moderation end to end (ADR 030) on real Postgres + Redis:
 * the submission decision, the moderator queue and its actions, trust
 * recompute, notifications, and hard removal (scrub) vs a legal hold.
 *
 * One post-moderated tenant. NEWBIE has no history (trust = base 20);
 * TRUSTED and HELD carry a platform override of 90 (≥ the default
 * auto-approve threshold of 60). HELD is under a legal hold.
 */

const FIXTURE = '0191e3a0-6011-7000-8000-%';
const PARTNER = '0191e3a0-6011-7000-8000-000000000001';
const AREA = '0191e3a0-6011-7000-8000-000000000011';
const TENANT = '0191e3a0-6011-7000-8000-000000000021';
const NEWBIE = '0191e3a0-6011-7000-8000-000000000031';
const TRUSTED = '0191e3a0-6011-7000-8000-000000000032';
const HELD = '0191e3a0-6011-7000-8000-000000000033';
const MOD = '0191e3a0-6011-7000-8000-000000000034';
const ADMIN = '0191e3a0-6011-7000-8000-000000000035';
const M_NEWBIE = '0191e3a0-6011-7000-8000-000000000041';
const M_TRUSTED = '0191e3a0-6011-7000-8000-000000000042';
const M_HELD = '0191e3a0-6011-7000-8000-000000000043';
const M_MOD = '0191e3a0-6011-7000-8000-000000000044';
const M_ADMIN = '0191e3a0-6011-7000-8000-000000000045';
const CATEGORY = '0191e3a0-6011-7000-8000-000000000051';
const SCHEMA = '0191e3a0-6011-7000-8000-000000000061';
const HOLD = '0191e3a0-6011-7000-8000-000000000071';
// Its own patch of map: no other e2e suite's tenant covers it.
const POINT = { lat: 22.35, lng: 91.85 };

interface Post {
  id: string;
  status: string;
}
interface QueueItem {
  postId: string;
  source: string;
  reasons: string[];
  authorTrustScore: number | null;
}

describe('Moderation (e2e)', () => {
  /** Notifications are queued (ADR 059): dispatched here before a test looks. */
  let queued: NotificationWorker;
  let app: NestFastifyApplication;
  let admin: Sql;
  const tokens: Record<string, string> = {};

  async function cleanUp(): Promise<void> {
    await admin`delete from notifications where user_id::text like ${FIXTURE}`;
    // moderation_actions is append-only (trigger); teardown bypasses it the way rls-trust does.
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from moderation_actions where tenant_id::text like ${FIXTURE}`;
    });
    await admin`delete from moderation_queue_items where tenant_id::text like ${FIXTURE}`;
    await admin`delete from member_trust_scores where tenant_id::text like ${FIXTURE}`;
    await admin`delete from legal_holds where id::text like ${FIXTURE}`;
    await admin`delete from outbox_events where aggregate_table = 'posts' and payload->>'tenantId' like ${FIXTURE}`;
    await admin`delete from posts where tenant_id::text like ${FIXTURE}`;
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

  beforeAll(async () => {
    queued = await startNotificationWorker();
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();

    await admin`
      insert into users (id, phone_e164) values
        (${NEWBIE}, '+8801777000001'), (${TRUSTED}, '+8801777000002'), (${HELD}, '+8801777000003'),
        (${MOD}, '+8801777000004'), (${ADMIN}, '+8801777000005')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Moderation Partner', 'Moderation Partner', '+8801777000099')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release, boundary, boundary_simplified)
      values (${AREA}, 3, 'upazila', 'moderation-e2e', 'Moderation Area', 'fixture',
              'SRID=4326;MULTIPOLYGON(((91.8 22.3,91.9 22.3,91.9 22.4,91.8 22.4,91.8 22.3)))',
              'SRID=4326;MULTIPOLYGON(((91.8 22.3,91.9 22.3,91.9 22.4,91.8 22.4,91.8 22.3)))')`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values (${TENANT}, ${PARTNER}, ${AREA}, 'moderation-e2e', 'মডারেশন', 'Moderation',
              st_point(91.85, 22.35)::geography, 'active')`;
    await admin.begin(async (tx) => {
      // Every auto-approval is sampled here, so sampling is observable. A
      // platform-scope override, so platform staff only (0003 trigger).
      await tx`select set_config('app.role', 'platform_admin', true)`;
      await tx`
        insert into tenant_settings (tenant_id, post_moderation_mode_code, setting_overrides)
        values (${TENANT}, 'post', ${tx.json({ moderation_sample_rate_percent: 100 })})`;
    });
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${M_NEWBIE}, ${TENANT}, ${NEWBIE}, 'member'), (${M_TRUSTED}, ${TENANT}, ${TRUSTED}, 'member'),
        (${M_HELD}, ${TENANT}, ${HELD}, 'member'), (${M_MOD}, ${TENANT}, ${MOD}, 'moderator'),
        (${M_ADMIN}, ${TENANT}, ${ADMIN}, 'tenant_admin')`;
    await admin`
      insert into member_trust_scores (tenant_id, member_id, score, components, algorithm_version, override_score, override_reason)
      values (${TENANT}, ${M_TRUSTED}, 90, '{}', 1, 90, 'fixture: long-standing seller'),
             (${TENANT}, ${M_HELD}, 90, '{}', 1, 90, 'fixture: long-standing seller')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en, default_moderation_mode_code, default_post_expiry_days)
      values (${CATEGORY}, 'marketplace', 'moderation-e2e-sale', 'বিক্রি', 'For sale', 'post', 30)`;
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
      })}, ${admin.json({ order: ['price'], labels: { price: { bn: 'দাম', en: 'Price' } } })}, 'published', now())`;
    await admin`insert into tenant_categories (tenant_id, category_id, is_enabled) values (${TENANT}, ${CATEGORY}, true)`;
    await admin`
      insert into legal_holds (id, subject_type_code, subject_id, reason, placed_by_user_id)
      values (${HOLD}, 'user', ${HELD}, 'fixture: court order', ${ADMIN})`;

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
    for (const [name, userId, memberId, role] of [
      ['newbie', NEWBIE, M_NEWBIE, 'member'],
      ['trusted', TRUSTED, M_TRUSTED, 'member'],
      ['held', HELD, M_HELD, 'member'],
      ['mod', MOD, M_MOD, 'moderator'],
      ['admin', ADMIN, M_ADMIN, 'tenant_admin'],
    ] as const) {
      tokens[name] = await signer.signAccessToken({ userId, tenantId: TENANT, memberId, role });
    }
  });

  afterAll(async () => {
    await queued?.close();
    await app.close();
    try {
      await cleanUp();
    } finally {
      await admin.end();
    }
  });

  type As = 'newbie' | 'trusted' | 'held' | 'mod' | 'admin';
  const call = (method: 'GET' | 'POST', url: string, as: As, body?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { 'x-tenant-id': TENANT, authorization: `Bearer ${tokens[as]}` },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });

  let n = 0;
  const submit = async (as: As, overrides: Record<string, unknown> = {}): Promise<Post> => {
    const response = await call('POST', '/posts', as, {
      categoryId: CATEGORY,
      title: `পুরনো সাইকেল বিক্রি ${++n}`,
      description: 'ভালো অবস্থায় আছে।',
      fields: { price: '3500.00' },
      location: POINT,
      submit: true,
      ...overrides,
    });
    expect(response.statusCode).toBe(201);
    return response.json<Post>();
  };
  const queue = async (query = ''): Promise<QueueItem[]> =>
    (await call('GET', `/moderation/queue${query}`, 'mod')).json<{ items: QueueItem[] }>().items;
  const itemFor = async (postId: string) =>
    (await queue('?limit=100')).find((i) => i.postId === postId);
  const actions = (postId: string) =>
    admin<{ action_code: string; reason_code: string }[]>`
      select action_code, reason_code from moderation_actions where post_id = ${postId} order by created_at`;
  const notificationsOf = async (userId: string) => {
    await queued.dispatch((n) => n.userId === userId);
    return admin<{ type_code: string; params: Record<string, string> }[]>`
      select type_code, params from notifications where user_id = ${userId} order by created_at`;
  };

  describe('the submission decision', () => {
    it("a new member's post waits in the queue (low trust)", async () => {
      const post = await submit('newbie');
      expect(post.status).toBe('pending');
      expect(await itemFor(post.id)).toMatchObject({
        source: 'submission',
        reasons: ['low_trust'],
        authorTrustScore: 20,
      });
    });

    it("a trusted member's post goes live at once — and, sampled, still reaches the queue", async () => {
      const post = await submit('trusted');
      expect(post.status).toBe('live');
      expect(await itemFor(post.id)).toMatchObject({ source: 'sample', reasons: ['sample'] });
    });

    it("a trusted member's post with a banned keyword waits, with the reason", async () => {
      const post = await submit('trusted', { description: 'বুকিং করতে অগ্রিম টাকা লাগবে' });
      expect(post.status).toBe('pending');
      expect((await itemFor(post.id))?.reasons).toEqual(['banned_keyword']);
    });

    it('a phone number typed in Bengali digits is caught too', async () => {
      const post = await submit('trusted', { description: 'যোগাযোগ: ০১৭১২-৩৪৫৬৭৮' });
      expect(post.status).toBe('pending');
      expect((await itemFor(post.id))?.reasons).toEqual(['contact_info']);
    });
  });

  describe('the queue', () => {
    it('is for staff only', async () => {
      expect((await call('GET', '/moderation/queue', 'newbie')).statusCode).toBe(403);
    });

    it('lists oldest first and filters by reason', async () => {
      const items = await queue('?limit=100');
      const low = await queue('?reason=low_trust&limit=100');
      expect(low.length).toBeGreaterThan(0);
      expect(low.every((i) => i.reasons.includes('low_trust'))).toBe(true);
      expect(items.map((i) => i.postId)).toEqual([...items].map((i) => i.postId)); // stable order
    });
  });

  describe('moderator actions', () => {
    it('approve: pending → live, recorded, owner notified, trust recomputed', async () => {
      const post = await submit('newbie');
      const response = await call('POST', `/moderation/${post.id}/approve`, 'mod');
      expect(response.json()).toMatchObject({ status: 'live', scrubbed: false });
      expect(await actions(post.id)).toEqual([
        { action_code: 'approved', reason_code: 'meets_guidelines' },
      ]);
      expect(await itemFor(post.id)).toBeUndefined();
      expect((await notificationsOf(NEWBIE)).map((x) => x.type_code)).toContain('post_approved');
      const [trust] = await admin<{ score: number }[]>`
        select score from member_trust_scores where member_id = ${M_NEWBIE}`;
      expect(trust!.score).toBeGreaterThan(20); // an approved post counts
    });

    it('reject: pending → rejected with the reason, owner told why, trust drops', async () => {
      const [before] = await admin<
        { score: number }[]
      >`select score from member_trust_scores where member_id = ${M_NEWBIE}`;
      const post = await submit('newbie');
      const response = await call('POST', `/moderation/${post.id}/reject`, 'mod', {
        reasonCode: 'wrong_category',
        reasonText: 'এটা গাড়ির ক্যাটাগরিতে দিন',
      });
      expect(response.json()).toMatchObject({ status: 'rejected' });
      const note = (await notificationsOf(NEWBIE)).find((x) => x.type_code === 'post_rejected');
      expect(note?.params).toMatchObject({ postId: post.id, reasonCode: 'wrong_category' });
      const [after] = await admin<
        { score: number }[]
      >`select score from member_trust_scores where member_id = ${M_NEWBIE}`;
      expect(after!.score).toBeLessThan(before!.score);

      // The author sees why, with the moderator's note, on the post and in "my posts".
      const mine = await call('GET', `/posts/${post.id}`, 'newbie');
      expect(mine.json()).toMatchObject({
        status: 'rejected',
        moderationReason: 'wrong_category',
        moderationNote: 'এটা গাড়ির ক্যাটাগরিতে দিন',
      });
      const listed = await call('GET', '/posts/me?status=rejected', 'newbie');
      expect(
        listed.json<{ items: { id: string; moderationNote: string | null }[] }>().items,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: post.id, moderationNote: 'এটা গাড়ির ক্যাটাগরিতে দিন' }),
        ]),
      );
    });

    it('remove: live → removed, owner notified; approving it afterwards is illegal', async () => {
      const post = await submit('trusted');
      const response = await call('POST', `/moderation/${post.id}/remove`, 'mod', {
        reasonCode: 'scam_suspected',
      });
      expect(response.json()).toMatchObject({ status: 'removed' });
      expect((await notificationsOf(TRUSTED)).map((x) => x.type_code)).toContain('post_removed');
      expect((await call('POST', `/moderation/${post.id}/approve`, 'mod')).statusCode).toBe(409);
    });

    it('rejects a reason code that is not a moderation reason', async () => {
      const post = await submit('newbie');
      expect(
        (await call('POST', `/moderation/${post.id}/reject`, 'mod', { reasonCode: 'nope' }))
          .statusCode,
      ).toBe(400);
    });
  });

  describe('hard removal', () => {
    const body = {
      reasonCode: 'doxxing',
      reasonText: 'Shows a private address',
      evidenceRefs: ['ticket-42'],
    };

    it('needs posts:delete — a moderator is refused', async () => {
      const post = await submit('trusted');
      expect(
        (await call('POST', `/moderation/${post.id}/hard-remove`, 'mod', body)).statusCode,
      ).toBe(403);
    });

    it('scrubs the post (ADR 006) and records moderator_removed with evidence', async () => {
      const post = await submit('trusted');
      const response = await call('POST', `/moderation/${post.id}/hard-remove`, 'admin', body);
      expect(response.json()).toMatchObject({ scrubbed: true });
      const [row] = await admin<Record<string, unknown>[]>`
        select title, description, author_member_id, location, geo_area_id, scrubbed_at, deletion_reason_code, fields
        from posts where id = ${post.id}`;
      expect(row).toMatchObject({
        title: '',
        description: null,
        author_member_id: null,
        location: null,
        geo_area_id: null,
        deletion_reason_code: 'moderator_removed',
        fields: { price: '3500.00' }, // analytics whitelist survives
      });
      expect(row!.scrubbed_at).not.toBeNull();
      const [action] = await admin<{ action_code: string; evidence_refs: string[] }[]>`
        select action_code, evidence_refs from moderation_actions where post_id = ${post.id}`;
      expect(action).toEqual({ action_code: 'moderator_removed', evidence_refs: ['ticket-42'] });
    });

    it('does not scrub a post under a legal hold, and changes nothing', async () => {
      const post = await submit('held');
      const response = await call('POST', `/moderation/${post.id}/hard-remove`, 'admin', body);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: 'LEGAL_HOLD_BLOCKS_SCRUB' });
      const [row] = await admin<
        { scrubbed_at: Date | null; title: string; deletion_reason_code: string | null }[]
      >`
        select scrubbed_at, title, deletion_reason_code from posts where id = ${post.id}`;
      expect(row).toMatchObject({ scrubbed_at: null, deletion_reason_code: null });
      expect(row!.title).not.toBe('');
      expect(await actions(post.id)).toEqual([]);
    });
  });

  describe('bulk', () => {
    it('approves many, reporting each post separately', async () => {
      const a = await submit('newbie');
      const b = await submit('newbie');
      const missing = '0191e3a0-6011-7000-8000-00000000ffff';
      const response = await call('POST', '/moderation/bulk', 'mod', {
        action: 'approve',
        postIds: [a.id, b.id, missing],
      });
      expect(response.json<{ results: unknown[] }>().results).toEqual([
        { postId: a.id, ok: true, status: 'live', error: null },
        { postId: b.id, ok: true, status: 'live', error: null },
        { postId: missing, ok: false, status: null, error: 'MODERATION_POST_NOT_FOUND' },
      ]);
    });

    it('needs a reason to reject', async () => {
      const a = await submit('newbie');
      expect(
        (await call('POST', '/moderation/bulk', 'mod', { action: 'reject', postIds: [a.id] }))
          .statusCode,
      ).toBe(400);
    });
  });
});
