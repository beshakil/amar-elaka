import { RequestMethod, VersioningType } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { SMS_PROVIDER, type SmsProvider } from '../src/auth/otp/sms/sms-provider.interface';
import { TokenService } from '../src/auth/tokens/token.service';
import { MailService } from '../src/mail/mail.service';
import type { OutgoingNotification } from '../src/notifications/notification-channel';
import { NotificationDispatcher } from '../src/notifications/notification-dispatcher';
import { NotificationOutboxRelay } from '../src/notifications/notification-outbox.relay';
import { NotificationsProcessor } from '../src/notifications/notifications.processor';
import { NotificationsSchedule } from '../src/notifications/notifications.schedule';
import { NotificationsWorkerModule } from '../src/notifications/notifications-worker.module';
import {
  PUSH_PROVIDER,
  type PushMessage,
  type PushProvider,
  type PushResult,
} from '../src/notifications/push/push-provider';
import { JOB_NOTIFY, QUEUE_NOTIFICATIONS } from '../src/queue/queue.types';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * The notification system end to end (ADR 059) on real Postgres + Redis:
 * the dispatcher and the channels run in-process (the queue's processor is
 * left out, so each step is driven and observed here), with a fake push
 * provider, a recording SMS provider and a recording mail service.
 *
 * Tenant A (Asia/Dhaka, default 22:00–08:00 quiet hours) overrides the caps:
 * 4 interruptions a day, post_approved 2 a day.
 */

const P = '0191e3a0-c4a3-7000-8000-';
const FIXTURE = `${P}%`;
const PARTNER = `${P}000000000001`;
const AREA = `${P}000000000011`;
const TENANT = `${P}000000000021`;
const CATEGORY = `${P}000000000061`;
const SCHEMA = `${P}000000000062`;
const POST = `${P}000000000081`;
const U = (n: number) => `${P}0000000000${30 + n}`;
const M = (n: number) => `${P}0000000000${50 + n}`;
const TOKENS = { alive: 'fcm-alive-token-1', dead: 'fcm-dead-token-1', other: 'fcm-other-token-1' };

/** 23:30 in Dhaka (quiet hours) and 12:00 in Dhaka (not). */
const NIGHT = new Date('2026-10-10T17:30:00Z');
const NOON = new Date('2026-10-10T06:00:00Z');
const MORNING = new Date('2026-10-11T02:00:00Z');

class FakePush implements PushProvider {
  readonly name = 'fake';
  readonly sent: PushMessage[] = [];
  readonly dead = new Set<string>([TOKENS.dead]);

  send(message: PushMessage): Promise<PushResult> {
    if (this.dead.has(message.token)) {
      return Promise.resolve({ ok: false, invalidToken: true, reason: 'UNREGISTERED' });
    }
    this.sent.push(message);
    return Promise.resolve({ ok: true, messageId: `m-${this.sent.length}` });
  }
}

describe('Notifications (e2e)', () => {
  let admin: Sql;
  let app: NestFastifyApplication;
  let moduleRef: TestingModule;
  let dispatcher: NotificationDispatcher;
  let queue: Queue<OutgoingNotification>;
  const push = new FakePush();
  const sms: { to: string; text: string }[] = [];
  const mail: { to: string; params: Record<string, string> }[] = [];
  const tokens: Record<number, string> = {};

  const notify = (
    n: number,
    over: Partial<OutgoingNotification> & Pick<OutgoingNotification, 'type' | 'params'>,
  ) =>
    ({
      userId: U(n),
      tenantId: TENANT,
      deepLink: null,
      entityId: null,
      dedupeKey: null,
      ...over,
    }) as OutgoingNotification;

  const rows = (n: number) =>
    admin<
      {
        id: string;
        type_code: string;
        title: string | null;
        body: string | null;
        collapse_count: number;
        channels_sent: string[];
      }[]
    >`
      select id, type_code, title, body, collapse_count, channels_sent from notifications
      where user_id = ${U(n)} order by id`;

  const deliveries = (n: number) =>
    admin<
      {
        id: string;
        channel_code: string;
        status_code: string;
        scheduled_for: Date | null;
        recipient_masked: string;
      }[]
    >`
      select id, channel_code, status_code, scheduled_for, recipient_masked from notification_deliveries
      where user_id = ${U(n)} order by created_at, id`;

  const call = (method: 'GET' | 'PUT' | 'DELETE', url: string, n: number, body?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { 'x-tenant-id': TENANT, authorization: `Bearer ${tokens[n]}` },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });

  /** The notify jobs NotificationService queued for a user: dispatched here, then removed. */
  async function drain(n: number, now = NOON): Promise<number> {
    const jobs = (await queue.getJobs(['waiting', 'delayed', 'prioritized'])).filter(
      (j) => j.name === JOB_NOTIFY && j.data.userId === U(n),
    );
    for (const job of jobs) {
      await dispatcher.dispatch(job.data, now);
      await job.remove();
    }
    return jobs.length;
  }

  async function cleanUp(): Promise<void> {
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from notification_deliveries where user_id::text like ${FIXTURE}`;
      await tx`delete from notifications where user_id::text like ${FIXTURE}`;
      await tx`delete from user_notification_preferences where user_id::text like ${FIXTURE}`;
      await tx`delete from user_devices where user_id::text like ${FIXTURE}`;
      await tx`delete from saved_posts where tenant_id = ${TENANT}`;
      await tx`delete from outbox_events where aggregate_id::text like ${FIXTURE}`;
      await tx`delete from posts where tenant_id = ${TENANT}`;
      await tx`delete from tenant_categories where tenant_id = ${TENANT}`;
      await tx`delete from tenant_members where tenant_id = ${TENANT}`;
      await tx`delete from tenant_settings where tenant_id = ${TENANT}`;
    });
    await admin`delete from category_field_schemas where category_id::text like ${FIXTURE}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from user_profiles where user_id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();
    for (let n = 1; n <= 9; n += 1) {
      await admin`
        insert into users (id, phone_e164, phone_verified_at, email, email_verified_at, preferred_locale)
        values (${U(n)}, ${`+88017560000${n}0`}, now(), ${`user${n}@chat.test`}, now(), ${n === 9 ? 'en' : 'bn'})`;
    }
    await admin`insert into partners (id, legal_name, display_name, phone_e164)
                values (${PARTNER}, 'Notify Partner', 'Notify Partner', '+8801756000099')`;
    await admin`insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release)
                values (${AREA}, 3, 'upazila', 'notify-e2e', 'Notify', 'fixture')`;
    await admin`insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code, timezone)
                values (${TENANT}, ${PARTNER}, ${AREA}, 'notify-e2e', 'নোটিফাই', 'Notify', st_point(91.3, 22.3)::geography, 'active', 'Asia/Dhaka')`;
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'platform_admin', true)`;
      await tx`insert into tenant_settings (tenant_id, post_moderation_mode_code, setting_overrides)
               values (${TENANT}, 'post', ${tx.json({
                 notification_daily_cap: 4,
                 notification_type_daily_caps: { post_approved: 2 },
               })})`;
    });
    for (let n = 1; n <= 9; n += 1) {
      await admin`insert into tenant_members (id, tenant_id, user_id, role_code) values (${M(n)}, ${TENANT}, ${U(n)}, 'member')`;
      await admin`insert into user_devices (user_id, platform_code, push_token)
                  values (${U(n)}, 'android', ${`fcm-user-${n}`})`;
    }
    await admin`insert into categories (id, kind_code, slug, name_bn, name_en, default_moderation_mode_code, default_post_expiry_days)
                values (${CATEGORY}, 'marketplace', 'notify-e2e-sale', 'বিক্রি', 'Sale', 'post', 30)`;
    await admin`insert into category_field_schemas (id, category_id, version, json_schema, status_code, published_at)
                values (${SCHEMA}, ${CATEGORY}, 1, '{}'::jsonb, 'published', now())`;
    await admin`insert into tenant_categories (tenant_id, category_id, is_enabled) values (${TENANT}, ${CATEGORY}, true)`;
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`insert into posts (id, tenant_id, author_member_id, category_id, field_schema_id, title, status_code,
                                  published_at, expires_at, location, fields)
               values (${POST}, ${TENANT}, ${M(1)}, ${CATEGORY}, ${SCHEMA}, 'স্যামসাং গ্যালাক্সি', 'live', now(),
                       now() + interval '20 days', st_point(91.3, 22.3)::geography, '{}'::jsonb)`;
    });

    const smsProvider: SmsProvider = {
      send: (to, text) => {
        sms.push({ to, text });
        return Promise.resolve();
      },
    };
    moduleRef = await Test.createTestingModule({ imports: [AppModule, NotificationsWorkerModule] })
      .overrideProvider(PUSH_PROVIDER)
      .useValue(push)
      .overrideProvider(SMS_PROVIDER)
      .useValue(smsProvider)
      .overrideProvider(MailService)
      .useValue({
        send: (to: string, _template: string, params: Record<string, string>) => {
          mail.push({ to, params });
          return Promise.resolve();
        },
      })
      // No queue consumer and no repeat schedule: the test drives each step.
      .overrideProvider(NotificationsProcessor)
      .useValue({})
      .overrideProvider(NotificationsSchedule)
      .useValue({})
      .compile();
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
    dispatcher = moduleRef.get(NotificationDispatcher);
    queue = moduleRef.get(getQueueToken(QUEUE_NOTIFICATIONS));
    const signer = moduleRef.get(TokenService);
    for (let n = 1; n <= 9; n += 1) {
      tokens[n] = await signer.signAccessToken({
        userId: U(n),
        tenantId: TENANT,
        memberId: M(n),
        role: 'member',
      });
    }
  }, 120_000);

  afterAll(async () => {
    try {
      const ours = (await queue.getJobs(['waiting', 'delayed', 'prioritized'])).filter((j) =>
        JSON.stringify(j.data).includes(P),
      );
      await Promise.all(ours.map((j) => j.remove()));
      await app.close();
      await cleanUp();
    } finally {
      await admin.end();
    }
  }, 60_000);

  // ---- templates ---------------------------------------------------------------

  it('renders the inbox text from the Bengali template, numbers in Bengali digits', async () => {
    await dispatcher.dispatch(
      notify(1, { type: 'saved_search_match', params: { name: 'মিরপুরে ফ্ল্যাট', count: '12' } }),
      NOON,
    );
    const [row] = await rows(1);
    expect(row).toMatchObject({
      title: 'নতুন বিজ্ঞাপন',
      body: '"মিরপুরে ফ্ল্যাট" খোঁজে ১২টি নতুন ফলাফল।',
    });
    const inbox = await call('GET', '/notifications', 1);
    expect(
      inbox.json<{ items: { title: string; body: string; count: number }[] }>().items[0],
    ).toMatchObject({
      title: 'নতুন বিজ্ঞাপন',
      count: 1,
    });
  });

  it('renders in the user’s own locale, and a reason code in words', async () => {
    await dispatcher.dispatch(
      notify(9, {
        type: 'post_removed',
        params: { postTitle: 'Old bike', reasonCode: 'spam', reasonText: null },
      }),
      NOON,
    );
    await dispatcher.dispatch(
      notify(2, {
        type: 'post_removed',
        params: { postTitle: 'পুরনো সাইকেল', reasonCode: 'spam', reasonText: null },
      }),
      NOON,
    );
    expect((await rows(9))[0]!.body).toBe('"Old bike" was removed. Reason: spam.');
    expect((await rows(2))[0]!.body).toBe('"পুরনো সাইকেল" সরিয়ে দেওয়া হয়েছে। কারণ: স্প্যাম।');
  });

  it('one dedupe key, one notification', async () => {
    const n = notify(3, {
      type: 'store_staff_invited',
      params: { storeName: 'রহিম স্টোর' },
      dedupeKey: 'invite-1',
    });
    expect((await dispatcher.dispatch(n, NOON)).notificationId).not.toBeNull();
    expect((await dispatcher.dispatch(n, NOON)).notificationId).toBeNull();
    expect(await rows(3)).toHaveLength(1);
  });

  // ---- quiet hours -------------------------------------------------------------

  it('quiet hours hold a push until 08:00; a security notice goes at once', async () => {
    const held = await dispatcher.dispatch(
      notify(4, { type: 'post_approved', params: { postTitle: 'ফোন' } }),
      NIGHT,
    );
    expect(held).toMatchObject({ channels: ['push'], deferredUntil: MORNING });
    const urgent = await dispatcher.dispatch(
      notify(4, { type: 'ban_issued', params: { reasonCode: 'spam' } }),
      NIGHT,
    );
    expect(urgent.channels).toEqual(['push', 'sms']);
    expect(urgent.deferredUntil).toBeNull();

    const [pushHeld, pushNow, smsNow] = await deliveries(4);
    expect(pushHeld).toMatchObject({
      channel_code: 'push',
      status_code: 'queued',
      scheduled_for: MORNING,
    });
    expect(pushNow).toMatchObject({ channel_code: 'push', scheduled_for: null });
    expect(smsNow).toMatchObject({ channel_code: 'sms', scheduled_for: null });
    // The held push is a delayed job; the urgent ones are waiting to run now.
    const job = await queue.getJob(`deliver-${pushHeld!.id}`);
    expect(await job!.getState()).toBe('delayed');
    expect(job!.opts.delay).toBe(MORNING.getTime() - NIGHT.getTime());
    expect(await (await queue.getJob(`deliver-${smsNow!.id}`))!.getState()).toBe('waiting');

    // The urgent SMS goes now, in Bengali, billed to the tenant.
    expect(await dispatcher.deliver(smsNow!.id)).toBe('sent');
    expect(sms.at(-1)!.text).toBe(
      'আমার এলাকা: আপনার অ্যাকাউন্টে নিষেধাজ্ঞা দেওয়া হয়েছে। কারণ: স্প্যাম। অ্যাপে আপিল করতে পারেন।',
    );
    const [billed] = await admin<
      { billed_tenant_id: string; sms_segments: number; recipient_masked: string }[]
    >`
      select billed_tenant_id, sms_segments, recipient_masked from notification_deliveries where id = ${smsNow!.id}`;
    expect(billed).toMatchObject({ billed_tenant_id: TENANT, sms_segments: 2 });
    expect(billed!.recipient_masked).toMatch(/^\+8801•+\d{3}$/);
  });

  // ---- caps ----------------------------------------------------------------------

  it('past a cap a notification stays in the inbox only; urgent types are never capped', async () => {
    const approved = () =>
      dispatcher.dispatch(notify(5, { type: 'post_approved', params: { postTitle: 'ফোন' } }), NOON);
    expect((await approved()).channels).toEqual(['push']);
    expect((await approved()).channels).toEqual(['push']);
    expect(await approved()).toMatchObject({ channels: [], capped: true }); // post_approved: 2 a day
    const place = () =>
      dispatcher.dispatch(
        notify(5, { type: 'place_approved', params: { placeName: 'দোকান' } }),
        NOON,
      );
    expect((await place()).channels).toEqual(['push']);
    expect((await place()).channels).toEqual(['push']); // 4 interruptions today: the daily cap
    expect(await place()).toMatchObject({ channels: [], capped: true });
    expect(
      (await dispatcher.dispatch(notify(5, { type: 'ban_issued', params: {} }), NOON)).capped,
    ).toBe(false);
    expect(await rows(5)).toHaveLength(7); // every one is in the inbox
  });

  // ---- collapse ------------------------------------------------------------------

  it('collapses messages inside the window into one ("৩টি নতুন মেসেজ")', async () => {
    for (const [i, conversation] of ['c-1', 'c-2', 'c-1'].entries()) {
      await dispatcher.dispatch(
        notify(6, {
          type: 'new_message',
          params: { conversationId: conversation, senderName: 'করিম' },
          deepLink: `/chat/${conversation}`,
          dedupeKey: `chat:${conversation}:m${i}`,
          collapse: { key: 'new_message', deepLink: '/chat' },
        }),
        new Date(NOON.getTime() + i * 60_000),
      );
    }
    const all = await rows(6);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      collapse_count: 3,
      title: '৩টি নতুন মেসেজ',
      body: 'আপনার চ্যাটে নতুন মেসেজ এসেছে।',
    });
    // Past the window: a new notification.
    await dispatcher.dispatch(
      notify(6, { type: 'new_message', params: { senderName: 'করিম' }, dedupeKey: 'chat:c-3:m0' }),
      new Date(NOON.getTime() + 3 * 60 * 60_000),
    );
    expect(await rows(6)).toHaveLength(2);
    expect((await rows(6))[1]!.title).toBe('নতুন মেসেজ');
  });

  it('in quiet hours, collapsed events ride on the one held push', async () => {
    for (let i = 0; i < 3; i += 1) {
      await dispatcher.dispatch(
        notify(7, { type: 'new_message', params: {}, dedupeKey: `chat:q:${i}` }),
        new Date(NIGHT.getTime() + i * 60_000),
      );
    }
    expect((await deliveries(7)).filter((d) => d.channel_code === 'push')).toHaveLength(1);
    // At 08:00 it says how many.
    const [held] = await deliveries(7);
    push.sent.length = 0;
    expect(await dispatcher.deliver(held!.id)).toBe('sent');
    expect(push.sent[0]).toMatchObject({ title: '৩টি নতুন মেসেজ', collapseKey: 'new_message' });
  });

  // ---- invalid FCM tokens ----------------------------------------------------------

  it('removes a token FCM reports dead; a push no device took is undeliverable', async () => {
    await admin`insert into user_devices (user_id, platform_code, push_token) values
      (${U(8)}, 'ios', ${TOKENS.dead}), (${U(8)}, 'web', ${TOKENS.alive})`;
    await dispatcher.dispatch(
      notify(8, { type: 'post_approved', params: { postTitle: 'ফোন' } }),
      NOON,
    );
    const [first] = await deliveries(8);
    expect(await dispatcher.deliver(first!.id)).toBe('sent');
    const tokensLeft = async () =>
      (
        await admin<{ push_token: string | null }[]>`
        select push_token from user_devices where user_id = ${U(8)} order by push_token nulls first`
      ).map((r) => r.push_token);
    expect(await tokensLeft()).toEqual([null, TOKENS.alive, 'fcm-user-8']);
    expect((await rows(8))[0]!.channels_sent).toEqual(['in_app', 'push']);

    // Every remaining token dies: nothing to retry.
    push.dead.add(TOKENS.alive).add('fcm-user-8');
    await dispatcher.dispatch(
      notify(8, { type: 'place_approved', params: { placeName: 'দোকান' } }),
      NOON,
    );
    const [, second] = await deliveries(8);
    expect(await dispatcher.deliver(second!.id)).toBe('undeliverable');
    expect((await tokensLeft()).every((t) => t === null)).toBe(true);
    expect((await deliveries(8))[1]).toMatchObject({ status_code: 'undeliverable' });
    // A later notification finds no device: in-app only.
    expect(
      (
        await dispatcher.dispatch(
          notify(8, { type: 'post_approved', params: { postTitle: 'আরেকটা' } }),
          NOON,
        )
      ).channels,
    ).toEqual([]);
  });

  // ---- preferences and SMS -------------------------------------------------------------

  it('preferences: per type and channel, with locked ones refused', async () => {
    const get = await call('GET', '/me/notification-preferences', 3);
    const items = get.json<{
      items: { type: string; channels: { channel: string; enabled: boolean; locked: boolean }[] }[];
    }>().items;
    const chat = items.find((i) => i.type === 'new_message')!;
    expect(chat.channels).toEqual([
      { channel: 'in_app', enabled: true, locked: true },
      { channel: 'push', enabled: true, locked: false },
      { channel: 'email', enabled: false, locked: false },
    ]);
    expect(items.find((i) => i.type === 'ban_issued')!.channels.every((c) => c.locked)).toBe(true);
    expect(items.some((i) => i.type.startsWith('geo_budget'))).toBe(false); // platform staff only

    // No SMS for chat, whatever the user asks; push off for chat works.
    expect(
      (
        await call('PUT', '/me/notification-preferences', 3, {
          items: [{ type: 'new_message', channel: 'sms', enabled: true }],
        })
      ).json(),
    ).toMatchObject({
      error: 'NOTIFICATION_PREFERENCE_LOCKED',
    });
    expect(
      (
        await call('PUT', '/me/notification-preferences', 3, {
          items: [{ type: 'ban_issued', channel: 'push', enabled: false }],
        })
      ).statusCode,
    ).toBe(422);
    const off = await call('PUT', '/me/notification-preferences', 3, {
      items: [
        { type: 'new_message', channel: 'push', enabled: false },
        { type: 'new_message', channel: 'email', enabled: true },
      ],
    });
    expect(off.statusCode).toBe(200);
    const result = await dispatcher.dispatch(
      notify(3, { type: 'new_message', params: {}, dedupeKey: 'pref-1' }),
      NOON,
    );
    expect(result.channels).toEqual(['email']);
    const email = (await deliveries(3)).find((d) => d.channel_code === 'email')!;
    expect(await dispatcher.deliver(email.id)).toBe('sent');
    expect(mail.at(-1)).toMatchObject({
      to: 'user3@chat.test',
      params: { subject: 'নতুন মেসেজ', heading: 'নতুন মেসেজ' },
    });
  });

  it('registers a device token, moving it from another user', async () => {
    expect(
      (await call('PUT', '/me/devices/push-token', 2, { platform: 'web', token: 'fcm-user-1' }))
        .statusCode,
    ).toBe(204);
    const owners = await admin<
      { user_id: string }[]
    >`select user_id from user_devices where push_token = 'fcm-user-1'`;
    expect(owners).toEqual([{ user_id: U(2) }]);
    expect(
      (await call('DELETE', '/me/devices/push-token', 2, { token: 'fcm-user-1' })).statusCode,
    ).toBe(204);
    expect(await admin`select 1 from user_devices where push_token = 'fcm-user-1'`).toHaveLength(0);
  });

  // ---- pending since week 5: the price drop ------------------------------------------------

  it('a price drop reaches everyone who saved the post, never the seller', async () => {
    await admin`insert into saved_posts (tenant_id, user_id, post_id) values
      (${TENANT}, ${U(2)}, ${POST}), (${TENANT}, ${U(1)}, ${POST})`;
    await admin`insert into outbox_events (aggregate_table, aggregate_id, event_type, payload)
                values ('posts', ${POST}, 'post.price_dropped',
                        ${admin.json({ tenantId: TENANT, actorUserId: U(1), from: '15000.00', to: '12500.00' })})`;
    const relay = moduleRef.get(NotificationOutboxRelay);
    expect((await relay.relay({ batchSize: 50, maxBatches: 1 })).rows).toBe(1);
    expect(await drain(1)).toBe(0); // the seller saved their own post: nothing
    expect(await drain(2)).toBe(1);
    const drop = (await rows(2)).find((r) => r.type_code === 'saved_post_price_drop')!;
    expect(drop).toMatchObject({
      title: 'দাম কমেছে',
      body: '"স্যামসাং গ্যালাক্সি" এর দাম ৳১৫,০০০ থেকে কমে ৳১২,৫০০ হয়েছে।',
    });
    const [event] = await admin<{ processed_at: Date | null }[]>`
      select processed_at from outbox_events where aggregate_id = ${POST} and event_type = 'post.price_dropped'`;
    expect(event!.processed_at).not.toBeNull();
  });

  it('import finished, with Bengali counts', async () => {
    await dispatcher.dispatch(
      notify(2, {
        type: 'store_import_finished',
        params: {
          storeName: 'রহিম স্টোর',
          created: '48',
          failed: '2',
          skipped: '0',
          importFailed: null,
        },
      }),
      NOON,
    );
    const row = (await rows(2)).find((r) => r.type_code === 'store_import_finished')!;
    expect(row.body).toBe(
      '"রহিম স্টোর" দোকানে ৪৮টি পণ্য যোগ হয়েছে। ২টি যোগ হয়নি, রিপোর্ট দেখুন।',
    );
  });
});
