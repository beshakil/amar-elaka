import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/tokens/token.service';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * Map-specific reporting and moderation end to end (ADR 051): members report
 * places and suggest edits; a moderator works the reports queue (confirm
 * closed, clear the flag, unpublish, dismiss) and the suggestions queue
 * (approve applies the change through the normal edit path and credits the
 * suggester's trust score; reject notifies). Every step leaves its
 * moderation_actions row.
 *
 * Tenant A holds the places and members R1–R4 and moderator MOD; tenant B
 * (next door) holds a near-identical shop for the duplicate report.
 */

const FIXTURE = '0191e3a0-a51f-7000-8000-%';
const PARTNER = '0191e3a0-a51f-7000-8000-000000000001';
const AREA_A = '0191e3a0-a51f-7000-8000-000000000011';
const AREA_B = '0191e3a0-a51f-7000-8000-000000000012';
const TENANT_A = '0191e3a0-a51f-7000-8000-000000000021';
const TENANT_B = '0191e3a0-a51f-7000-8000-000000000022';
const CATEGORY = '0191e3a0-a51f-7000-8000-000000000051';
const user = (n: number) => `0191e3a0-a51f-7000-8000-${(0x100 + n).toString(16).padStart(12, '0')}`;
const member = (n: number) =>
  `0191e3a0-a51f-7000-8000-${(0x200 + n).toString(16).padStart(12, '0')}`;
const MOD = 9;

const square = (west: number, east: number) =>
  `SRID=4326;MULTIPOLYGON(((${west} 20.6,${east} 20.6,${east} 20.7,${west} 20.7,${west} 20.6)))`;
const POINT = { lat: 20.65, lng: 92.45 };
const SHOP_PHONE = '+8801766000001';

interface Place {
  id: string;
  status: string;
  phones: string[];
  location: { lat: number; lng: number };
  businessHours: { day: number; opens: string; closes: string }[];
  possiblyClosed: boolean;
}
interface ReportQueueItem {
  placeId: string;
  possiblyClosed: boolean;
  reasons: Record<string, number>;
  reporterCount: number;
  notes: string[];
}
interface SuggestionQueueItem {
  id: string;
  placeId: string;
  changes: Record<string, unknown>;
  current: Record<string, unknown>;
  suggesterMemberId: string;
  suggesterTrustScore: number;
}

describe('Place reports and edit suggestions (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: Sql;
  const tokens: Record<number, string> = {};

  let n = 0x1000;
  const place = async (
    extra: { tenant?: string; lng?: number; name?: string; phones?: string[] } = {},
  ): Promise<string> => {
    const id = `0191e3a0-a51f-7000-8000-${(n++).toString(16).padStart(12, '0')}`;
    await admin`
      insert into places (id, tenant_id, category_id, slug, name_bn, phones, status_code, location, source_code)
      values (${id}, ${extra.tenant ?? TENANT_A}, ${CATEGORY}, ${`e2e-${id.slice(-6)}`},
              ${extra.name ?? 'করিম ফার্মেসি'}, ${extra.phones ?? [SHOP_PHONE]}, 'published',
              st_point(${extra.lng ?? POINT.lng}, ${POINT.lat})::geography, 'agent_survey')`;
    return id;
  };

  const call = <T>(method: 'GET' | 'POST', url: string, as: number, body?: unknown) =>
    app
      .inject({
        method,
        url: `/api/v1${url}`,
        headers: { 'x-tenant-id': TENANT_A, authorization: `Bearer ${tokens[as]}` },
        ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
      })
      .then((r) => ({ status: r.statusCode, body: (r.body ? r.json() : null) as T }));

  const actions = (placeId: string) =>
    admin<{ action_code: string; reason_code: string; actor_user_id: string | null }[]>`
      select action_code, reason_code, actor_user_id from moderation_actions
      where place_id = ${placeId} order by id`.then((rows) => rows.map((r) => r.action_code));

  async function cleanUp(): Promise<void> {
    const rows = await admin<{ id: string }[]>`
      select id from places where tenant_id::text like ${FIXTURE}`;
    await admin`delete from notifications where user_id::text like ${FIXTURE}`;
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from moderation_actions where tenant_id::text like ${FIXTURE}`;
    });
    await admin`delete from place_edit_suggestions where tenant_id::text like ${FIXTURE}`;
    await admin`delete from duplicate_candidates where tenant_id::text like ${FIXTURE}`;
    await admin`delete from reports where tenant_id::text like ${FIXTURE}`;
    await admin`delete from place_hours where tenant_id::text like ${FIXTURE}`;
    await admin`delete from places where tenant_id::text like ${FIXTURE}`;
    await admin`delete from member_trust_scores where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_settings where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
    if (rows.length > 0) {
      await admin`delete from outbox_events where aggregate_id in ${admin(rows.map((r) => r.id))}`;
    }
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();
    for (const i of [1, 2, 3, 4, MOD]) {
      await admin`insert into users (id, phone_e164) values (${user(i)}, ${`+88017660000${i}0`})`;
    }
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Reports Partner', 'Reports Partner', '+8801766000999')`;
    await admin`
      insert into geo_areas
        (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release, boundary, boundary_simplified)
      values
        (${AREA_A}, 3, 'upazila', 'reports-e2e-a', 'Reports A', 'fixture', ${square(92.4, 92.5)}, ${square(92.4, 92.5)}),
        (${AREA_B}, 3, 'upazila', 'reports-e2e-b', 'Reports B', 'fixture', ${square(92.5, 92.6)}, ${square(92.5, 92.6)})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values
        (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'reports-e2e-a', 'এ', 'A', st_point(92.45, 20.65)::geography, 'active'),
        (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'reports-e2e-b', 'বি', 'B', st_point(92.55, 20.65)::geography, 'active')`;
    await admin`insert into tenant_settings (tenant_id) values (${TENANT_A}), (${TENANT_B})`;
    for (const i of [1, 2, 3, 4, MOD]) {
      await admin`
        insert into tenant_members (id, tenant_id, user_id, role_code)
        values (${member(i)}, ${TENANT_A}, ${user(i)}, ${i === MOD ? 'moderator' : 'member'})`;
    }
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en)
      values (${CATEGORY}, 'place', 'reports-e2e-pharmacy', 'ফার্মেসি', 'Pharmacy')`;

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
    for (const i of [1, 2, 3, 4, MOD]) {
      tokens[i] = await signer.signAccessToken({
        userId: user(i),
        tenantId: TENANT_A,
        memberId: member(i),
        role: i === MOD ? 'moderator' : 'member',
      });
    }
  }, 60_000);

  afterAll(async () => {
    await app.close();
    try {
      await cleanUp();
    } finally {
      await admin.end();
    }
  });

  describe('reports', () => {
    it('three members say it closed: flagged, queued, and a moderator confirms', async () => {
      const id = await place();
      for (const i of [1, 2]) {
        const res = await call('POST', `/places/${id}/report`, i, {
          reasonCode: 'closed_permanently',
          text: 'দোকান বন্ধ হয়ে গেছে',
        });
        expect(res.status).toBe(201);
        // The answer never tells how close the place is to being flagged.
        expect(Object.keys(res.body as object).sort()).toEqual(['created', 'reportId']);
      }
      expect((await call<Place>('GET', `/places/${id}`, 4)).body.possiblyClosed).toBe(false);
      await call('POST', `/places/${id}/report`, 3, { reasonCode: 'closed_permanently' });
      expect((await call<Place>('GET', `/places/${id}`, 4)).body).toMatchObject({
        possiblyClosed: true,
        status: 'published',
      });

      const queue = await call<{ items: ReportQueueItem[] }>(
        'GET',
        '/place-reports/queue?reason=closed_permanently',
        MOD,
      );
      expect(queue.status).toBe(200);
      const item = queue.body.items.find((i) => i.placeId === id)!;
      expect(item).toMatchObject({
        possiblyClosed: true,
        reasons: { closed_permanently: 3 },
        reporterCount: 3,
      });
      expect(item.notes).toContain('দোকান বন্ধ হয়ে গেছে');

      const decided = await call('POST', `/places/${id}/reports/decision`, MOD, {
        decision: 'confirm_closed',
      });
      expect(decided.status).toBe(200);
      expect(decided.body).toEqual({
        placeId: id,
        decision: 'confirm_closed',
        status: 'permanently_closed',
        possiblyClosed: false,
        reportsClosed: 3,
      });
      const after = await call<{ items: ReportQueueItem[] }>('GET', '/place-reports/queue', MOD);
      expect(after.body.items.map((i) => i.placeId)).not.toContain(id);
      const [counts] = await admin<{ actioned: number }[]>`
        select count(*)::int as actioned from reports
        where place_id = ${id} and status_code = 'actioned' and resolution_code = 'place_closed'`;
      expect(counts!.actioned).toBe(3);
      expect(await actions(id)).toEqual([
        'place_reported',
        'place_reported',
        'place_reported',
        'flagged_possibly_closed',
        'closed_confirmed',
      ]);
    });

    it('still open: the flag goes and only the closed reports are dismissed', async () => {
      const id = await place();
      for (const i of [1, 2, 3]) {
        await call('POST', `/places/${id}/report`, i, { reasonCode: 'closed_permanently' });
      }
      await call('POST', `/places/${id}/report`, 4, { reasonCode: 'wrong_information' });
      const res = await call<{ reportsClosed: number; status: string }>(
        'POST',
        `/places/${id}/reports/decision`,
        MOD,
        { decision: 'clear_closed_flag', reasonText: 'visited, open' },
      );
      expect(res.body).toMatchObject({ reportsClosed: 3, status: 'published' });
      expect((await call<Place>('GET', `/places/${id}`, 4)).body.possiblyClosed).toBe(false);
      const queue = await call<{ items: ReportQueueItem[] }>('GET', '/place-reports/queue', MOD);
      expect(queue.body.items.find((i) => i.placeId === id)?.reasons).toEqual({
        wrong_information: 1,
      });
    });

    it('unpublish needs a reason; dismiss needs something to dismiss', async () => {
      const id = await place();
      await call('POST', `/places/${id}/report`, 1, { reasonCode: 'inappropriate' });
      expect(
        (await call('POST', `/places/${id}/reports/decision`, MOD, { decision: 'unpublish' }))
          .status,
      ).toBe(400);
      const res = await call<{ status: string }>('POST', `/places/${id}/reports/decision`, MOD, {
        decision: 'unpublish',
        reasonCode: 'policy_violation',
      });
      expect(res.body.status).toBe('rejected');
      expect((await call('GET', `/places/${id}`, 2)).status).toBe(404);

      const quiet = await place();
      const nothing = await call<{ error: string }>(
        'POST',
        `/places/${quiet}/reports/decision`,
        MOD,
        { decision: 'dismiss' },
      );
      expect(nothing.status).toBe(409);
      expect(nothing.body.error).toBe('PLACE_NO_OPEN_REPORTS');
    });

    it('a duplicate report naming the shop next door goes to the duplicates queue', async () => {
      const id = await place({ name: 'মায়ের দোয়া স্টোর', lng: 92.4999 });
      const twin = await place({ tenant: TENANT_B, name: 'মায়ের দোয়া ষ্টোর', lng: 92.5001 });
      const far = await place({ name: 'অন্য দোকান', lng: 92.41, phones: ['+8801766000002'] });

      // Too far: refused, and no report is filed.
      const refused = await call<{ error: string }>('POST', `/places/${id}/report`, 2, {
        reasonCode: 'duplicate',
        duplicateOfPlaceId: far,
      });
      expect(refused.status).toBe(422);
      expect(refused.body.error).toBe('PLACE_DUPLICATE_TARGET_INVALID');
      const [none] = await admin<{ n: number }[]>`
        select count(*)::int as n from reports where place_id = ${id}`;
      expect(none!.n).toBe(0);

      const res = await call('POST', `/places/${id}/report`, 2, {
        reasonCode: 'duplicate',
        duplicateOfPlaceId: twin,
      });
      expect(res.status).toBe(201);
      const queue = await call<{
        items: { entity: { id: string }; candidate: { id: string }; source: string }[];
      }>('GET', '/places/duplicates', MOD);
      const pair = queue.body.items.find((i) => i.entity.id === id);
      expect(pair).toMatchObject({ candidate: { id: twin }, source: 'report' });
    });

    it("members can't see the queues or decide", async () => {
      expect((await call('GET', '/place-reports/queue', 1)).status).toBe(403);
      expect((await call('GET', '/place-suggestions/queue', 1)).status).toBe(403);
    });
  });

  describe('edit suggestions', () => {
    const newHours = [
      { day: 6, opens: '09:00', closes: '22:00' },
      { day: 5, opens: '15:00', closes: '22:00' },
    ];

    it('approved: applied through the normal edit path, credited to the suggester', async () => {
      const id = await place();
      const res = await call<{ id: string; status: string; changes: Record<string, unknown> }>(
        'POST',
        `/places/${id}/suggestions`,
        1,
        {
          location: { lat: 20.6505, lng: 92.4505 },
          phones: ['01766000009'],
          hours: newHours,
          note: 'নতুন নম্বর, দোকান একটু সামনে সরেছে',
        },
      );
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('pending');
      expect(res.body.changes).toMatchObject({
        phones: ['+8801766000009'],
        // Sorted by day.
        hours: [newHours[1], newHours[0]],
      });
      // Nothing changes until a moderator says so.
      expect((await call<Place>('GET', `/places/${id}`, 2)).body.phones).toEqual([SHOP_PHONE]);

      const queue = await call<{ items: SuggestionQueueItem[] }>(
        'GET',
        '/place-suggestions/queue',
        MOD,
      );
      const item = queue.body.items.find((i) => i.id === res.body.id)!;
      expect(item.current).toMatchObject({ phones: [SHOP_PHONE], hours: [] });
      expect(item.suggesterMemberId).toBe(member(1));
      const before = item.suggesterTrustScore;

      const approved = await call('POST', `/place-suggestions/${res.body.id}/approve`, MOD, {});
      expect(approved.body).toEqual({ id: res.body.id, placeId: id, status: 'approved' });
      const placeNow = (await call<Place>('GET', `/places/${id}`, 2)).body;
      expect(placeNow.phones).toEqual(['+8801766000009']);
      expect(placeNow.location.lat).toBeCloseTo(20.6505, 5);
      expect(placeNow.businessHours.map((h) => h.day)).toEqual([5, 6]);

      // The place's history records it (edit + hours), by the moderator.
      const revisions = await admin<
        { changed_fields: Record<string, unknown>; changed_by_user_id: string }[]
      >`
        select changed_fields, changed_by_user_id from place_revisions
        where place_id = ${id} and kind_code = 'edited'`;
      const fields = revisions.flatMap((r) => Object.keys(r.changed_fields));
      expect(fields).toEqual(expect.arrayContaining(['phones', 'location', 'hours']));
      expect(revisions.every((r) => r.changed_by_user_id === user(MOD))).toBe(true);

      // Trust: approved_edits counts now.
      const [trust] = await admin<{ score: number; components: Record<string, number> }[]>`
        select score, components from member_trust_scores
        where tenant_id = ${TENANT_A} and member_id = ${member(1)}`;
      expect(trust!.components.approved_edits).toBe(2);
      expect(trust!.score).toBe(before + 2);

      const [note] = await admin<{ type_code: string }[]>`
        select type_code from notifications where user_id = ${user(1)} and entity_id = ${id}`;
      expect(note!.type_code).toBe('place_edit_approved');
      expect(await actions(id)).toEqual(['suggestion_submitted', 'suggestion_approved']);

      // Decided once only.
      const twice = await call<{ error: string }>(
        'POST',
        `/place-suggestions/${res.body.id}/approve`,
        MOD,
        {},
      );
      expect(twice.body.error).toBe('PLACE_SUGGESTION_NOT_PENDING');
    });

    it('rejected: nothing changes, the suggester is told why', async () => {
      const id = await place();
      const res = await call<{ id: string }>('POST', `/places/${id}/suggestions`, 2, {
        phones: ['01766000008'],
      });
      const rejected = await call('POST', `/place-suggestions/${res.body.id}/reject`, MOD, {
        reasonCode: 'suggestion_incorrect',
        reasonText: 'called, old number works',
      });
      expect(rejected.body).toMatchObject({ status: 'rejected' });
      expect((await call<Place>('GET', `/places/${id}`, 3)).body.phones).toEqual([SHOP_PHONE]);
      const [note] = await admin<{ type_code: string; params: Record<string, string> }[]>`
        select type_code, params from notifications where user_id = ${user(2)} and entity_id = ${id}`;
      expect(note).toMatchObject({
        type_code: 'place_edit_rejected',
        params: { reasonCode: 'suggestion_incorrect' },
      });
      expect(await actions(id)).toEqual(['suggestion_submitted', 'suggestion_rejected']);
    });

    it('refuses no change, a second pending one, a spot in another area and bad phones', async () => {
      const id = await place();
      const same = await call<{ error: string }>('POST', `/places/${id}/suggestions`, 3, {
        phones: ['01766000001'],
      });
      expect(same.status).toBe(422);
      expect(same.body.error).toBe('PLACE_SUGGESTION_NO_CHANGE');

      expect(
        (await call('POST', `/places/${id}/suggestions`, 3, { phones: ['01766000007'] })).status,
      ).toBe(201);
      const again = await call<{ error: string }>('POST', `/places/${id}/suggestions`, 3, {
        hours: newHours,
      });
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('PLACE_SUGGESTION_PENDING_EXISTS');

      const elsewhere = await call<{ error: string }>('POST', `/places/${id}/suggestions`, 4, {
        location: { lat: 20.65, lng: 92.58 },
      });
      expect(elsewhere.status).toBe(409);
      expect(elsewhere.body.error).toBe('PLACE_LOCATION_OTHER_TENANT');

      const bad = await call<{ error: string }>('POST', `/places/${id}/suggestions`, 4, {
        phones: ['12345'],
      });
      expect(bad.body.error).toBe('PLACE_PHONE_INVALID');
      expect((await call('POST', `/places/${id}/suggestions`, 4, {})).status).toBe(400);
    });
  });
});
