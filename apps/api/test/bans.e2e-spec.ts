import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { BanStateService } from '../src/auth/ban-state.service';
import { SMS_PROVIDER, type SmsProvider } from '../src/auth/otp/sms/sms-provider.interface';
import { TokenService } from '../src/auth/tokens/token.service';
import { BansJobsService } from '../src/bans/bans-jobs.service';
import { CacheService } from '../src/cache/cache.service';
import type { AppRole } from '../src/database/tenant-context';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';
import { startNotificationWorker, type NotificationWorker } from './support/notification-worker';

/**
 * Bans and appeals end to end (ADR 063, the Q15b decision) over HTTP, on
 * real Postgres + Redis. The five guarantees asked for:
 *   - a banned user reaches the appeal endpoints and nothing else;
 *   - a terminated user can appeal without a session (OTP, no token);
 *   - a tenant admin cannot write the global blacklist (only recommend);
 *   - an appeal escalates to the platform after the window;
 *   - a blacklisted phone is blocked at sign-up in another area.
 * Plus: restricted can browse but not post; the notice names the area, the
 * reference and the reason code, never the internal text.
 */

const P = '0191e3a0-7e5e-7000-8000-';
const FIXTURE = `${P}%`;
const PARTNER = `${P}000000000001`;
const AREA_A = `${P}000000000011`;
const AREA_B = `${P}000000000012`;
const TENANT_A = `${P}000000000021`;
const TENANT_B = `${P}000000000022`;
const DEVICE = 'b'.repeat(64);

type Who = 'banned' | 'restricted' | 'term' | 'mod' | 'admin' | 'platform';
const PEOPLE: Record<Who, { user: string; member: string; role: AppRole; phone: string }> = {
  banned: {
    user: `${P}000000000031`,
    member: `${P}000000000041`,
    role: 'member',
    phone: '+8801881000001',
  },
  restricted: {
    user: `${P}000000000032`,
    member: `${P}000000000042`,
    role: 'member',
    phone: '+8801881000002',
  },
  term: {
    user: `${P}000000000033`,
    member: `${P}000000000043`,
    role: 'member',
    phone: '+8801881000003',
  },
  mod: {
    user: `${P}000000000034`,
    member: `${P}000000000044`,
    role: 'moderator',
    phone: '+8801881000004',
  },
  admin: {
    user: `${P}000000000035`,
    member: `${P}000000000045`,
    role: 'tenant_admin',
    phone: '+8801881000005',
  },
  platform: {
    user: `${P}000000000036`,
    member: `${P}000000000046`,
    role: 'platform_admin',
    phone: '+8801881000006',
  },
};
const NEW_PHONE = '+8801881000099';
const EVIDENCE = [{ type: 'report', id: `${P}000000000099` }];

class FakeSmsProvider implements SmsProvider {
  sent: { phoneE164: string; message: string }[] = [];
  send(phoneE164: string, message: string): Promise<void> {
    this.sent.push({ phoneE164, message });
    return Promise.resolve();
  }
  lastCodeFor(phone: string): string {
    const entry = [...this.sent].reverse().find((item) => item.phoneE164 === phone);
    const code = entry && /\d{4,8}/.exec(entry.message)?.[0];
    if (!code) throw new Error(`no OTP was sent to ${phone}`);
    return code;
  }
}

jest.setTimeout(30_000);

describe('Bans and appeals (e2e)', () => {
  let admin: Sql;
  let app: NestFastifyApplication;
  let module: TestingModule;
  let worker: NotificationWorker;
  let sms: FakeSmsProvider;
  const tokens = {} as Record<Who, string>;

  // OTP limits are per IP too: each call comes from its own address.
  let ip = 0;
  const call = async (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    as: Who | null,
    body?: unknown,
    tenant: string | null = TENANT_A,
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      remoteAddress: `10.9.${Math.floor(++ip / 250)}.${ip % 250}`,
      headers: {
        ...(tenant ? { 'x-tenant-id': tenant } : {}),
        ...(as ? { authorization: `Bearer ${tokens[as]}` } : {}),
      },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });

  const otpLogin = async (phone: string, tenant: string, fingerprintHash?: string) => {
    await clearCooldown(phone);
    expect((await call('POST', '/auth/otp/request', null, { phone }, tenant)).statusCode).toBe(202);
    return call(
      'POST',
      '/auth/otp/verify',
      null,
      {
        phone,
        code: sms.lastCodeFor(phone),
        device: { platformCode: 'android', ...(fingerprintHash ? { fingerprintHash } : {}) },
      },
      tenant,
    );
  };

  /** What waiting out the cooldown (and, across reruns, a new day) would do. */
  const clearCooldown = async (phone: string) => {
    await module.get(CacheService).del(`otp:cooldown:${phone}`);
    await module.get(CacheService).del(`otp:daily:phone:${phone}`);
  };

  async function cleanUp(): Promise<void> {
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      const users = tx`select id from users where id::text like ${FIXTURE} or phone_e164 = ${NEW_PHONE}`;
      await tx`delete from ban_appeals where user_id in (${users})`;
      for (const table of [
        'moderation_actions',
        'complaints',
        'bans',
        'member_trust_scores',
        'tenant_members',
      ]) {
        await tx.unsafe(`delete from ${table} where tenant_id::text like $1`, [FIXTURE]);
      }
      await tx`delete from blacklist_entries where user_id in (${users}) or recommended_by_user_id in (${users})`;
      await tx`delete from auth_refresh_tokens where user_id in (${users})`;
      await tx`delete from user_devices where user_id in (${users})`;
      await tx`delete from notification_deliveries where user_id in (${users})`;
      await tx`delete from notifications where user_id in (${users})`;
      await tx`delete from tenant_members where user_id in (${users})`;
      await tx`delete from user_profiles where user_id in (${users})`;
      await tx`delete from users where id in (${users})`;
    });
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();
    for (const [who, person] of Object.entries(PEOPLE) as [Who, (typeof PEOPLE)[Who]][]) {
      await admin`insert into users (id, phone_e164, phone_verified_at, platform_role_code)
                  values (${person.user}, ${person.phone}, now(), ${who === 'platform' ? 'platform_admin' : null})`;
      await admin`insert into user_profiles (user_id, display_name) values (${person.user}, ${`ban e2e ${who}`})`;
    }
    await admin`insert into partners (id, legal_name, display_name, phone_e164)
                values (${PARTNER}, 'Ban Partner', 'Ban Partner', '+8801881000098')`;
    await admin`insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
      (${AREA_A}, 3, 'upazila', 'ban-e2e-a', 'Ban A', 'fixture'),
      (${AREA_B}, 3, 'upazila', 'ban-e2e-b', 'Ban B', 'fixture')`;
    await admin`insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
      (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'ban-e2e-a', 'নিষেধ-এলাকা', 'Ban Area', st_point(89.1, 22.7)::geography, 'active'),
      (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'ban-e2e-b', 'অন্য এলাকা', 'Other Area', st_point(89.3, 22.7)::geography, 'active')`;
    for (const [who, person] of Object.entries(PEOPLE) as [Who, (typeof PEOPLE)[Who]][]) {
      if (who === 'platform') continue;
      await admin`insert into tenant_members (id, tenant_id, user_id, role_code)
                  values (${person.member}, ${TENANT_A}, ${person.user}, ${person.role})`;
    }
    await admin`insert into user_devices (user_id, platform_code, fingerprint_hash) values (${PEOPLE.term.user}, 'android', ${DEVICE})`;

    sms = new FakeSmsProvider();
    module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SMS_PROVIDER)
      .useValue(sms)
      .compile();
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
      // A previous run's cached ban state outlives the rows cleanUp() removed.
      await module.get(BanStateService).invalidate(person.user);
      tokens[who] = await signer.signAccessToken({
        userId: person.user,
        tenantId: TENANT_A,
        memberId: person.member,
        role: person.role,
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

  const issue = (who: Who, severity: 'restricted' | 'banned') =>
    call('POST', '/bans', 'mod', {
      userId: PEOPLE[who].user,
      severity,
      reasonCode: 'scam',
      reasonText: 'took advance payment, never delivered',
      evidence: EVIDENCE,
    });

  describe('a banned user reaches the appeal endpoints and nothing else', () => {
    let reference = '';

    it('the ban bites on the very next request', async () => {
      expect((await call('GET', '/notifications', 'banned')).statusCode).toBe(200);
      const issued = await issue('banned', 'banned');
      expect(issued.statusCode).toBe(201);
      reference = issued.json<{ reference: string }>().reference;
      expect(reference).toMatch(/^BN-/);

      for (const [method, url] of [
        ['GET', '/notifications'],
        ['GET', '/saved'],
        ['GET', '/feed?lat=22.7&lng=89.1'],
        ['POST', '/posts'],
        ['GET', '/complaints/mine'],
      ] as const) {
        const response = await call(method, url, 'banned', method === 'POST' ? {} : undefined);
        expect({
          url,
          status: response.statusCode,
          error: response.json<{ error: string }>().error,
        }).toEqual({
          url,
          status: 403,
          error: 'ACCOUNT_BANNED',
        });
      }
    });

    it('the notice says why, how long, which area and the reference — never the internal text', async () => {
      const notices = await call('GET', '/account/bans', 'banned');
      expect(notices.statusCode).toBe(200);
      const [notice] = notices.json<{ items: Record<string, unknown>[] }>().items;
      expect(notice).toMatchObject({
        kind: 'area',
        reference,
        severity: 'banned',
        reasonCode: 'scam',
        areaName: { bn: 'নিষেধ-এলাকা', en: 'Ban Area' },
        permanent: false,
        canAppeal: true,
      });
      expect(JSON.stringify(notices.json())).not.toContain('never delivered');
      expect((await call('GET', '/auth/me', 'banned')).statusCode).toBe(200);
    });

    it('appeals in-app; the area admins get it; a second appeal is refused', async () => {
      const [notice] = (await call('GET', '/account/bans', 'banned')).json<{
        items: { id: string }[];
      }>().items;
      const appealed = await call('POST', '/account/appeals', 'banned', {
        targetId: notice!.id,
        statement: 'আমি টাকা ফেরত দিয়েছি',
      });
      expect(appealed.statusCode).toBe(201);
      expect(appealed.json<{ reference: string }>().reference).toMatch(/^AP-/);
      const again = await call('POST', '/account/appeals', 'banned', {
        targetId: notice!.id,
        statement: 'again',
      });
      expect(again.json()).toMatchObject({
        error: 'APPEAL_NOT_ALLOWED',
        details: { reason: 'already_appealed' },
      });
      const mine = await call('GET', '/account/appeals', 'banned');
      expect(mine.json<{ items: { status: string }[] }>().items[0]!.status).toBe('submitted');
      const queue = await call('GET', '/appeals/queue', 'admin');
      expect(
        queue
          .json<{ items: { reference: string; reasonText: string }[] }>()
          .items.map((a) => a.reasonText),
      ).toContain('took advance payment, never delivered');
      // Moderators issue bans but don't hear appeals.
      expect((await call('GET', '/appeals/queue', 'mod')).statusCode).toBe(403);
    });

    it('signing in again gives the appeal-only scope; once the ban ends, a refresh restores the session', async () => {
      const login = await otpLogin(PEOPLE.banned.phone, TENANT_A);
      expect(login.statusCode).toBe(200);
      const session = login.json<{
        accessToken: string;
        refreshToken: string;
        accountState: string;
      }>();
      expect(session.accountState).toBe('banned');
      const claims = JSON.parse(
        Buffer.from(session.accessToken.split('.')[1]!, 'base64url').toString(),
      ) as { scope: string[] };
      expect(claims.scope).toEqual(['appeal:read', 'appeal:write', 'account:read']);
      const scoped = (url: string) =>
        app.inject({
          method: 'GET',
          url: `/api/v1${url}`,
          headers: { 'x-tenant-id': TENANT_A, authorization: `Bearer ${session.accessToken}` },
        });
      expect((await scoped('/notifications')).json()).toMatchObject({ error: 'ACCOUNT_BANNED' });

      // The area's admin grants the appeal: the scoped token now answers 401, the
      // client refreshes, and the new token is a full one.
      const [appeal] = (await call('GET', '/appeals/queue', 'admin')).json<{
        items: { id: string }[];
      }>().items;
      expect(
        (
          await call('POST', `/appeals/${appeal!.id}/decision`, 'admin', {
            decision: 'grant',
            note: 'refund proven',
          })
        ).json(),
      ).toMatchObject({
        status: 'granted',
      });
      expect((await scoped('/notifications')).statusCode).toBe(401);
      const refreshed = await call('POST', '/auth/refresh', null, {
        refreshToken: session.refreshToken,
      });
      expect(refreshed.json<{ accountState: string }>().accountState).toBe('active');
      const fresh = refreshed.json<{ accessToken: string }>().accessToken;
      const after = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications',
        headers: { 'x-tenant-id': TENANT_A, authorization: `Bearer ${fresh}` },
      });
      expect(after.statusCode).toBe(200);
    });
  });

  describe('restricted: browses, cannot post, chat or review', () => {
    it('reads work; writing a post is refused', async () => {
      expect((await issue('restricted', 'restricted')).statusCode).toBe(201);
      expect((await call('GET', '/notifications', 'restricted')).statusCode).toBe(200);
      expect((await call('GET', '/account/bans', 'restricted')).statusCode).toBe(200);
      const post = await call('POST', '/posts', 'restricted', {});
      expect(post.json()).toMatchObject({ error: 'ACCOUNT_RESTRICTED' });
      const chat = await call('POST', `/stores/${P}000000000077/conversations`, 'restricted', {});
      expect(chat.json()).toMatchObject({ error: 'ACCOUNT_RESTRICTED' });
      // A ban in area A does not follow them to area B.
      const signer = module.get(TokenService);
      const elsewhere = await signer.signAccessToken({
        userId: PEOPLE.restricted.user,
        tenantId: TENANT_B,
        memberId: PEOPLE.restricted.member,
        role: 'member',
      });
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/posts',
        headers: { 'x-tenant-id': TENANT_B, authorization: `Bearer ${elsewhere}` },
        payload: {},
      });
      expect(response.json<{ error: string }>().error).not.toBe('ACCOUNT_RESTRICTED');
    });
  });

  describe('the global blacklist', () => {
    let entryId = '';

    it('a tenant admin cannot write the global blacklist — only recommend', async () => {
      const body = {
        userId: PEOPLE.term.user,
        reasonCode: 'advance_payment_scam',
        severity: 'terminated',
        summary: 'six buyers paid advance, no delivery, phone off',
        evidence: EVIDENCE,
      };
      expect((await call('POST', '/blacklist/recommendations', 'mod', body)).statusCode).toBe(403);
      const recommended = await call('POST', '/blacklist/recommendations', 'admin', body);
      expect(recommended.statusCode).toBe(201);
      entryId = recommended.json<{ id: string }>().id;
      // The platform routes refuse an area admin outright.
      expect(
        (
          await call('POST', `/platform/blacklist/${entryId}/decision`, 'admin', {
            decision: 'approve',
          })
        ).statusCode,
      ).toBe(403);
      expect((await call('GET', '/platform/blacklist', 'admin')).statusCode).toBe(403);
      const own = await call('GET', '/blacklist/recommendations', 'admin');
      expect(own.json<{ items: { id: string; status: string }[] }>().items).toEqual([
        expect.objectContaining({ id: entryId, status: 'recommended' }),
      ]);
      // Still only a recommendation: the person signs in normally.
      expect((await call('GET', '/notifications', 'term')).statusCode).toBe(200);
    });

    it('platform_admin approves: terminated everywhere, sessions gone, sign-in refused', async () => {
      const decided = await call('POST', `/platform/blacklist/${entryId}/decision`, 'platform', {
        decision: 'approve',
        note: 'evidence is clear',
      });
      expect(decided.json()).toEqual({ status: 'active' });
      expect((await call('GET', '/notifications', 'term')).json()).toMatchObject({
        error: 'ACCOUNT_TERMINATED',
      });
      expect((await call('GET', '/account/bans', 'term')).json()).toMatchObject({
        error: 'ACCOUNT_TERMINATED',
      });
      const login = await otpLogin(PEOPLE.term.phone, TENANT_B);
      expect(login.json()).toMatchObject({ error: 'ACCOUNT_TERMINATED' });
    });

    it('a terminated user can appeal without a session', async () => {
      sms.sent = [];
      await clearCooldown(PEOPLE.term.phone);
      // The same answer for a phone with nothing to appeal: no enumeration, no SMS.
      const unknown = await call(
        'POST',
        '/appeals/request-otp',
        null,
        { phone: '+8801881000077' },
        null,
      );
      const known = await call(
        'POST',
        '/appeals/request-otp',
        null,
        { phone: PEOPLE.term.phone },
        null,
      );
      expect([unknown.statusCode, known.statusCode]).toEqual([202, 202]);
      expect(unknown.body).toBe(known.body);
      expect(sms.sent.map((s) => s.phoneE164)).toEqual([PEOPLE.term.phone]);
      // That code can't sign anyone in.
      const code = sms.lastCodeFor(PEOPLE.term.phone);
      const asLogin = await call(
        'POST',
        '/auth/otp/verify',
        null,
        { phone: PEOPLE.term.phone, code, device: { platformCode: 'web' } },
        TENANT_A,
      );
      expect(asLogin.statusCode).not.toBe(200);
      const wrong = await call(
        'POST',
        '/appeals/status',
        null,
        { phone: PEOPLE.term.phone, otp: '000000' },
        null,
      );
      expect(wrong.json<{ error: string }>().error).toMatch(/^OTP_/);

      await clearCooldown(PEOPLE.term.phone);
      await call('POST', '/appeals/request-otp', null, { phone: PEOPLE.term.phone }, null);
      const status = await call(
        'POST',
        '/appeals/status',
        null,
        { phone: PEOPLE.term.phone, otp: sms.lastCodeFor(PEOPLE.term.phone) },
        null,
      );
      expect(status.statusCode).toBe(200);
      const body = status.json<{
        items: { kind: string; reference: string; canAppeal: boolean }[];
        appealToken: string;
        appealsLeftToday: number;
      }>();
      expect(body.items).toEqual([expect.objectContaining({ kind: 'platform', canAppeal: true })]);
      expect(body.appealsLeftToday).toBe(1);
      expect(status.headers['set-cookie']).toBeUndefined();

      const submitted = await call(
        'POST',
        '/appeals/submit',
        null,
        {
          phone: PEOPLE.term.phone,
          appealToken: body.appealToken,
          reference: body.items[0]!.reference,
          statement: 'ভুল মানুষ, আমার নম্বর অন্য কেউ ব্যবহার করেছে',
        },
        null,
      );
      expect(submitted.statusCode).toBe(201);
      // The token was single-use; and the global appeal sits in the platform queue.
      const replay = await call(
        'POST',
        '/appeals/submit',
        null,
        {
          phone: PEOPLE.term.phone,
          appealToken: body.appealToken,
          reference: body.items[0]!.reference,
          statement: 'again',
        },
        null,
      );
      expect(replay.json()).toMatchObject({ error: 'APPEAL_VERIFICATION_FAILED' });
      const queue = await call('GET', '/platform/appeals', 'platform');
      expect(queue.json<{ items: { kind: string; channel: string }[] }>().items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'platform', channel: 'public_otp' }),
        ]),
      );
    });

    it('a blacklisted phone is blocked at sign-up in another area; so is the device', async () => {
      // The listed account is closed and its number freed (as anonymisation does);
      // a new account on that number, in another area, is refused and not created.
      await admin`update users set deleted_at = now() where id = ${PEOPLE.term.user}`;
      const signup = await otpLogin(PEOPLE.term.phone, TENANT_B);
      expect(signup.json()).toMatchObject({ error: 'ACCOUNT_BLOCKED' });
      const [created] = await admin<{ n: number }[]>`
        select count(*)::int as n from users where phone_e164 = ${PEOPLE.term.phone} and deleted_at is null`;
      expect(created!.n).toBe(0);
      // A fresh number on the listed person's phone (device) is refused too.
      const device = await otpLogin(NEW_PHONE, TENANT_B, DEVICE);
      expect(device.json()).toMatchObject({ error: 'ACCOUNT_BLOCKED' });
      // An unrelated device signs up fine.
      const clean = await otpLogin(NEW_PHONE, TENANT_B, 'c'.repeat(64));
      expect(clean.json<{ accountState: string }>().accountState).toBe('active');
      await admin`update users set deleted_at = null where id = ${PEOPLE.term.user}`;
    });
  });

  describe('complaints', () => {
    it('a complaint is worked by the area and resolved by the ban it leads to', async () => {
      const filed = await call('POST', '/complaints', 'admin', {
        subjectType: 'user',
        subjectId: PEOPLE.term.user,
        category: 'fake_seller',
        description: 'বলেছিল নতুন ফোন, পুরোনো দিয়েছে',
      });
      expect(filed.statusCode).toBe(201);
      expect(filed.json()).toMatchObject({ priority: 'high', status: 'pending' });
      const { id } = filed.json<{ id: string }>();
      // Moderators work the queue (complaints:read); a member does not.
      expect((await call('GET', '/complaints/queue', 'banned')).statusCode).toBe(403);
      const queue = await call('GET', '/complaints/queue', 'mod');
      expect(queue.json<{ items: { id: string; subjectUserId: string }[] }>().items).toEqual(
        expect.arrayContaining([expect.objectContaining({ id, subjectUserId: PEOPLE.term.user })]),
      );
      const assignees = (await call('GET', '/complaints/assignees', 'mod')).json<{
        items: { userId: string }[];
      }>().items;
      expect(assignees.map((a) => a.userId)).toEqual(
        expect.arrayContaining([PEOPLE.mod.user, PEOPLE.admin.user]),
      );
      const assigned = await call('PATCH', `/complaints/${id}`, 'mod', {
        assigneeUserId: PEOPLE.mod.user,
        status: 'in_progress',
      });
      expect(assigned.json()).toMatchObject({
        status: 'in_progress',
        assignedToUserId: PEOPLE.mod.user,
      });
      const mine = await call('GET', '/complaints/mine', 'admin');
      expect(mine.json<{ items: { id: string; status: string }[] }>().items).toEqual([
        expect.objectContaining({ id, status: 'in_progress' }),
      ]);

      // A ban issued from the complaint resolves it.
      await admin`update users set deleted_at = null where id = ${PEOPLE.term.user}`;
      const ban = await call('POST', '/bans', 'mod', {
        userId: PEOPLE.term.user,
        severity: 'restricted',
        reasonCode: 'fake_listings',
        reasonText: 'sold a used phone as new',
        evidence: [{ type: 'complaint', id }],
        complaintId: id,
      });
      expect(ban.statusCode).toBe(201);
      const resolved = (await call('GET', '/complaints/queue?status=resolved', 'mod')).json<{
        items: { id: string; banId: string }[];
      }>().items;
      expect(resolved.find((c) => c.id === id)?.banId).toBe(ban.json<{ id: string }>().id);
    });
  });

  describe('escalation', () => {
    it('an appeal the area does not decide in time goes to the platform', async () => {
      await admin`update bans set status_code = 'revoked', revoked_at = now() where tenant_id = ${TENANT_A} and user_id = ${PEOPLE.restricted.user} and status_code = 'active'`;
      const ban = (await issue('restricted', 'restricted')).json<{ id: string }>();
      await call('POST', '/account/appeals', 'restricted', {
        targetId: ban.id,
        statement: 'please',
      });
      const inArea = (await call('GET', '/appeals/queue', 'admin')).json<{
        items: { targetId: string; id: string }[];
      }>().items;
      const appeal = inArea.find((a) => a.targetId === ban.id)!;
      expect(appeal).toBeDefined();
      await admin`update ban_appeals set escalate_at = now() - interval '1 minute' where id = ${appeal.id}`;
      const jobs = worker.module.get(BansJobsService);
      expect(await jobs.escalate({ batchSize: 100, maxBatches: 1 })).toEqual({
        rows: 1,
        capped: false,
      });
      const after = (await call('GET', '/appeals/queue', 'admin')).json<{
        items: { id: string }[];
      }>().items;
      expect(after.map((a) => a.id)).not.toContain(appeal.id);
      const platform = (await call('GET', '/platform/appeals', 'platform')).json<{
        items: { id: string; escalationReason: string }[];
      }>().items;
      expect(platform.find((a) => a.id === appeal.id)).toMatchObject({
        escalationReason: 'timeout',
      });
      // The area can no longer decide it.
      const late = await call('POST', `/appeals/${appeal.id}/decision`, 'admin', {
        decision: 'grant',
      });
      expect(late.json()).toMatchObject({
        error: 'APPEAL_DECISION_INVALID',
        details: { reason: 'not_your_queue' },
      });
      // The platform grants: the restriction is gone at once.
      const granted = await call('POST', `/platform/appeals/${appeal.id}/decision`, 'platform', {
        decision: 'grant',
        note: 'first time',
      });
      expect(granted.json()).toMatchObject({ status: 'granted' });
      expect(
        (await call('GET', '/account/bans', 'restricted')).json<{ items: unknown[] }>().items,
      ).toHaveLength(0);
    });
  });
});
