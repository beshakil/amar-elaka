import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/tokens/token.service';
import { JobRunner } from '../src/jobs/job-runner.service';
import { MediaMaintenanceService } from '../src/media/media-maintenance.service';
import { MediaWorkerModule } from '../src/media/media-worker.module';
import { DraftCleanupService } from '../src/posts/draft-cleanup.service';
import { PostExpiryReminderService } from '../src/posts/post-expiry-reminder.service';
import { PostExpiryService } from '../src/posts/post-expiry.service';
import { PostsWorkerModule } from '../src/posts/posts-worker.module';
import { STORAGE_SERVICE, type StorageService } from '../src/storage/storage.ports';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * The scheduled post-lifecycle jobs (ADR 031) against real Postgres, Redis
 * and local storage: expiry, expiry reminders + one-tap renewal, stale-draft
 * cleanup, orphan media, media purge — each idempotent, capped and stopped by
 * legal holds — plus the JobRunner lock and the platform jobs API.
 *
 * The sweeps are global (every tenant), and other e2e suites run alongside:
 * assertions are about this suite's own rows, never about run totals.
 */

const FIXTURE = '0191e3a0-71fe-7000-8000-%';
const PARTNER = '0191e3a0-71fe-7000-8000-000000000001';
const AREA = '0191e3a0-71fe-7000-8000-000000000011';
const TENANT = '0191e3a0-71fe-7000-8000-000000000021';
const OWNER = '0191e3a0-71fe-7000-8000-000000000031';
const HELD = '0191e3a0-71fe-7000-8000-000000000032';
const ADMIN = '0191e3a0-71fe-7000-8000-000000000033';
const TENANT_ADMIN = '0191e3a0-71fe-7000-8000-000000000034';
const M_OWNER = '0191e3a0-71fe-7000-8000-000000000041';
const M_HELD = '0191e3a0-71fe-7000-8000-000000000042';
const M_TENANT_ADMIN = '0191e3a0-71fe-7000-8000-000000000044';
const CATEGORY = '0191e3a0-71fe-7000-8000-000000000051';
const SCHEMA = '0191e3a0-71fe-7000-8000-000000000061';
const HOLD = '0191e3a0-71fe-7000-8000-000000000071';
const NO_MEMBER = '00000000-0000-7000-8000-000000000000';
/** A budget big enough to reach this suite's rows whatever else is due. */
const BUDGET = { batchSize: 500, maxBatches: 20 };

let sequence = 0x100;
const nextId = () => `0191e3a0-71fe-7000-8000-${(sequence++).toString(16).padStart(12, '0')}`;

describe('Post lifecycle jobs (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: Sql;
  let storage: StorageService;
  let expiry: PostExpiryService;
  let reminders: PostExpiryReminderService;
  let drafts: DraftCleanupService;
  let media: MediaMaintenanceService;
  let runner: JobRunner;
  const tokens: Record<string, string> = {};

  async function cleanUp(): Promise<void> {
    await admin`delete from job_runs where triggered_by_user_id::text like ${FIXTURE}`;
    await admin`delete from notifications where user_id::text like ${FIXTURE}`;
    await admin`delete from legal_holds where id::text like ${FIXTURE}`;
    await admin`delete from outbox_events where aggregate_table = 'posts' and aggregate_id::text like ${FIXTURE}`;
    await admin`delete from media_attachments where tenant_id::text like ${FIXTURE}`;
    await admin`delete from posts where tenant_id::text like ${FIXTURE}`;
    await admin`delete from media_assets where tenant_id::text like ${FIXTURE}`;
    await admin`delete from member_trust_scores where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_categories where tenant_id::text like ${FIXTURE}`;
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from tenant_settings where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_members where user_id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  /** A post inserted directly, in the state a test needs. */
  async function post(
    status: 'draft' | 'live',
    options: { author?: string; expiresIn?: string; untouchedFor?: string } = {},
  ): Promise<string> {
    const id = nextId();
    await admin`
      insert into posts (id, tenant_id, author_member_id, category_id, field_schema_id, title, status_code,
                         published_at, expires_at, created_at, updated_at)
      values (${id}, ${TENANT}, ${options.author ?? M_OWNER}, ${CATEGORY}, ${SCHEMA}, ${`lifecycle ${id}`},
              ${status},
              ${status === 'live' ? admin`now()` : null},
              ${options.expiresIn ? admin`now() + ${options.expiresIn}::interval` : null},
              now() - ${options.untouchedFor ?? '0 seconds'}::interval,
              now() - ${options.untouchedFor ?? '0 seconds'}::interval)`;
    return id;
  }

  /** A media asset with its object in local storage. */
  async function asset(options: {
    uploader?: string;
    age: string;
    deleted?: { purgeDueIn: string };
  }): Promise<{ id: string; key: string }> {
    const id = nextId();
    const key = `lifecycle-e2e/${id}`;
    await storage.putObject('media', key, Buffer.from('fixture'), 'image/webp');
    await admin`
      insert into media_assets
        (id, tenant_id, uploaded_by_user_id, kind_code, visibility_code, storage_key, mime_type, byte_size,
         checksum_sha256, status_code, created_at, deleted_at, purge_due_at)
      values (${id}, ${TENANT}, ${options.uploader ?? OWNER}, 'image', 'public', ${key}, 'image/webp', 7,
              ${`chk-${id}`}, 'ready', now() - ${options.age}::interval,
              ${options.deleted ? admin`now()` : null},
              ${options.deleted ? admin`now() + ${options.deleted.purgeDueIn}::interval` : null})`;
    return { id, key };
  }

  const exists = async (id: string) =>
    (await admin`select 1 from posts where id = ${id}`).length === 1;
  const statusOf = async (id: string) =>
    (await admin<{ status_code: string }[]>`select status_code from posts where id = ${id}`)[0]
      ?.status_code;
  const remindersFor = async (postId: string) =>
    admin<{ dedupe_key: string; deep_link: string }[]>`
      select dedupe_key, deep_link from notifications
      where type_code = 'post_expiring' and entity_id = ${postId} order by created_at`;

  const call = (
    method: 'GET' | 'POST',
    url: string,
    as: string,
  ): ReturnType<NestFastifyApplication['inject']> =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${tokens[as]}`, 'x-tenant-id': TENANT },
    });

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();
    await admin`
      insert into users (id, phone_e164, platform_role_code) values
        (${OWNER}, '+8801799000001', null), (${HELD}, '+8801799000002', null),
        (${ADMIN}, '+8801799000003', 'platform_admin'), (${TENANT_ADMIN}, '+8801799000004', null)`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Lifecycle Partner', 'Lifecycle Partner', '+8801799000099')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release)
      values (${AREA}, 3, 'upazila', 'lifecycle-e2e', 'Lifecycle Area', 'fixture')`;
    // Its own patch of map (Rajshahi): no other e2e suite's tenant covers it.
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values (${TENANT}, ${PARTNER}, ${AREA}, 'lifecycle-e2e', 'লাইফসাইকেল', 'Lifecycle',
              st_point(88.6, 24.37)::geography, 'active')`;
    await admin`insert into tenant_settings (tenant_id, post_moderation_mode_code) values (${TENANT}, 'post')`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${M_OWNER}, ${TENANT}, ${OWNER}, 'member'), (${M_HELD}, ${TENANT}, ${HELD}, 'member'),
        (${M_TENANT_ADMIN}, ${TENANT}, ${TENANT_ADMIN}, 'tenant_admin')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en, default_moderation_mode_code, default_post_expiry_days)
      values (${CATEGORY}, 'marketplace', 'lifecycle-e2e', 'বিভাগ', 'Category', 'post', 30)`;
    await admin`
      insert into category_field_schemas (id, category_id, version, json_schema, status_code, published_at)
      values (${SCHEMA}, ${CATEGORY}, 1, '{"type":"object","properties":{}}'::jsonb, 'published', now())`;
    await admin`
      insert into tenant_categories (tenant_id, category_id, is_enabled) values (${TENANT}, ${CATEGORY}, true)`;
    await admin`
      insert into legal_holds (id, subject_type_code, subject_id, reason, placed_by_user_id)
      values (${HOLD}, 'user', ${HELD}, 'fixture: court order', ${ADMIN})`;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, PostsWorkerModule, MediaWorkerModule],
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
    storage = moduleRef.get<StorageService>(STORAGE_SERVICE);
    expiry = moduleRef.get(PostExpiryService);
    reminders = moduleRef.get(PostExpiryReminderService);
    drafts = moduleRef.get(DraftCleanupService);
    media = moduleRef.get(MediaMaintenanceService);
    runner = moduleRef.get(JobRunner);

    const signer = moduleRef.get(TokenService);
    for (const [name, userId, memberId, role] of [
      ['owner', OWNER, M_OWNER, 'member'],
      ['tenantAdmin', TENANT_ADMIN, M_TENANT_ADMIN, 'tenant_admin'],
      ['platformAdmin', ADMIN, NO_MEMBER, 'member'],
    ] as const) {
      tokens[name] = await signer.signAccessToken({ userId, tenantId: TENANT, memberId, role });
    }
  });

  afterAll(async () => {
    await app.close();
    try {
      await cleanUp();
    } finally {
      await admin.end();
    }
  });

  describe('expiry', () => {
    it('expires live posts past expires_at, with the event; a second run changes nothing', async () => {
      const due = await post('live', { expiresIn: '-1 minute' });
      const notYet = await post('live', { expiresIn: '5 days' });

      await expiry.expireDue(BUDGET);
      expect(await statusOf(due)).toBe('expired');
      expect(await statusOf(notYet)).toBe('live');

      await expiry.expireDue(BUDGET);
      const events = await admin`
        select 1 from outbox_events where aggregate_id = ${due} and event_type = 'post.expired'`;
      expect(events).toHaveLength(1);
    });
  });

  describe('expiry reminder and one-tap repost', () => {
    it('reminds once per listing period, with a repost deep link', async () => {
      const id = await post('live', { expiresIn: '2 days' });
      await reminders.remindExpiring(BUDGET);
      await reminders.remindExpiring(BUDGET);

      const sent = await remindersFor(id);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.deep_link).toBe(`/posts/${id}?action=repost`);
    });

    it('does not remind before the window, nor for hidden posts', async () => {
      const early = await post('live', { expiresIn: '10 days' });
      const hidden = await post('live', { expiresIn: '1 day' });
      await admin`update posts set hidden_by_owner = true where id = ${hidden}`;
      await reminders.remindExpiring(BUDGET);
      expect(await remindersFor(early)).toHaveLength(0);
      expect(await remindersFor(hidden)).toHaveLength(0);
    });

    it('renews a live post inside the window without bumping it, and reminds again next period', async () => {
      const id = await post('live', { expiresIn: '1 day' });
      await reminders.remindExpiring(BUDGET);
      const [before] = await admin<{ expires_at: Date; bumped_at: Date | null }[]>`
        select expires_at, bumped_at from posts where id = ${id}`;

      const renewed = await call('POST', `/posts/${id}/repost`, 'owner');
      expect(renewed.statusCode).toBe(200);
      expect(renewed.json()).toMatchObject({ status: 'live' });
      const [after] = await admin<{ expires_at: Date; bumped_at: Date | null }[]>`
        select expires_at, bumped_at from posts where id = ${id}`;
      expect(after!.expires_at.getTime()).toBeGreaterThan(before!.expires_at.getTime());
      expect(after!.bumped_at).toEqual(before!.bumped_at);
      const events = await admin`
        select 1 from outbox_events where aggregate_id = ${id} and event_type = 'post.renewed'`;
      expect(events).toHaveLength(1);

      // Time passes: the new period nears its end too.
      await admin`update posts set expires_at = now() + interval '1 day' where id = ${id}`;
      await reminders.remindExpiring(BUDGET);
      expect(await remindersFor(id)).toHaveLength(2);
    });

    it('refuses to renew a live post outside the window', async () => {
      const id = await post('live', { expiresIn: '20 days' });
      const response = await call('POST', `/posts/${id}/repost`, 'owner');
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: 'POST_RENEW_TOO_EARLY' });
    });
  });

  describe('stale drafts', () => {
    it('deletes drafts untouched past draft_retention_days, keeps fresh and held ones', async () => {
      const stale = await post('draft', { untouchedFor: '40 days' });
      const fresh = await post('draft', { untouchedFor: '2 days' });
      const held = await post('draft', { author: M_HELD, untouchedFor: '40 days' });
      const staleLive = await post('live', { expiresIn: '5 days', untouchedFor: '40 days' });

      await drafts.cleanStale(BUDGET);
      expect(await exists(stale)).toBe(false);
      expect(await exists(fresh)).toBe(true);
      expect(await exists(held)).toBe(true);
      expect(await exists(staleLive)).toBe(true);
    });

    it('stops at the cap and carries on next run', async () => {
      const first = await post('draft', { untouchedFor: '400 days' });
      const second = await post('draft', { untouchedFor: '399 days' });

      const capped = await drafts.cleanStale({ batchSize: 1, maxBatches: 1 });
      expect(capped).toMatchObject({ rows: 1, capped: true });
      expect(await exists(first)).toBe(false);
      expect(await exists(second)).toBe(true);

      await drafts.cleanStale(BUDGET);
      expect(await exists(second)).toBe(false);
    });

    it("leaves a deleted draft's photos to the orphan job, which removes them with their files", async () => {
      const draft = await post('draft', { untouchedFor: '40 days' });
      const photo = await asset({ age: '40 days' });
      await admin.begin(async (tx) => {
        // Attached 40 days ago too: without triggers, so 0030's photo_count
        // upkeep doesn't bump the draft's updated_at to now.
        await tx`set local session_replication_role = replica`;
        await tx`
          insert into media_attachments (tenant_id, post_id, media_asset_id, sort_order)
          values (${TENANT}, ${draft}, ${photo.id}, 0)`;
      });

      await media.cleanOrphans(BUDGET); // attached: not an orphan yet
      expect(await storage.head('media', photo.key)).toBeDefined();

      await drafts.cleanStale(BUDGET);
      await media.cleanOrphans(BUDGET);
      expect(await admin`select 1 from media_assets where id = ${photo.id}`).toHaveLength(0);
      expect(await storage.head('media', photo.key)).toBeUndefined();
    });
  });

  describe('orphan media', () => {
    it('removes old unattached uploads, row and file; spares new ones and legal holds; idempotent', async () => {
      const orphan = await asset({ age: '2 days' });
      const recent = await asset({ age: '1 hour' });
      const held = await asset({ uploader: HELD, age: '2 days' });

      await media.cleanOrphans(BUDGET);
      await media.cleanOrphans(BUDGET);
      expect(await admin`select 1 from media_assets where id = ${orphan.id}`).toHaveLength(0);
      expect(await storage.head('media', orphan.key)).toBeUndefined();
      expect(await storage.head('media', recent.key)).toBeDefined();
      expect(await admin`select 1 from media_assets where id = ${held.id}`).toHaveLength(1);
      expect(await storage.head('media', held.key)).toBeDefined();
    });
  });

  describe('media purge', () => {
    it('deletes the files of soft-deleted media once due, keeps the row; spares legal holds', async () => {
      const due = await asset({ age: '40 days', deleted: { purgeDueIn: '-1 hour' } });
      const notYet = await asset({ age: '40 days', deleted: { purgeDueIn: '5 days' } });
      const held = await asset({
        uploader: HELD,
        age: '40 days',
        deleted: { purgeDueIn: '-1 hour' },
      });

      await media.purgeDeleted(BUDGET);
      await media.purgeDeleted(BUDGET);
      const [row] = await admin<{ purged_at: Date | null }[]>`
        select purged_at from media_assets where id = ${due.id}`;
      expect(row!.purged_at).not.toBeNull();
      expect(await storage.head('media', due.key)).toBeUndefined();
      expect(await storage.head('media', notYet.key)).toBeDefined();
      expect(await storage.head('media', held.key)).toBeDefined();
    });
  });

  describe('JobRunner', () => {
    const manual = { trigger: 'manual' as const, triggeredByUserId: ADMIN };

    it('records a run; a second start while it runs is skipped, not run twice', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const first = runner.run('purge-deleted-media', manual, null, async () => {
        await gate;
        return { rows: 3, capped: false, details: { fixture: 1 } };
      });
      // Let the first run open its row before the second tries.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const second = await runner.run('purge-deleted-media', manual, null, () =>
        Promise.reject(new Error('must not run')),
      );
      release();
      const done = await first;

      expect(second.status).toBe('skipped');
      expect(done).toMatchObject({ status: 'succeeded', rows: 3 });
      const [run] = await admin<
        { status_code: string; rows_affected: number; duration_ms: number; details: unknown }[]
      >`select status_code, rows_affected, duration_ms, details from job_runs where id = ${done.runId}`;
      expect(run).toMatchObject({
        status_code: 'succeeded',
        rows_affected: 3,
        details: { capped: false, fixture: 1 },
      });
      expect(run!.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('records a failure with its message and rethrows it', async () => {
      await expect(
        runner.run('purge-deleted-media', manual, null, () =>
          Promise.reject(new Error('disk on fire')),
        ),
      ).rejects.toThrow('disk on fire');
      const [run] = await admin<{ status_code: string; error_message: string }[]>`
        select status_code, error_message from job_runs
        where job_code = 'purge-deleted-media' and triggered_by_user_id = ${ADMIN}
        order by started_at desc limit 1`;
      expect(run).toEqual({ status_code: 'failed', error_message: 'Error: disk on fire' });
    });
  });

  describe('platform jobs API', () => {
    it('is for platform admins only', async () => {
      expect((await call('GET', '/platform/jobs', 'tenantAdmin')).statusCode).toBe(403);
      expect((await call('POST', '/platform/jobs/expire-posts/run', 'owner')).statusCode).toBe(403);
    });

    it('triggers a run in the worker, and the health view and history show it', async () => {
      const triggered = await call(
        'POST',
        '/platform/jobs/clean-stale-drafts/run',
        'platformAdmin',
      );
      expect(triggered.statusCode).toBe(202);
      const { queueJobId } = triggered.json<{ queueJobId: string }>();

      let status = 'running';
      for (let attempt = 0; attempt < 100 && status !== 'succeeded'; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const rows = await admin<{ status_code: string }[]>`
          select status_code from job_runs where queue_job_id = ${queueJobId}`;
        status = rows[0]?.status_code ?? 'running';
      }
      expect(status).toBe('succeeded');

      const health = await call('GET', '/platform/jobs', 'platformAdmin');
      expect(health.statusCode).toBe(200);
      const jobs =
        health.json<
          { code: string; schedule: { pattern: string } | null; lastSuccessAt: string | null }[]
        >();
      expect(jobs.map((job) => job.code)).toEqual([
        'expire-posts',
        'remind-expiring-posts',
        'clean-stale-drafts',
        'flush-post-views',
        'clean-orphan-media',
        'purge-deleted-media',
      ]);
      const drafts = jobs.find((job) => job.code === 'clean-stale-drafts')!;
      expect(drafts.schedule?.pattern).toBe('0 4 * * *');
      expect(drafts.lastSuccessAt).not.toBeNull();

      const history = await call('GET', '/platform/jobs/clean-stale-drafts/runs', 'platformAdmin');
      expect(history.json<{ queueJobId: string; trigger: string }[]>()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ queueJobId, trigger: 'manual', triggeredByUserId: ADMIN }),
        ]),
      );
    });

    it('refuses an unknown job', async () => {
      const response = await call('POST', '/platform/jobs/drop-tables/run', 'platformAdmin');
      expect(response.statusCode).toBe(400);
    });
  });
});
