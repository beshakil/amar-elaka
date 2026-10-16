import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { SMS_PROVIDER, type SmsProvider } from '../src/auth/otp/sms/sms-provider.interface';
import { TokenService } from '../src/auth/tokens/token.service';
import { BanStateService } from '../src/auth/ban-state.service';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * Field agent mode end to end (ADR 066): a capture made offline syncs into
 * exactly one place however many times (or however concurrently) it is sent;
 * a likely duplicate stops it and asks; low-accuracy GPS and shops outside the
 * agent's area are refused; the anti-fraud flags land on the submission; the
 * agent's stats, the admin's numbers and the commission report agree.
 */

const P = '0191e3a0-a6e7-7000-8000-';
const FIXTURE = `${P}%`;
const PARTNER = `${P}000000000001`;
const AREA = `${P}000000000011`;
const AREA_B = `${P}000000000012`;
const TENANT = `${P}000000000021`;
const TENANT_B = `${P}000000000022`;
const CATEGORY = `${P}000000000051`;
const PEOPLE = {
  agent: { user: `${P}000000000031`, member: `${P}000000000041`, role: 'agent' },
  agent2: { user: `${P}000000000032`, member: `${P}000000000042`, role: 'agent' },
  admin: { user: `${P}000000000033`, member: `${P}000000000043`, role: 'tenant_admin' },
  member: { user: `${P}000000000034`, member: `${P}000000000044`, role: 'member' },
} as const;
type Who = keyof typeof PEOPLE;
const SHOP_PHONE = '+8801766000001';

const square = (west: number, east: number) =>
  `SRID=4326;MULTIPOLYGON(((${west} 20.3,${east} 20.3,${east} 20.4,${west} 20.4,${west} 20.3)))`;
// Spread the shops out so neighbouring captures don't trip the duplicate check by accident.
let lngSeq = 0;
const nextPoint = () => ({ lat: 20.35, lng: 92.41 + 0.004 * ++lngSeq });

class FakeSmsProvider implements SmsProvider {
  sent: { phoneE164: string; message: string }[] = [];
  send(phoneE164: string, message: string): Promise<void> {
    this.sent.push({ phoneE164, message });
    return Promise.resolve();
  }
}

interface Result {
  id: string;
  status: 'created' | 'needs_decision';
  placeId: string | null;
  fraudFlags: string[];
  candidates: { placeId: string }[];
}

describe('Field agent mode (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: Sql;
  let sms: FakeSmsProvider;
  const tokens: Partial<Record<Who, string>> = {};
  let agentId = '';

  async function cleanUp(): Promise<void> {
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const table of [
        'agent_submissions',
        'agent_phone_checks',
        'agent_tasks',
        'agent_visits',
        'place_edit_suggestions',
        'duplicate_candidates',
        'moderation_actions',
        'media_attachments',
        'place_hours',
        'place_revisions',
        'places',
        'media_assets',
        'field_agents',
        'tenant_categories',
        'tenant_members',
        'tenant_settings',
      ]) {
        await tx.unsafe(`delete from ${table} where tenant_id::text like $1`, [FIXTURE]);
      }
      await tx`delete from outbox_events where payload->>'tenantId' like ${FIXTURE}`;
      await tx`delete from categories where id::text like ${FIXTURE}`;
      await tx`delete from tenants where id::text like ${FIXTURE}`;
      await tx`delete from partners where id::text like ${FIXTURE}`;
      await tx`delete from geo_areas where id::text like ${FIXTURE}`;
      await tx`delete from users where id::text like ${FIXTURE}`;
    });
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();
    for (const [i, p] of Object.values(PEOPLE).entries()) {
      await admin`insert into users (id, phone_e164) values (${p.user}, ${`+88017660000${10 + i}`})`;
    }
    await admin`insert into partners (id, legal_name, display_name, phone_e164)
                values (${PARTNER}, 'Agent Partner', 'Agent Partner', '+8801766000099')`;
    await admin`
      insert into geo_areas
        (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release, boundary, boundary_simplified)
      values
        (${AREA}, 3, 'upazila', 'agents-e2e', 'Agents', 'fixture', ${square(92.4, 92.5)}, ${square(92.4, 92.5)}),
        (${AREA_B}, 3, 'upazila', 'agents-e2e-b', 'Agents B', 'fixture', ${square(92.5, 92.6)}, ${square(92.5, 92.6)})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values
        (${TENANT}, ${PARTNER}, ${AREA}, 'agents-e2e', 'এজেন্ট', 'Agents', st_point(92.45, 20.35)::geography, 'active'),
        (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'agents-e2e-b', 'বি', 'B', st_point(92.55, 20.35)::geography, 'active')`;
    for (const p of Object.values(PEOPLE)) {
      await admin`insert into tenant_members (id, tenant_id, user_id, role_code)
                  values (${p.member}, ${TENANT}, ${p.user}, ${p.role})`;
    }
    await admin`insert into categories (id, kind_code, slug, name_bn, name_en)
                values (${CATEGORY}, 'place', 'agents-e2e-grocery', 'মুদি দোকান', 'Grocery')`;
    await admin`insert into tenant_categories (tenant_id, category_id, is_enabled) values (${TENANT}, ${CATEGORY}, true)`;
    const [agent] = await admin<{ id: string }[]>`
      insert into field_agents (tenant_id, member_id, agent_code, employment_type_code, joined_on, targets)
      values (${TENANT}, ${PEOPLE.agent.member}, 'AG-1', 'commission_only', current_date, '{"daily_shops": 20}')
      returning id`;
    agentId = agent!.id;

    sms = new FakeSmsProvider();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SMS_PROVIDER)
      .useValue(sms)
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
    const signer = moduleRef.get(TokenService);
    for (const [who, p] of Object.entries(PEOPLE) as [Who, (typeof PEOPLE)[Who]][]) {
      await moduleRef.get(BanStateService).invalidate(p.user);
      tokens[who] = await signer.signAccessToken({
        userId: p.user,
        tenantId: TENANT,
        memberId: p.member,
        role: p.role,
      });
    }
  }, 120_000);

  afterAll(async () => {
    try {
      await app?.close();
      await cleanUp();
    } finally {
      await admin.end();
    }
  }, 60_000);

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, who: Who, body?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { 'x-tenant-id': TENANT, authorization: `Bearer ${tokens[who]}` },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });

  let checksum = 0;
  const photo = async (who: Who = 'agent', sum?: string): Promise<string> => {
    const id = randomUUID();
    const hash = sum ?? (++checksum).toString(16).padStart(64, '0');
    await admin`
      insert into media_assets
        (id, tenant_id, uploaded_by_user_id, kind_code, visibility_code, storage_key, mime_type, byte_size,
         checksum_sha256, status_code)
      values (${id}, ${TENANT}, ${PEOPLE[who].user}, 'image', 'public', ${`agents-e2e/${id}`}, 'image/webp', 100,
              ${hash}, 'ready')`;
    return id;
  };

  /** A capture as the phone queues it: honest by default, minutes apart. */
  let clock = Date.now() - 6 * 3_600_000;
  const capture = async (overrides: Record<string, unknown> = {}) => {
    clock += 10 * 60_000;
    const at = new Date(clock);
    const location =
      (overrides.location as { lat: number; lng: number } | undefined) ?? nextPoint();
    return {
      id: randomUUID(),
      kind: 'new_shop',
      capturedAt: at.toISOString(),
      location,
      accuracyM: 8,
      photo: { location, takenAt: new Date(clock - 60_000).toISOString() },
      photoIds: [await photo()],
      nameBn: `করিম স্টোর ${lngSeq}`,
      categoryId: CATEGORY,
      businessHours: [{ day: 1, opens: '09:00', closes: '21:00' }],
      ...overrides,
    };
  };
  const submit = async (body: unknown, who: Who = 'agent') => {
    const response = await call('POST', '/agent/submissions', who, body);
    return {
      status: response.statusCode,
      body: response.json<Result & { error?: string; details?: unknown }>(),
    };
  };
  const placesOf = (id: string) =>
    admin<{ id: string; status_code: string }[]>`
      select p.id, p.status_code from places p join agent_submissions s on s.place_id = p.id where s.id = ${id}`;

  it('gives the phone its agent profile and offline settings', async () => {
    const me = (await call('GET', '/agent/me', 'agent')).json<{
      agent: { code: string; targets: { dailyShops: number } };
      settings: { minGpsAccuracyM: number };
    }>();
    expect(me.agent).toMatchObject({ code: 'AG-1', targets: { dailyShops: 20 } });
    expect(me.settings.minGpsAccuracyM).toBe(25);
    expect((await call('GET', '/agent/me', 'agent2')).json()).toMatchObject({
      error: 'AGENT_NOT_ACTIVE',
    });
  });

  it('creates exactly one pending place per submission, however often the sync runs', async () => {
    const body = await capture();
    const first = await submit(body);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'created', fraudFlags: [] });
    // The sync retried after a lost response…
    const again = await submit(body);
    expect(again.body).toMatchObject({ status: 'created', placeId: first.body.placeId });
    // …and two syncs at once (two app instances, or a double tap).
    const twin = await capture();
    const [a, b] = await Promise.all([submit(twin), submit(twin)]);
    expect(a.body.placeId).toBe(b.body.placeId);

    for (const id of [body.id, twin.id]) {
      const made = await placesOf(id);
      expect(made).toHaveLength(1);
      expect(made[0]!.status_code).toBe('pending_review');
    }
    const visits =
      await admin`select id from agent_visits where client_visit_id in (${body.id}, ${twin.id})`;
    expect(visits).toHaveLength(2);
  });

  it('asks the agent when the shop may already be on the map, then follows the answer', async () => {
    const location = nextPoint();
    const original = await capture({ location, nameBn: 'মায়ের দোয়া স্টোর' });
    const created = await submit(original);
    // Duplicates are checked against shops people can see.
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`update places set status_code = 'published' where id = ${created.body.placeId}`;
    });

    const near = { lat: location.lat, lng: location.lng + 0.0001 };
    const dup = await capture({ location: near, nameBn: 'মায়ের দোয়া স্টোর' });
    const asked = await submit(dup);
    expect(asked.body).toMatchObject({ status: 'needs_decision', placeId: null });
    expect(asked.body.candidates.map((c) => c.placeId)).toContain(created.body.placeId);
    expect(await admin`select id from agent_submissions where id = ${dup.id}`).toHaveLength(0);

    // "It's that shop": a verification of it, no new place.
    const same = await submit({
      ...dup,
      duplicateDecision: { decision: 'same', placeId: created.body.placeId },
    });
    expect(same.body).toMatchObject({ status: 'created', placeId: created.body.placeId });
    const [row] = await admin<{ duplicate_of_place_id: string; agent_visit_id: string | null }[]>`
      select duplicate_of_place_id, agent_visit_id from agent_submissions where id = ${dup.id}`;
    expect(row).toMatchObject({ duplicate_of_place_id: created.body.placeId });
    expect(row!.agent_visit_id).not.toBeNull();

    // "A different shop": added, still once.
    const other = await capture({ location: near, nameBn: 'মায়ের দোয়া স্টোর' });
    expect((await submit(other)).body.status).toBe('needs_decision');
    const added = await submit({ ...other, duplicateDecision: { decision: 'new' } });
    expect(added.body.status).toBe('created');
    expect(added.body.placeId).not.toBe(created.body.placeId);
    expect(await placesOf(other.id)).toHaveLength(1);
  });

  it('refuses GPS worse than agent_min_gps_accuracy_m, and shops outside the area', async () => {
    const vague = await submit(await capture({ accuracyM: 60 }));
    expect(vague.status).toBe(422);
    expect(vague.body).toMatchObject({ error: 'AGENT_GPS_TOO_INACCURATE' });

    const outside = await capture({ location: { lat: 20.35, lng: 92.55 } });
    const refused = await submit(outside);
    expect(refused.body).toMatchObject({
      error: 'AGENT_SUBMISSION_REFUSED',
      details: { reason: 'outside_area' },
    });

    // Only field agents capture.
    expect((await submit(await capture(), 'member')).body).toMatchObject({
      error: 'AGENT_NOT_ACTIVE',
    });
  });

  it('flags a photo from elsewhere, rapid captures, reused photos and a failed phone check', async () => {
    const elsewhere = await capture();
    elsewhere.photo = {
      location: { lat: 20.36, lng: elsewhere.location.lng },
      takenAt: elsewhere.photo.takenAt,
    };
    expect((await submit(elsewhere)).body.fraudFlags).toContain('gps_photo_mismatch');

    // Twenty seconds after the previous capture, a kilometre on.
    const prev = await capture();
    await submit(prev);
    const quick = await capture({
      capturedAt: new Date(new Date(prev.capturedAt).getTime() + 20_000).toISOString(),
      location: { lat: prev.location.lat, lng: prev.location.lng + 0.01 },
    });
    quick.photo = { location: quick.location, takenAt: prev.capturedAt };
    const flags = (await submit(quick)).body.fraudFlags;
    expect(flags).toEqual(expect.arrayContaining(['rapid_fire', 'impossible_travel']));

    // The same picture another submission used.
    const reused = await capture({ photoIds: [await photo('agent', 'f'.repeat(64))] });
    await submit(reused);
    const copy = await capture({ photoIds: [await photo('agent', 'f'.repeat(64))] });
    expect((await submit(copy)).body.fraudFlags).toContain('duplicate_photo');

    // The shop's phone: a code is sent; a wrong one fails the check on the synced submission.
    const withPhone = await capture({ phone: SHOP_PHONE });
    await submit(withPhone);
    const sent = await call('POST', `/agent/submissions/${withPhone.id}/phone-otp`, 'agent', {
      phone: SHOP_PHONE,
    });
    expect(sent.statusCode).toBe(200);
    expect(sms.sent.at(-1)?.phoneE164).toBe(SHOP_PHONE);
    const wrong = await call(
      'POST',
      `/agent/submissions/${withPhone.id}/phone-otp/verify`,
      'agent',
      {
        phone: SHOP_PHONE,
        code: '000000',
      },
    );
    expect(wrong.json()).toMatchObject({ error: 'OTP_INCORRECT' });
    const [row] = await admin<{ fraud_flags: string[]; phone_check_status: string }[]>`
      select fraud_flags, phone_check_status from agent_submissions where id = ${withPhone.id}`;
    expect(row).toMatchObject({ phone_check_status: 'failed' });
    expect(row!.fraud_flags).toContain('phone_otp_failed');
  });

  it('keeps the capture fixed once synced', async () => {
    const body = await capture();
    await submit(body);
    const error = await admin
      .begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${TENANT}, true)`;
        await tx`select set_config('app.role', 'tenant_admin', true)`;
        await tx`update agent_submissions set accuracy_m = 1 where id = ${body.id}`;
      })
      .catch((e: { code?: string }) => e);
    expect(error).toMatchObject({ code: '42501' });
  });

  it('counts approvals and rejections with reasons into stats, the admin list and the commission report', async () => {
    const good = await capture();
    const bad = await capture();
    const g = (await submit(good)).body.placeId!;
    const b = (await submit(bad)).body.placeId!;
    expect((await call('POST', `/places/${g}/approve`, 'admin')).statusCode).toBe(200);
    expect(
      (
        await call('POST', `/places/${b}/reject`, 'admin', {
          reasonCode: 'spam',
          reasonText: 'No shop at this spot',
        })
      ).statusCode,
    ).toBe(200);

    const stats = (await call('GET', '/agent/me/stats', 'agent')).json<{
      today: { submitted: number; approved: number; rejected: number; commission: string };
      recent: {
        id: string;
        reviewStatus: string;
        reasonCode: string | null;
        reasonText: string | null;
      }[];
    }>();
    expect(stats.today.approved).toBeGreaterThanOrEqual(1);
    expect(stats.today.rejected).toBeGreaterThanOrEqual(1);
    expect(stats.recent.find((r) => r.id === bad.id)).toMatchObject({
      reviewStatus: 'rejected',
      reasonCode: 'spam',
      reasonText: 'No shop at this spot',
    });

    const list = (await call('GET', '/agents', 'admin')).json<{
      items: {
        id: string;
        today: { approved: number };
        approvalRate: number | null;
        flagged: number;
      }[];
      candidates: { memberId: string }[];
    }>();
    const mine = list.items.find((i) => i.id === agentId)!;
    expect(mine.today.approved).toBeGreaterThanOrEqual(1);
    expect(mine.approvalRate).not.toBeNull();
    expect(mine.flagged).toBeGreaterThan(0);
    expect(list.candidates.map((c) => c.memberId)).toContain(PEOPLE.agent2.member);
    expect((await call('GET', '/agents', 'agent')).json()).toMatchObject({
      error: 'AGENT_ADMIN_ONLY',
    });

    // One approved new shop (plus a "same shop" verification at 0.00) at the default 20.00.
    const today = (await call('GET', '/agent/today', 'agent')).json<{ date: string }>().date;
    const report = (
      await call('GET', `/agents/commissions?from=${today}&to=${today}`, 'admin')
    ).json<{
      items: { agentId: string; newShops: number; amount: string }[];
      total: string;
    }>();
    const row = report.items.find((i) => i.agentId === agentId)!;
    expect(row.amount).toBe((row.newShops * 20).toFixed(2));
    expect(report.total).toBe(row.amount);

    // The rate the admin sets is the agent's from then on.
    expect(
      (await call('PATCH', `/agents/${agentId}`, 'admin', { commissionRate: '25.00' })).statusCode,
    ).toBe(204);
    const after = (
      await call('GET', `/agents/commissions?from=${today}&to=${today}`, 'admin')
    ).json<{
      items: { agentId: string; newShops: number; amount: string }[];
    }>();
    const r2 = after.items.find((i) => i.agentId === agentId)!;
    expect(r2.amount).toBe((r2.newShops * 25).toFixed(2));

    const day = (await call('GET', '/agents/submissions', 'admin')).json<{
      items: { id: string; location: { lat: number }; reviewStatus: string }[];
    }>();
    expect(day.items.find((i) => i.id === good.id)).toMatchObject({ reviewStatus: 'approved' });
  });

  it('assigns tasks, shows them on the route, and marks one done by its submission', async () => {
    const created = await call('POST', `/agents/${agentId}/tasks`, 'admin', {
      type: 'map_shop',
      title: 'বাজার রোডের দোকানগুলো',
      location: nextPoint(),
      dueOn: new Date().toISOString().slice(0, 10),
    });
    expect(created.statusCode).toBe(201);
    const taskId = created.json<{ id: string }>().id;
    const before = (await call('GET', '/agent/today', 'agent')).json<{
      tasks: { id: string; status: string }[];
      remaining: number;
    }>();
    expect(before.tasks.map((t) => t.id)).toContain(taskId);

    await submit(await capture({ taskId }));
    const after = (await call('GET', '/agent/today', 'agent')).json<{
      tasks: { id: string; status: string }[];
      done: number;
      remaining: number;
    }>();
    expect(after.tasks.find((t) => t.id === taskId)?.status).toBe('done');
    expect(after.remaining).toBe(before.remaining - 1);
  });
});
