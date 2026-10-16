import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { SettingsService } from '../src/settings/settings.service';
import { BanStateService } from '../src/auth/ban-state.service';
import { TokenService } from '../src/auth/tokens/token.service';
import type { AppRole } from '../src/database/tenant-context';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';
import { startNotificationWorker, type NotificationWorker } from './support/notification-worker';

/**
 * The info engine end to end (ADR 065) over HTTP: every type's list is the
 * same card; outages show once enough neighbours report; a member's
 * janaza notice and lost & found report wait for a moderator; the
 * reporter's number leaves only through the tracked contact; the partner
 * keeps transport (next departures), the versioned gov guide and outages;
 * directories list places with the 24-hour flag; prayer settings; the agri
 * board only where enabled; the feed carries info and prayer cards.
 */

const P = '0191e3a0-1f0f-7000-8000-';
const FIXTURE = `${P}%`;
const PARTNER = `${P}000000000001`;
const AREA = `${P}000000000011`;
const TENANT = `${P}000000000021`;
const CATEGORY = `${P}000000000031`;
const PLACE = `${P}000000000032`;

type Who = 'm1' | 'm2' | 'm3' | 'agent' | 'admin';
const PEOPLE: Record<Who, { user: string; member: string; role: AppRole; phone: string }> = {
  m1: {
    user: `${P}000000000041`,
    member: `${P}000000000051`,
    role: 'member',
    phone: '+8801892000001',
  },
  m2: {
    user: `${P}000000000042`,
    member: `${P}000000000052`,
    role: 'member',
    phone: '+8801892000002',
  },
  m3: {
    user: `${P}000000000043`,
    member: `${P}000000000053`,
    role: 'member',
    phone: '+8801892000003',
  },
  agent: {
    user: `${P}000000000044`,
    member: `${P}000000000054`,
    role: 'agent',
    phone: '+8801892000004',
  },
  admin: {
    user: `${P}000000000045`,
    member: `${P}000000000055`,
    role: 'tenant_admin',
    phone: '+8801892000005',
  },
};
const CENTER = { lat: 23.72, lng: 90.41 };

jest.setTimeout(30_000);

interface Card {
  type: string;
  id: string;
  badges: string[];
  isStale: boolean;
  title: { bn: string | null };
}

describe('Info engine (e2e)', () => {
  let admin: Sql;
  let app: NestFastifyApplication;
  let module: TestingModule;
  let worker: NotificationWorker;
  const tokens = {} as Record<Who, string>;

  let ip = 0;
  const call = async (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    as: Who | null,
    body?: unknown,
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      remoteAddress: `10.7.${Math.floor(++ip / 250)}.${ip % 250}`,
      headers: { 'x-tenant-id': TENANT, ...(as ? { authorization: `Bearer ${tokens[as]}` } : {}) },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });
  const near = `lat=${CENTER.lat}&lng=${CENTER.lng}`;
  const cards = async (url: string, as: Who | null = null) =>
    (await call('GET', url, as)).json<{ items: Card[] }>().items;

  async function cleanUp(): Promise<void> {
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      const users = tx`select id from users where id::text like ${FIXTURE}`;
      for (const table of [
        'moderation_actions',
        'reports',
        'lead_events',
        'media_attachments',
        'notices',
        'lost_found_items',
        'outage_reports',
        'utility_outages',
        'gov_service_versions',
        'gov_services',
        'transport_schedules',
        'transport_route_stops',
        'transport_routes',
        'place_hours',
        'place_revisions',
        'places',
        'tenant_members',
        'tenant_settings',
      ]) {
        await tx.unsafe(`delete from ${table} where tenant_id::text like $1`, [FIXTURE]);
      }
      await tx`delete from categories where id::text like ${FIXTURE}`;
      await tx`delete from notification_deliveries where user_id in (${users})`;
      await tx`delete from notifications where user_id in (${users})`;
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
      await admin`insert into users (id, phone_e164, phone_verified_at) values (${person.user}, ${person.phone}, now())`;
      await admin`insert into user_profiles (user_id, display_name) values (${person.user}, ${`engine ${who}`})`;
    }
    await admin`insert into partners (id, legal_name, display_name, phone_e164)
                values (${PARTNER}, 'Engine Partner', 'Engine Partner', '+8801892000098')`;
    await admin`insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release)
                values (${AREA}, 3, 'upazila', 'engine-e2e', 'Engine Area', 'fixture')`;
    await admin`insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
                values (${TENANT}, ${PARTNER}, ${AREA}, 'engine-e2e', 'ইঞ্জিন', 'Engine',
                        st_point(${CENTER.lng}, ${CENTER.lat})::geography, 'active')`;
    for (const person of Object.values(PEOPLE)) {
      await admin`insert into tenant_members (id, tenant_id, user_id, role_code)
                  values (${person.member}, ${TENANT}, ${person.user}, ${person.role})`;
    }
    // A pharmacy open around the clock (the directory's 'pharmacy' kind).
    await admin`insert into categories (id, kind_code, slug, name_bn, name_en)
                values (${CATEGORY}, 'place', 'pharmacy', 'ফার্মেসি', 'Pharmacy')
                on conflict do nothing`;
    const [cat] = await admin<
      { id: string }[]
    >`select id from categories where slug = 'pharmacy' and deleted_at is null`;
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`insert into places (id, tenant_id, category_id, slug, name_bn, location, status_code, source_code)
               values (${PLACE}, ${TENANT}, ${cat!.id}, 'engine-pharmacy', 'রাতদিন ফার্মেসি',
                       st_point(${CENTER.lng + 0.001}, ${CENTER.lat})::geography, 'published', 'agent_survey')`;
      for (let d = 1; d <= 7; d++) {
        await tx`insert into place_hours (tenant_id, place_id, iso_day_of_week, opens_at, closes_at, closes_next_day)
                 values (${TENANT}, ${PLACE}, ${d}, '00:00', '00:00', true)`;
      }
    });

    module = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
      await module.get(BanStateService).invalidate(person.user);
      tokens[who] = await signer.signAccessToken({
        userId: person.user,
        tenantId: TENANT,
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

  it('shows a reported outage only once enough neighbours agree', async () => {
    const report = (who: Who) =>
      call('POST', '/info/outages/reports', who, { utility: 'electricity', location: CENTER });
    expect((await report('m1')).json()).toMatchObject({ reporters: 1, threshold: 3, shown: false });
    await report('m2');
    expect(await cards(`/info/outages?${near}`)).toEqual([]);
    expect((await report('m3')).json()).toMatchObject({ reporters: 3, shown: true });
    const items = await cards(`/info/outages?${near}`);
    expect(items[0]).toMatchObject({
      type: 'outage_report',
      badges: ['electricity', 'ongoing', 'reported'],
    });
    expect((await call('POST', '/info/outages/reports', null, { utility: 'gas' })).statusCode).toBe(
      401,
    );
  });

  it('lets the area team schedule an outage, not a member', async () => {
    const body = {
      utility: 'electricity',
      areaText: 'উত্তর পাড়া',
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
      reason: 'লাইন মেরামত',
    };
    expect((await call('POST', '/info/outages', 'm1', body)).statusCode).toBe(403);
    expect((await call('POST', '/info/outages', 'agent', body)).statusCode).toBe(201);
    const scheduled = (await cards(`/info/outages?${near}`)).find((c) => c.type === 'outage');
    expect(scheduled?.badges).toEqual(['electricity', 'upcoming', 'scheduled']);
  });

  it('holds a member’s janaza notice for a moderator, then shows it with its template', async () => {
    const created = await call('POST', '/info/notices', 'm1', {
      type: 'obituary',
      title: 'জানাজার খবর',
      body: 'মরহুমের জন্য দোয়া চাই।',
      template: 'janaza',
      templateFields: { deceasedName: 'আব্দুল করিম', age: 72, janazaPlace: 'কেন্দ্রীয় মসজিদ' },
    });
    expect(created.statusCode).toBe(201);
    const { id, status } = created.json<{ id: string; status: string }>();
    expect(status).toBe('pending_review');
    expect((await cards(`/info/notices?${near}`)).map((c) => c.id)).not.toContain(id);
    // A member can't post a government notice.
    const refused = await call('POST', '/info/notices', 'm2', {
      type: 'government',
      title: 'x',
      body: 'y',
    });
    expect(refused.json()).toMatchObject({ error: 'NOTICE_REFUSED' });

    const queue = (await call('GET', '/info/moderation/queue', 'admin')).json<{
      items: { id: string }[];
    }>();
    expect(queue.items.map((i) => i.id)).toContain(id);
    expect((await call('GET', '/info/moderation/queue', 'm2')).statusCode).toBe(403);
    const decided = await call('POST', `/info/moderation/notice/${id}/decision`, 'admin', {
      decision: 'approve',
      reasonCode: 'meets_guidelines',
    });
    expect(decided.json()).toEqual({ status: 'published' });
    // The author hears the decision.
    expect(await worker.dispatch((n) => n.type === 'info_item_decided' && n.entityId === id)).toBe(
      1,
    );
    const [note] = await admin<{ deep_link: string }[]>`select deep_link from notifications
      where user_id = ${PEOPLE.m1.user} and type_code = 'info_item_decided' and entity_id = ${id}`;
    expect(note?.deep_link).toBe(`/info/notices/${id}`);

    const listed = (await cards(`/info/notices?${near}&category=community`)).find(
      (c) => c.id === id,
    );
    expect(listed?.badges).toEqual(expect.arrayContaining(['obituary', 'community', 'janaza']));
    const detail = (await call('GET', `/info/notices/${id}`, null)).json<{
      templateFields: { deceasedName: string };
    }>();
    expect(detail.templateFields.deceasedName).toBe('আব্দুল করিম');
  });

  it('moderates lost & found and reveals the reporter only through the tracked contact', async () => {
    const created = await call('POST', '/info/lost-found', 'm1', {
      kind: 'lost',
      itemType: 'pet',
      title: 'সাদা বিড়াল',
      locationText: 'বাজারের পাশে',
      location: CENTER,
      lastSeenAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const { id, status } = created.json<{ id: string; status: string }>();
    expect(status).toBe('pending_review');
    await call('POST', `/info/moderation/lost_found/${id}/decision`, 'admin', {
      decision: 'approve',
      reasonCode: 'meets_guidelines',
    });
    const listed = await cards(`/info/lost-found?${near}&kind=lost`);
    expect(listed.map((c) => c.id)).toContain(id);
    const body = JSON.stringify(listed);
    expect(body).not.toContain(PEOPLE.m1.phone);

    const reveal = await call('POST', `/info/lost-found/${id}/contact`, 'm2', { channel: 'call' });
    expect(reveal.json()).toMatchObject({ phone: PEOPLE.m1.phone, href: `tel:${PEOPLE.m1.phone}` });
    const leads =
      await admin`select id from lead_events where target_member_id = ${PEOPLE.m1.member} and source_code = 'lost_found'`;
    expect(leads).toHaveLength(1);
    // The reporter is told someone got in touch.
    expect(
      await worker.dispatch((n) => n.type === 'lost_found_contacted' && n.entityId === id),
    ).toBe(1);
    expect(
      (await call('POST', `/info/lost-found/${id}/contact`, 'm1', { channel: 'call' })).statusCode,
    ).toBe(422);

    expect((await call('POST', `/info/lost-found/${id}/resolve`, 'm1')).statusCode).toBe(204);
    expect((await cards(`/info/lost-found?${near}`)).map((c) => c.id)).not.toContain(id);
  });

  it('keeps transport with stops, a timetable and the next departures', async () => {
    const created = await call('POST', '/info/transport/routes', 'agent', {
      mode: 'bus',
      nameBn: 'ইঞ্জিন – ঢাকা',
      originName: 'ইঞ্জিন বাসস্ট্যান্ড',
      destinationName: 'ঢাকা',
      originLocation: CENTER,
      fareMin: '80',
      fareMax: '120',
      stops: [{ nameBn: 'প্রথম স্টপ', minutesFromOrigin: 10 }],
      schedules: [{ departureTime: '00:00' }, { departureTime: '23:59' }],
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: string }>();
    const list = await cards(`/info/transport/routes?${near}&mode=bus`);
    expect(list.find((c) => c.id === id)).toMatchObject({ isStale: false, badges: ['bus'] });
    const detail = (await call('GET', `/info/transport/routes/${id}`, null)).json<{
      stops: unknown[];
      schedules: unknown[];
      nextDepartures: { departsAt: string }[];
      fareUpdatedOn: string | null;
    }>();
    expect(detail.stops).toHaveLength(1);
    expect(detail.schedules).toHaveLength(2);
    expect(detail.nextDepartures.length).toBeGreaterThanOrEqual(1);
    expect(new Date(detail.nextDepartures[0]!.departsAt).getTime()).toBeGreaterThan(
      Date.now() - 1000,
    );
    expect(detail.fareUpdatedOn).not.toBeNull();
  });

  it('versions the government service guide', async () => {
    const entry = {
      slug: 'birth-registration',
      category: 'certificate',
      nameBn: 'জন্ম নিবন্ধন',
      officeName: 'ইউনিয়ন পরিষদ',
      documents: ['টিকার কার্ড', 'বাবা-মায়ের জাতীয় পরিচয়পত্র'],
      fees: [{ label: 'ফি', amount: '50' }],
      steps: ['অনলাইনে আবেদন', 'ইউনিয়ন পরিষদে জমা'],
      links: [{ label: 'bdris', url: 'https://bdris.gov.bd' }],
    };
    expect((await call('POST', '/info/gov-services', 'm1', entry)).statusCode).toBe(403);
    const first = (await call('POST', '/info/gov-services', 'agent', entry)).json<{
      id: string;
      versionNo: number;
    }>();
    expect(first.versionNo).toBe(1);
    const second = (
      await call('PUT', `/info/gov-services/${first.id}`, 'admin', {
        ...entry,
        changeNote: 'ফি বদলেছে',
        fees: [{ label: 'ফি', amount: '100' }],
      })
    ).json<{ versionNo: number }>();
    expect(second.versionNo).toBe(2);
    const detail = (await call('GET', '/info/gov-services/birth-registration', null)).json<{
      current: { fees: { amount: string }[] };
      versions: unknown[];
      lastVerifiedOn: string;
      card: Card;
    }>();
    expect(detail.current.fees[0]!.amount).toBe('100.00');
    expect(detail.versions).toHaveLength(2);
    expect(detail.card.isStale).toBe(false);
    const old = (await call('GET', '/info/gov-services/birth-registration/versions/1', null)).json<{
      fees: { amount: string }[];
    }>();
    expect(old.fees[0]!.amount).toBe('50.00');
  });

  it('lists pharmacies with the 24-hour flag', async () => {
    const items = await cards(`/info/directory?kind=pharmacy&open24=true&${near}`);
    expect(items.find((c) => c.id === PLACE)?.badges).toEqual(
      expect.arrayContaining(['pharmacy', '24h']),
    );
  });

  it('serves the prayer settings, and the agri board only where enabled', async () => {
    const settings = (await call('GET', '/info/prayer/settings', null)).json<unknown>();
    expect(settings).toMatchObject({ method: 'karachi', asrSchool: 'hanafi', center: CENTER });
    expect((await call('GET', '/info/services', null)).json()).toEqual({ agri: false });
    expect((await call('GET', '/bazar/board?board=agri', null)).statusCode).toBe(404);
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'platform_admin', true)`;
      await tx`select set_config('app.is_platform_admin', 'true', true)`;
      await tx`insert into tenant_settings (tenant_id, setting_overrides)
               values (${TENANT}, '{"agri_services_enabled": true}'::jsonb)
               on conflict (tenant_id) do update set setting_overrides = excluded.setting_overrides`;
    });
    await module.get(SettingsService).invalidate(TENANT);
    const board = await call('GET', '/bazar/board?board=agri', null);
    expect(board.statusCode).toBe(200);
    expect(board.json<{ items: { code: string }[] }>().items.map((i) => i.code)).toContain('urea');
  });

  it('puts info and prayer cards on the feed', async () => {
    const feed = await call('GET', `/feed?${near}`, null);
    const kinds = feed.json<{ items: { kind: string }[] }>().items.map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(['prayer', 'info']));
  });
});
