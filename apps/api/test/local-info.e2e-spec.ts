import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { BanStateService } from '../src/auth/ban-state.service';
import { TokenService } from '../src/auth/tokens/token.service';
import type { AppRole } from '../src/database/tenant-context';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';
import { startNotificationWorker, type NotificationWorker } from './support/notification-worker';

/**
 * Local information services end to end (ADR 064) over HTTP, on real
 * Postgres + Redis:
 *   - the emergency page works signed out, groups local contacts, and keeps
 *     its version while nothing changes;
 *   - a field agent fills the bazar board in one save; the board shows the
 *     arrows, the stale flag and the sponsor; the feed card follows;
 *   - a donor opts in, is found by distance (never with a number), is
 *     contacted through the tracked endpoint, sees who, and can pause;
 *   - an urgent request pushes to the matching donor, shows on the feed, and
 *     reveals the requester's number only through its contact endpoint.
 */

const P = '0191e3a0-1f0e-7000-8000-';
const FIXTURE = `${P}%`;
const PARTNER = `${P}000000000001`;
const AREA = `${P}000000000011`;
const TENANT = `${P}000000000021`;

type Who = 'donor' | 'seeker' | 'agent' | 'admin' | 'member';
const PEOPLE: Record<Who, { user: string; member: string; role: AppRole; phone: string }> = {
  donor: {
    user: `${P}000000000031`,
    member: `${P}000000000041`,
    role: 'member',
    phone: '+8801891000001',
  },
  seeker: {
    user: `${P}000000000032`,
    member: `${P}000000000042`,
    role: 'member',
    phone: '+8801891000002',
  },
  agent: {
    user: `${P}000000000033`,
    member: `${P}000000000043`,
    role: 'agent',
    phone: '+8801891000003',
  },
  admin: {
    user: `${P}000000000034`,
    member: `${P}000000000044`,
    role: 'tenant_admin',
    phone: '+8801891000004',
  },
  member: {
    user: `${P}000000000035`,
    member: `${P}000000000045`,
    role: 'member',
    phone: '+8801891000005',
  },
};
const CENTER = { lat: 23.75, lng: 90.39 };

jest.setTimeout(30_000);

describe('Local information services (e2e)', () => {
  let admin: Sql;
  let app: NestFastifyApplication;
  let module: TestingModule;
  let worker: NotificationWorker;
  const tokens = {} as Record<Who, string>;

  let ip = 0;
  const call = async (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    as: Who | null,
    body?: unknown,
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      remoteAddress: `10.8.${Math.floor(++ip / 250)}.${ip % 250}`,
      headers: {
        'x-tenant-id': TENANT,
        ...(as ? { authorization: `Bearer ${tokens[as]}` } : {}),
      },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });

  async function cleanUp(): Promise<void> {
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      const users = tx`select id from users where id::text like ${FIXTURE}`;
      for (const table of [
        'moderation_actions',
        'blood_request_alerts',
        'blood_donor_contacts',
        'lead_events',
        'blood_requests',
        'blood_donors',
        'bazar_prices',
        'tenant_bazar_items',
        'bazar_board_sponsors',
        'emergency_contacts',
        'tenant_members',
        'tenant_settings',
      ]) {
        await tx.unsafe(`delete from ${table} where tenant_id::text like $1`, [FIXTURE]);
      }
      await tx`delete from user_consents where user_id in (${users})`;
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
      await admin`insert into users (id, phone_e164, phone_verified_at) values (${person.user}, ${person.phone}, now())`;
      await admin`insert into user_profiles (user_id, display_name) values (${person.user}, ${`info ${who}`})`;
    }
    await admin`insert into partners (id, legal_name, display_name, phone_e164)
                values (${PARTNER}, 'Info Partner', 'Info Partner', '+8801891000098')`;
    await admin`insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release)
                values (${AREA}, 3, 'upazila', 'info-e2e', 'Info Area', 'fixture')`;
    await admin`insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
                values (${TENANT}, ${PARTNER}, ${AREA}, 'info-e2e', 'তথ্য-এলাকা', 'Info Area',
                        st_point(${CENTER.lng}, ${CENTER.lat})::geography, 'active')`;
    for (const person of Object.values(PEOPLE)) {
      await admin`insert into tenant_members (id, tenant_id, user_id, role_code)
                  values (${person.member}, ${TENANT}, ${person.user}, ${person.role})`;
    }
    await admin`insert into emergency_contacts (tenant_id, service_type_code, name_bn, phones, location, is_active)
                values (${TENANT}, 'hospital', 'উপজেলা স্বাস্থ্য কমপ্লেক্স', '{+8801891000201}',
                        st_point(${CENTER.lng + 0.001}, ${CENTER.lat})::geography, true)`;

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

  // ---- emergency ------------------------------------------------------------

  it('serves the emergency page signed out: hotlines, local groups, a stable version', async () => {
    const first = await call('GET', `/info/emergency?lat=${CENTER.lat}&lng=${CENTER.lng}`, null);
    expect(first.statusCode).toBe(200);
    const page = first.json<{
      version: string;
      national: { dial: string }[];
      groups: {
        serviceType: string;
        contacts: { name: { bn: string }; distanceMeters: number }[];
      }[];
    }>();
    expect(page.national.map((h) => h.dial)).toContain('999');
    const hospital = page.groups.find((g) => g.serviceType === 'hospital');
    expect(hospital?.contacts.map((c) => c.name.bn)).toContain('উপজেলা স্বাস্থ্য কমপ্লেক্স');

    const second = await call('GET', `/info/emergency?lat=${CENTER.lat}&lng=${CENTER.lng}`, null);
    expect(second.json<{ version: string }>().version).toBe(page.version);
  });

  it('lets field agents keep emergency contacts, not plain members', async () => {
    const body = {
      serviceType: 'fire_service',
      nameBn: 'ফায়ার স্টেশন',
      phones: ['16163'],
      location: { lat: CENTER.lat, lng: CENTER.lng + 0.002 },
      is24h: true,
    };
    expect((await call('POST', '/info/emergency/contacts', 'member', body)).statusCode).toBe(403);
    const created = await call('POST', '/info/emergency/contacts', 'agent', body);
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: string }>();
    expect((await call('POST', `/info/emergency/contacts/${id}/verify`, 'agent')).statusCode).toBe(
      204,
    );
    const page = (await call('GET', '/info/emergency', null)).json<{
      groups: { serviceType: string }[];
    }>();
    expect(page.groups.map((g) => g.serviceType)).toContain('fire_service');
  });

  // ---- bazar ----------------------------------------------------------------

  describe('bazar', () => {
    let onion: string;
    let today: string;
    let yesterday: string;

    beforeAll(async () => {
      const [row] = await admin<
        { id: string }[]
      >`select id from bazar_commodities where code = 'onion'`;
      onion = row!.id;
      // The area's own board: just onions, per kg.
      await admin`insert into tenant_bazar_items (tenant_id, commodity_id, unit_code, sort_order)
                  values (${TENANT}, ${onion}, 'kg', 10)`;
      const [d] = await admin<{ today: string; yesterday: string }[]>`
        select public.tenant_local_today(${TENANT})::text as today,
               (public.tenant_local_today(${TENANT}) - 1)::text as yesterday`;
      today = d!.today;
      yesterday = d!.yesterday;
      await admin.begin(async (tx) => {
        await tx`select set_config('app.role', 'system', true)`;
        await tx`insert into bazar_prices (tenant_id, commodity_id, price_date, unit_code, min_price, max_price, source_code, status_code)
                 values (${TENANT}, ${onion}, ${yesterday}::date, 'kg', 50, 55, 'staff', 'published')`;
      });
    });

    it('shows the board stale until today is entered', async () => {
      const board = (await call('GET', '/bazar/board', null)).json<{
        isStale: boolean;
        lastUpdated: string;
      }>();
      expect(board).toMatchObject({ isStale: true, lastUpdated: yesterday });
    });

    it('prefills yesterday on the entry sheet and publishes one save, agents only', async () => {
      const sheet = await call('GET', '/bazar/entry', 'agent');
      expect(sheet.statusCode).toBe(200);
      expect(sheet.json<{ items: { commodityId: string; previous: unknown }[] }>().items).toEqual([
        expect.objectContaining({ commodityId: onion, previous: { min: '50.00', max: '55.00' } }),
      ]);
      const entry = {
        date: today,
        items: [{ commodityId: onion, unitCode: 'kg', minPrice: '58', maxPrice: '62' }],
      };
      expect((await call('PUT', '/bazar/entry', 'member', entry)).statusCode).toBe(403);
      const saved = await call('PUT', '/bazar/entry', 'agent', entry);
      expect(saved.json()).toEqual({ saved: 1 });
    });

    it('shows today vs yesterday with the arrow and the sponsor', async () => {
      expect(
        (
          await call('PUT', '/bazar/sponsor', 'admin', {
            nameBn: 'রহিম স্টোর',
            startsOn: yesterday,
          })
        ).statusCode,
      ).toBe(204);
      const board = (await call('GET', '/bazar/board', null)).json<{
        isStale: boolean;
        sponsor: { name: { bn: string } } | null;
        items: { today: unknown; yesterday: unknown; direction: string; trend: unknown[] }[];
      }>();
      expect(board.isStale).toBe(false);
      expect(board.sponsor?.name.bn).toBe('রহিম স্টোর');
      expect(board.items[0]).toMatchObject({
        today: { min: '58.00', max: '62.00' },
        yesterday: { min: '50.00', max: '55.00' },
        direction: 'up',
      });
    });
  });

  // ---- blood ----------------------------------------------------------------

  describe('blood', () => {
    it('needs a signed-in user', async () => {
      expect((await call('GET', '/blood/donors?group=o_pos', null)).statusCode).toBe(401);
    });

    it('registers a donor with consent', async () => {
      const res = await call('PUT', '/blood/me', 'donor', {
        bloodGroup: 'o_neg',
        location: { lat: CENTER.lat, lng: CENTER.lng + 0.01 },
        contactWindow: 'any',
        contactPreference: 'reveal_on_request',
        eligibilityConfirmed: true,
        consent: true,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ donor: { isListed: boolean } }>().donor.isListed).toBe(true);
      const consents = await admin`select id from user_consents
        where user_id = ${PEOPLE.donor.user} and consent_type_code = 'blood_donor_listing'`;
      expect(consents).toHaveLength(1);
    });

    it('finds donors by distance with compatible groups, never with a number', async () => {
      const res = await call(
        'GET',
        `/blood/donors?group=o_pos&compatible=true&lat=${CENTER.lat}&lng=${CENTER.lng}`,
        'seeker',
      );
      expect(res.statusCode).toBe(200);
      const page = res.json<{ items: { id: string; bloodGroup: string }[] }>();
      expect(page.items.map((d) => d.bloodGroup)).toContain('o_neg');
      expect(res.body).not.toContain(PEOPLE.donor.phone);
      // Exact group only: no O- donor for O+.
      const exact = await call(
        'GET',
        `/blood/donors?group=o_pos&lat=${CENTER.lat}&lng=${CENTER.lng}`,
        'seeker',
      );
      const groups = exact
        .json<{ items: { bloodGroup: string }[] }>()
        .items.map((d) => d.bloodGroup);
      expect(groups).not.toContain('o_neg');
    });

    it('reveals a sharing donor’s number through the tracked contact, and the donor sees who', async () => {
      const search = await call(
        'GET',
        `/blood/donors?group=o_neg&lat=${CENTER.lat}&lng=${CENTER.lng}`,
        'seeker',
      );
      const donorId = search.json<{ items: { id: string }[] }>().items[0]!.id;
      const res = await call('POST', `/blood/donors/${donorId}/contact`, 'seeker', {
        channel: 'call',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        mode: 'phone',
        reveal: { phone: PEOPLE.donor.phone, href: `tel:${PEOPLE.donor.phone}` },
      });

      const leads = await admin`select id from lead_events
        where target_member_id = ${PEOPLE.donor.member} and source_code = 'blood_donor_list'`;
      expect(leads).toHaveLength(1);
      const contacts = (await call('GET', '/blood/me/contacts', 'donor')).json<{
        items: { requesterName: string }[];
      }>();
      expect(contacts.items.map((c) => c.requesterName)).toEqual(['info seeker']);
      expect(await worker.dispatch((n) => n.type === 'blood_donor_contacted')).toBe(1);

      // Self-contact is refused.
      expect(
        (await call('POST', `/blood/donors/${donorId}/contact`, 'donor', { channel: 'call' }))
          .statusCode,
      ).toBe(422);
    });

    it('pauses at once and leaves the list for the donation gap', async () => {
      const find = async () =>
        (
          await call(
            'GET',
            `/blood/donors?group=o_neg&lat=${CENTER.lat}&lng=${CENTER.lng}`,
            'member',
          )
        ).json<{
          items: unknown[];
        }>().items.length;
      expect(await find()).toBe(1);
      await call('PATCH', '/blood/me/availability', 'donor', { available: false });
      expect(await find()).toBe(0);
      await call('PATCH', '/blood/me/availability', 'donor', { available: true });
      expect(await find()).toBe(1);
      const [d] = await admin<
        { today: string }[]
      >`select public.tenant_local_today(${TENANT})::text as today`;
      const after = await call('POST', '/blood/me/donations', 'donor', { donatedOn: d!.today });
      expect(
        after.json<{ donor: { isListed: boolean; eligibleFrom: string } }>().donor.isListed,
      ).toBe(false);
      expect(await find()).toBe(0);
      // Back for the rest of the suite.
      await admin`update blood_donors set last_donated_on = null where member_id = ${PEOPLE.donor.member}`;
    });

    it('pushes an urgent request to matching donors and reveals the requester only through contact', async () => {
      const neededBy = new Date(Date.now() + 6 * 3_600_000).toISOString();
      const created = await call('POST', '/blood/requests', 'seeker', {
        bloodGroup: 'o_pos',
        units: 2,
        hospitalName: 'Fixture Medical',
        location: CENTER,
        neededBy,
        urgency: 'critical',
      });
      expect(created.statusCode).toBe(201);
      const { id, alertedDonors } = created.json<{ id: string; alertedDonors: number }>();
      expect(alertedDonors).toBe(1);
      expect(await worker.dispatch((n) => n.type === 'blood_request_nearby')).toBe(1);
      const [note] = await admin<{ deep_link: string }[]>`select deep_link from notifications
        where user_id = ${PEOPLE.donor.user} and type_code = 'blood_request_nearby'`;
      expect(note?.deep_link).toBe(`/info/blood/requests/${id}`);

      const list = await call(
        'GET',
        `/blood/requests?lat=${CENTER.lat}&lng=${CENTER.lng}`,
        'donor',
      );
      expect(list.json<{ items: { id: string }[] }>().items.map((r) => r.id)).toContain(id);
      const detail = await call('GET', `/blood/requests/${id}`, 'donor');
      expect(detail.body).not.toContain(PEOPLE.seeker.phone);

      const reveal = await call('POST', `/blood/requests/${id}/contact`, 'donor', {
        channel: 'sms',
      });
      expect(reveal.json()).toMatchObject({ phone: PEOPLE.seeker.phone });

      const feed = await call('GET', `/feed?lat=${CENTER.lat}&lng=${CENTER.lng}`, null);
      const kinds = feed.json<{ items: { kind: string }[] }>().items.map((i) => i.kind);
      expect(kinds).toEqual(expect.arrayContaining(['blood', 'bazar_prices']));

      expect(
        (await call('POST', `/blood/requests/${id}/close`, 'seeker', { outcome: 'fulfilled' }))
          .statusCode,
      ).toBe(204);
    });

    it('lets a moderator take a request down, not a member', async () => {
      const created = await call('POST', '/blood/requests', 'member', {
        bloodGroup: 'ab_neg',
        hospitalName: 'Fake Hospital',
        location: CENTER,
        neededBy: new Date(Date.now() + 3_600_000).toISOString(),
        urgency: 'urgent',
      });
      const { id } = created.json<{ id: string }>();
      const body = { reasonCode: 'fake_blood_request', reasonText: 'Reported as a scam' };
      expect((await call('POST', `/blood/requests/${id}/remove`, 'member', body)).statusCode).toBe(
        403,
      );
      expect((await call('POST', `/blood/requests/${id}/remove`, 'admin', body)).statusCode).toBe(
        204,
      );
      const actions = await admin`select id from moderation_actions where blood_request_id = ${id}`;
      expect(actions).toHaveLength(1);
    });
  });
});
