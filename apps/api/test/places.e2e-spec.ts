import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { SMS_PROVIDER, type SmsProvider } from '../src/auth/otp/sms/sms-provider.interface';
import { TokenService } from '../src/auth/tokens/token.service';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * User-contributed places and the claim flow end to end (ADR 047), on real
 * Postgres + Redis, with the SMS provider captured:
 *
 *   AUTO  tenant: accepts every kind of evidence and auto-approves an
 *         OTP-verified claim (place_claim_otp_auto_approve = true).
 *   PAPER tenant: trade licence / shop-front photos only; every claim waits
 *         for a moderator.
 *
 * NEWBIE has no history (trust 20 < the default threshold 60); TRUSTED has a
 * platform override of 90; AGENT is a field agent; MOD moderates AUTO and
 * MOD_P moderates PAPER.
 */

const FIXTURE = '0191e3a0-91ad-7000-8000-%';
const PARTNER = '0191e3a0-91ad-7000-8000-000000000001';
const AREA = '0191e3a0-91ad-7000-8000-000000000011';
const AREA_P = '0191e3a0-91ad-7000-8000-000000000012';
const AUTO = '0191e3a0-91ad-7000-8000-000000000021';
const PAPER = '0191e3a0-91ad-7000-8000-000000000022';
const NEWBIE = '0191e3a0-91ad-7000-8000-000000000031';
const TRUSTED = '0191e3a0-91ad-7000-8000-000000000032';
const AGENT = '0191e3a0-91ad-7000-8000-000000000033';
const MOD = '0191e3a0-91ad-7000-8000-000000000034';
const OWNER = '0191e3a0-91ad-7000-8000-000000000035';
const RIVAL = '0191e3a0-91ad-7000-8000-000000000036';
const MOD_P = '0191e3a0-91ad-7000-8000-000000000037';
const M_NEWBIE = '0191e3a0-91ad-7000-8000-000000000041';
const M_TRUSTED = '0191e3a0-91ad-7000-8000-000000000042';
const M_AGENT = '0191e3a0-91ad-7000-8000-000000000043';
const M_MOD = '0191e3a0-91ad-7000-8000-000000000044';
const M_OWNER = '0191e3a0-91ad-7000-8000-000000000045';
const M_OWNER_P = '0191e3a0-91ad-7000-8000-000000000046';
const M_RIVAL_P = '0191e3a0-91ad-7000-8000-000000000047';
const M_MOD_P = '0191e3a0-91ad-7000-8000-000000000048';
const M_AGENT_P = '0191e3a0-91ad-7000-8000-000000000049';
const CATEGORY = '0191e3a0-91ad-7000-8000-000000000051';
const SHOP_PHONE = '+8801755000001';

const square = (west: number, east: number) =>
  `SRID=4326;MULTIPOLYGON(((${west} 20.3,${east} 20.3,${east} 20.4,${west} 20.4,${west} 20.3)))`;
const POINT = { lat: 20.35, lng: 92.45 };
const POINT_P = { lat: 20.35, lng: 92.55 };

class FakeSmsProvider implements SmsProvider {
  sent: { phoneE164: string; message: string }[] = [];
  send(phoneE164: string, message: string): Promise<void> {
    this.sent.push({ phoneE164, message });
    return Promise.resolve();
  }
}

interface Place {
  id: string;
  status: string;
  source: string;
  fieldVerified: boolean;
  nameBn: string;
  phones: string[];
  photos: { id: string }[];
  streetPhoto: { id: string } | null;
  businessHours: { day: number; opens: string; closes: string; closesNextDay: boolean }[];
  claim: { claimed: boolean; storeId: string | null };
  isMine: boolean;
  canEdit: boolean;
}
interface Claim {
  id: string;
  status: string;
  evidence: string[];
  otpVerified: boolean;
  storeId: string | null;
  rejectionReason: string | null;
}
interface Revision {
  id: string;
  kind: string;
  changedFields: Record<string, { from: unknown; to: unknown }>;
  changedByUserId: string | null;
}

type As =
  'newbie' | 'trusted' | 'agent' | 'mod' | 'owner' | 'ownerP' | 'rivalP' | 'modP' | 'agentP';
const TENANT_OF: Record<As, string> = {
  newbie: AUTO,
  trusted: AUTO,
  agent: AUTO,
  mod: AUTO,
  owner: AUTO,
  ownerP: PAPER,
  rivalP: PAPER,
  modP: PAPER,
  agentP: PAPER,
};

describe('Places and claims (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: Sql;
  let sms: FakeSmsProvider;
  const tokens: Partial<Record<As, string>> = {};

  async function cleanUp(): Promise<void> {
    // Places/stores made through the API (and the store an approval creates)
    // have random ids: their search outbox events are found through the rows.
    const rows = await admin<{ id: string }[]>`
      select id from places where tenant_id::text like ${FIXTURE}
      union all select id from stores where tenant_id::text like ${FIXTURE}
      union all select id from tenant_categories where tenant_id::text like ${FIXTURE}`;
    const aggregateIds = rows.map((r) => r.id);
    await admin`delete from notifications where user_id::text like ${FIXTURE}`;
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from moderation_actions where tenant_id::text like ${FIXTURE}`;
    });
    await admin`delete from media_attachments where tenant_id::text like ${FIXTURE}`;
    await admin`delete from place_claims where tenant_id::text like ${FIXTURE}`;
    await admin`update places set claim_store_id = null where tenant_id::text like ${FIXTURE}`;
    await admin`delete from saved_stores where tenant_id::text like ${FIXTURE}`;
    await admin`delete from stores where tenant_id::text like ${FIXTURE}`;
    await admin`delete from place_hours where tenant_id::text like ${FIXTURE}`;
    await admin`delete from places where tenant_id::text like ${FIXTURE}`;
    await admin`delete from media_assets where tenant_id::text like ${FIXTURE}`;
    await admin`delete from outbox_events where payload->>'tenantId' like ${FIXTURE} or aggregate_id::text like ${FIXTURE}`;
    await admin`delete from member_trust_scores where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_categories where tenant_id::text like ${FIXTURE}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_settings where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from tenant_members where user_id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
    if (aggregateIds.length > 0) {
      await admin`delete from outbox_events where aggregate_id in ${admin(aggregateIds)}`;
    }
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();

    await admin`
      insert into users (id, phone_e164) values
        (${NEWBIE}, '+8801755000011'), (${TRUSTED}, '+8801755000012'), (${AGENT}, '+8801755000013'),
        (${MOD}, '+8801755000014'), (${OWNER}, '+8801755000015'), (${RIVAL}, '+8801755000016'),
        (${MOD_P}, '+8801755000017')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Places Partner', 'Places Partner', '+8801755000099')`;
    await admin`
      insert into geo_areas
        (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release, boundary, boundary_simplified)
      values
        (${AREA}, 3, 'upazila', 'places-e2e-auto', 'Places Auto', 'fixture', ${square(92.4, 92.5)}, ${square(92.4, 92.5)}),
        (${AREA_P}, 3, 'upazila', 'places-e2e-paper', 'Places Paper', 'fixture', ${square(92.5, 92.6)}, ${square(92.5, 92.6)})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values
        (${AUTO}, ${PARTNER}, ${AREA}, 'places-e2e-auto', 'অটো', 'Auto', st_point(92.45, 20.35)::geography, 'active'),
        (${PAPER}, ${PARTNER}, ${AREA_P}, 'places-e2e-paper', 'কাগজ', 'Paper', st_point(92.55, 20.35)::geography, 'active')`;
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'platform_admin', true)`;
      await tx`
        insert into tenant_settings (tenant_id, setting_overrides) values
          (${AUTO}, ${tx.json({ place_claim_otp_auto_approve: true })}),
          (${PAPER}, ${tx.json({ place_claim_evidence_methods: ['shop_front_photo', 'trade_license'] })})`;
    });
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${M_NEWBIE}, ${AUTO}, ${NEWBIE}, 'member'), (${M_TRUSTED}, ${AUTO}, ${TRUSTED}, 'member'),
        (${M_AGENT}, ${AUTO}, ${AGENT}, 'agent'), (${M_MOD}, ${AUTO}, ${MOD}, 'moderator'),
        (${M_OWNER}, ${AUTO}, ${OWNER}, 'member'),
        (${M_OWNER_P}, ${PAPER}, ${OWNER}, 'member'), (${M_RIVAL_P}, ${PAPER}, ${RIVAL}, 'member'),
        (${M_MOD_P}, ${PAPER}, ${MOD_P}, 'moderator'), (${M_AGENT_P}, ${PAPER}, ${AGENT}, 'agent')`;
    await admin`
      insert into member_trust_scores (tenant_id, member_id, score, components, algorithm_version, override_score, override_reason)
      values (${AUTO}, ${M_TRUSTED}, 90, '{}', 1, 90, 'fixture: long-standing contributor')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en)
      values (${CATEGORY}, 'place', 'places-e2e-grocery', 'মুদি দোকান', 'Grocery')`;
    await admin`
      insert into tenant_categories (tenant_id, category_id, is_enabled)
      values (${AUTO}, ${CATEGORY}, true), (${PAPER}, ${CATEGORY}, true)`;

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
    for (const [name, userId, memberId, role] of [
      ['newbie', NEWBIE, M_NEWBIE, 'member'],
      ['trusted', TRUSTED, M_TRUSTED, 'member'],
      ['agent', AGENT, M_AGENT, 'agent'],
      ['mod', MOD, M_MOD, 'moderator'],
      ['owner', OWNER, M_OWNER, 'member'],
      ['ownerP', OWNER, M_OWNER_P, 'member'],
      ['rivalP', RIVAL, M_RIVAL_P, 'member'],
      ['modP', MOD_P, M_MOD_P, 'moderator'],
      ['agentP', AGENT, M_AGENT_P, 'agent'],
    ] as const) {
      tokens[name] = await signer.signAccessToken({
        userId,
        tenantId: TENANT_OF[name],
        memberId,
        role,
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

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, as: As, body?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { 'x-tenant-id': TENANT_OF[as], authorization: `Bearer ${tokens[as]}` },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });

  let n = 0;
  const contribute = async (as: As, overrides: Record<string, unknown> = {}): Promise<Place> => {
    const response = await call('POST', '/places', as, {
      nameBn: `রহিম স্টোর ${++n}`,
      nameEn: `Rahim Store ${n}`,
      categoryId: CATEGORY,
      location: TENANT_OF[as] === PAPER ? POINT_P : POINT,
      phone: '01755000001',
      // Every fixture shop is a "রহিম স্টোর" with the same number at the same
      // spot; duplicate detection (ADR 048) has its own suite.
      confirmNotDuplicate: true,
      ...overrides,
    });
    expect(response.statusCode).toBe(201);
    return response.json<Place>();
  };

  let mediaN = 0;
  const upload = async (
    tenantId: string,
    userId: string,
    kind: 'image' | 'document',
  ): Promise<string> => {
    const id = `0191e3a0-91ad-7000-8000-${(0x9000 + ++mediaN).toString(16).padStart(12, '0')}`;
    await admin`
      insert into media_assets
        (id, tenant_id, uploaded_by_user_id, kind_code, visibility_code, storage_key, mime_type, byte_size,
         checksum_sha256, status_code)
      values (${id}, ${tenantId}, ${userId}, ${kind}, ${kind === 'image' ? 'public' : 'private'},
              ${`places-e2e/${id}`}, ${kind === 'image' ? 'image/webp' : 'application/pdf'}, 100,
              ${'a'.repeat(64)}, 'ready')`;
    return id;
  };
  const notificationsOf = (userId: string) =>
    admin<{ type_code: string }[]>`
      select type_code from notifications where user_id = ${userId} order by created_at`;
  const actionsOfClaim = (claimId: string) =>
    admin<{ action_code: string; reason_code: string }[]>`
      select action_code, reason_code from moderation_actions where place_claim_id = ${claimId} order by id`;

  describe('contributing a place', () => {
    it("a field agent's place goes live at once, surveyed, with photos, a street photo and hours", async () => {
      const photo = await upload(AUTO, AGENT, 'image');
      const street = await upload(AUTO, AGENT, 'image');
      const place = await contribute('agent', {
        photos: [photo],
        streetPhoto: street,
        businessHours: [
          { day: 5, opens: '15:00', closes: '23:00' },
          { day: 6, opens: '18:00', closes: '02:00' },
        ],
      });
      expect(place).toMatchObject({
        status: 'published',
        source: 'agent_survey',
        fieldVerified: true,
        phones: [SHOP_PHONE],
        photos: [{ id: photo }],
        streetPhoto: { id: street },
        claim: { claimed: false, storeId: null },
        isMine: true,
        canEdit: true,
      });
      expect(place.businessHours).toEqual([
        { day: 5, opens: '15:00', closes: '23:00', closesNextDay: false },
        { day: 6, opens: '18:00', closes: '02:00', closesNextDay: true },
      ]);
    });

    it("a new member's place waits for review; only they (and staff) can see it", async () => {
      const place = await contribute('newbie');
      expect(place).toMatchObject({
        status: 'pending_review',
        source: 'user_submitted',
        isMine: true,
        canEdit: false,
      });
      expect((await call('GET', `/places/${place.id}`, 'trusted')).statusCode).toBe(404);
      expect((await call('GET', `/places/${place.id}`, 'mod')).statusCode).toBe(200);
    });

    it("a trusted member's place goes live", async () => {
      expect((await contribute('trusted')).status).toBe('published');
    });

    it('only moderators mark landmarks', async () => {
      const response = await call('POST', '/places', 'agent', {
        nameBn: 'বড় মসজিদ',
        categoryId: CATEGORY,
        location: POINT,
        isLandmark: true,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: 'PLACE_LANDMARK_STAFF_ONLY' });
      const landmark = await contribute('mod', { isLandmark: true, landmarkRadiusKm: 2 });
      expect(landmark).toMatchObject({ isLandmark: true, status: 'published' });
    });

    it("refuses someone else's photos and a number that isn't a BD mobile", async () => {
      const notMine = await upload(AUTO, NEWBIE, 'image');
      const photo = await call('POST', '/places', 'agent', {
        nameBn: 'দোকান',
        categoryId: CATEGORY,
        location: POINT,
        photos: [notMine],
      });
      expect(photo.json()).toMatchObject({ error: 'PLACE_MEDIA_INVALID' });
      const phone = await call('POST', '/places', 'agent', {
        nameBn: 'দোকান',
        categoryId: CATEGORY,
        location: POINT,
        phone: '029999999',
      });
      expect(phone.json()).toMatchObject({ error: 'PLACE_PHONE_INVALID' });
    });
  });

  describe('moderating contributions', () => {
    it('lists the pending ones; approving publishes, records the action and tells the contributor', async () => {
      const place = await contribute('newbie');
      expect((await call('GET', '/places/review-queue', 'newbie')).statusCode).toBe(403);
      const queue = (await call('GET', '/places/review-queue?limit=100', 'mod')).json<{
        items: { id: string }[];
      }>();
      expect(queue.items.map((i) => i.id)).toContain(place.id);

      const approved = await call('POST', `/places/${place.id}/approve`, 'mod');
      expect(approved.json()).toEqual({ placeId: place.id, status: 'published' });
      expect((await call('POST', `/places/${place.id}/approve`, 'mod')).json()).toMatchObject({
        error: 'PLACE_NOT_PENDING',
      });
      expect(
        await admin`select action_code, reason_code from moderation_actions where place_id = ${place.id}`,
      ).toEqual([{ action_code: 'approved', reason_code: 'meets_guidelines' }]);
      expect((await notificationsOf(NEWBIE)).map((x) => x.type_code)).toContain('place_approved');
    });

    it("another tenant's moderator can't touch it", async () => {
      const place = await contribute('newbie');
      expect((await call('POST', `/places/${place.id}/approve`, 'modP')).statusCode).toBe(404);
    });
  });

  describe('revision history and revert', () => {
    it('records every edit; a moderator reverts a bad one', async () => {
      const place = await contribute('agent', {
        businessHours: [{ day: 1, opens: '09:00', closes: '21:00' }],
      });

      // A member can't edit a place they don't own.
      const denied = await call('PATCH', `/places/${place.id}`, 'newbie', { nameBn: 'ভাঙচুর' });
      expect(denied.statusCode).toBe(403);

      const vandal = await call('PATCH', `/places/${place.id}`, 'agent', {
        nameBn: 'বন্ধ!!! এখানে যাবেন না',
        phones: ['01755000666'],
        businessHours: [],
      });
      expect(vandal.statusCode).toBe(200);

      const history = (await call('GET', `/places/${place.id}/revisions`, 'mod')).json<{
        items: Revision[];
      }>();
      expect(history.items.map((r) => r.kind)).toEqual(['edited', 'created']);
      const [bad, created] = history.items;
      expect(created!.changedFields).toHaveProperty('hours');
      expect(bad).toMatchObject({
        changedByUserId: AGENT,
        changedFields: {
          name_bn: { from: place.nameBn, to: 'বন্ধ!!! এখানে যাবেন না' },
          phones: { from: [SHOP_PHONE], to: ['+8801755000666'] },
          hours: { from: [{ day: 1, opens: '09:00', closes: '21:00', next_day: false }], to: [] },
        },
      });
      // History is for editors.
      expect((await call('GET', `/places/${place.id}/revisions`, 'newbie')).statusCode).toBe(403);
      // Reverting is for moderators.
      expect(
        (
          await call('POST', `/places/${place.id}/revisions/${bad!.id}/revert`, 'agent', {
            reasonCode: 'spam',
          })
        ).statusCode,
      ).toBe(403);

      const revert = await call('POST', `/places/${place.id}/revisions/${bad!.id}/revert`, 'mod', {
        reasonCode: 'spam',
        reasonText: 'vandalised name and number',
      });
      expect(revert.statusCode).toBe(200);
      const restored = (await call('GET', `/places/${place.id}`, 'newbie')).json<Place>();
      expect(restored).toMatchObject({ nameBn: place.nameBn, phones: [SHOP_PHONE] });
      expect(restored.businessHours).toEqual([
        { day: 1, opens: '09:00', closes: '21:00', closesNextDay: false },
      ]);

      const after = (await call('GET', `/places/${place.id}/revisions`, 'mod')).json<{
        items: (Revision & { revertsRevisionId: string })[];
      }>();
      expect(after.items[0]).toMatchObject({
        kind: 'reverted',
        revertsRevisionId: bad!.id,
        changedByUserId: MOD,
      });
      expect(
        await admin`select action_code, reason_code from moderation_actions where place_id = ${place.id}`,
      ).toEqual([{ action_code: 'reverted', reason_code: 'spam' }]);
    });

    it('refuses to revert an edit whose fields changed again since', async () => {
      const place = await contribute('agent');
      await call('PATCH', `/places/${place.id}`, 'agent', { nameBn: 'এক' });
      const [first] = (await call('GET', `/places/${place.id}/revisions`, 'mod')).json<{
        items: Revision[];
      }>().items;
      await call('PATCH', `/places/${place.id}`, 'agent', { nameBn: 'দুই' });
      const response = await call(
        'POST',
        `/places/${place.id}/revisions/${first!.id}/revert`,
        'mod',
        {
          reasonCode: 'spam',
        },
      );
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: 'PLACE_REVISION_SUPERSEDED' });
    });
  });

  describe('claiming ("এই দোকানটি আমার")', () => {
    it('an OTP to the number already on the place auto-approves where the tenant allows it', async () => {
      const place = await contribute('agent');
      const sent = await call('POST', `/places/${place.id}/claim/otp`, 'owner', {});
      expect(sent.statusCode).toBe(200);
      expect(sent.json<{ sentTo: string }>().sentTo).toBe('+8801••••••001');
      const sms_ = sms.sent.at(-1)!;
      expect(sms_.phoneE164).toBe(SHOP_PHONE);
      const code = /\d{6}/.exec(sms_.message)![0];

      // The claim code is not a login code for the shop's number.
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/verify',
        headers: { 'x-tenant-id': AUTO },
        payload: { phone: SHOP_PHONE, code, device: { platformCode: 'android' } },
      });
      expect(login.json()).toMatchObject({ error: 'OTP_EXPIRED' });

      const response = await call('POST', `/places/${place.id}/claim`, 'owner', {
        evidence: { otp: { code } },
      });
      expect(response.statusCode).toBe(201);
      const claim = response.json<Claim>();
      expect(claim).toMatchObject({
        status: 'approved',
        evidence: ['otp_to_listed_phone'],
        otpVerified: true,
      });
      expect(claim.storeId).toEqual(expect.any(String));

      const now = (await call('GET', `/places/${place.id}`, 'owner')).json<Place>();
      expect(now.claim).toEqual({ claimed: true, storeId: claim.storeId });
      expect(now.canEdit).toBe(true);
      const [store] =
        await admin`select owner_member_id, place_id, status_code from stores where id = ${claim.storeId}`;
      expect(store).toEqual({
        owner_member_id: M_OWNER,
        place_id: place.id,
        status_code: 'active',
      });
      expect(await actionsOfClaim(claim.id)).toEqual([
        { action_code: 'claim_submitted', reason_code: 'owner_request' },
        { action_code: 'claim_approved', reason_code: 'otp_verified' },
      ]);
      expect((await notificationsOf(OWNER)).map((x) => x.type_code)).toContain(
        'place_claim_approved',
      );

      // The verified owner can now edit their place; nobody can claim it again.
      expect(
        (await call('PATCH', `/places/${place.id}`, 'owner', { addressText: 'বাজার রোড ১২' }))
          .statusCode,
      ).toBe(200);
      const again = await call('POST', `/places/${place.id}/claim/otp`, 'trusted', {});
      expect(again.json()).toMatchObject({ error: 'PLACE_ALREADY_CLAIMED' });
    });

    it('a wrong code claims nothing', async () => {
      const place = await contribute('agent', { phone: '01755000002' });
      await call('POST', `/places/${place.id}/claim/otp`, 'trusted', {});
      const code = /\d{6}/.exec(sms.sent.at(-1)!.message)![0];
      const wrong = code === '000000' ? '111111' : '000000';
      const response = await call('POST', `/places/${place.id}/claim`, 'trusted', {
        evidence: { otp: { code: wrong } },
      });
      expect(response.statusCode).toBe(400);
      expect(await admin`select 1 from place_claims where place_id = ${place.id}`).toHaveLength(0);
    });

    it('a tenant that does not accept OTP evidence refuses it', async () => {
      const place = await contribute('agentP');
      const response = await call('POST', `/places/${place.id}/claim/otp`, 'ownerP', {});
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: 'CLAIM_EVIDENCE_NOT_ACCEPTED' });
    });

    it('conflicting claims: the moderator approves one, the other is rejected, both are told', async () => {
      const place = await contribute('agentP');
      const licence = await upload(PAPER, OWNER, 'document');
      const shopFront = await upload(PAPER, RIVAL, 'document');

      const mine = await call('POST', `/places/${place.id}/claim`, 'ownerP', {
        evidence: { tradeLicence: [licence] },
        note: 'আমি ২০১৫ থেকে এই দোকান চালাই',
      });
      const theirs = await call('POST', `/places/${place.id}/claim`, 'rivalP', {
        evidence: { shopFrontPhotos: [shopFront] },
      });
      expect(mine.json<Claim>().status).toBe('pending');
      expect(theirs.json<Claim>().status).toBe('pending');
      const mineId = mine.json<Claim>().id;
      const theirsId = theirs.json<Claim>().id;

      // One pending claim per person per place.
      const twice = await call('POST', `/places/${place.id}/claim`, 'rivalP', {
        evidence: { shopFrontPhotos: [await upload(PAPER, RIVAL, 'document')] },
      });
      expect(twice.json()).toMatchObject({ error: 'CLAIM_ALREADY_PENDING' });

      expect((await call('GET', '/place-claims/queue', 'ownerP')).statusCode).toBe(403);
      const queue = (await call('GET', '/place-claims/queue?limit=100', 'modP')).json<{
        items: { id: string; documentIds: string[]; competingClaims: number; evidence: string[] }[];
      }>();
      expect(queue.items.find((i) => i.id === mineId)).toMatchObject({
        evidence: ['trade_license'],
        documentIds: [licence],
        competingClaims: 1,
      });

      const approved = await call('POST', `/place-claims/${mineId}/approve`, 'modP', {});
      expect(approved.json()).toMatchObject({
        claimId: mineId,
        status: 'approved',
        supersededClaimIds: [theirsId],
      });
      const [rival] =
        await admin`select status_code, rejection_reason_code from place_claims where id = ${theirsId}`;
      expect(rival).toEqual({
        status_code: 'rejected',
        rejection_reason_code: 'place_already_claimed',
      });
      expect((await notificationsOf(OWNER)).map((x) => x.type_code)).toContain(
        'place_claim_approved',
      );
      expect((await notificationsOf(RIVAL)).map((x) => x.type_code)).toContain(
        'place_claim_rejected',
      );
      expect(await actionsOfClaim(theirsId)).toEqual([
        { action_code: 'claim_submitted', reason_code: 'owner_request' },
        { action_code: 'claim_rejected', reason_code: 'place_already_claimed' },
      ]);

      // Too late for the other claim, and for anyone else.
      expect(
        (await call('POST', `/place-claims/${theirsId}/approve`, 'modP', {})).json(),
      ).toMatchObject({
        error: 'CLAIM_NOT_PENDING',
      });
      const late = await call('POST', `/places/${place.id}/claim`, 'rivalP', {
        evidence: { shopFrontPhotos: [await upload(PAPER, RIVAL, 'document')] },
      });
      expect(late.json()).toMatchObject({ error: 'PLACE_ALREADY_CLAIMED' });
    });

    it('a moderator can reject a claim with a reason', async () => {
      const place = await contribute('agentP');
      const claim = (
        await call('POST', `/places/${place.id}/claim`, 'rivalP', {
          evidence: { tradeLicence: [await upload(PAPER, RIVAL, 'document')] },
        })
      ).json<Claim>();
      const rejected = await call('POST', `/place-claims/${claim.id}/reject`, 'modP', {
        reasonCode: 'scam_suspected',
        reasonText: 'licence belongs to another shop',
      });
      expect(rejected.json()).toMatchObject({ status: 'rejected' });
      expect(await actionsOfClaim(claim.id)).toEqual([
        { action_code: 'claim_submitted', reason_code: 'owner_request' },
        { action_code: 'claim_rejected', reason_code: 'scam_suspected' },
      ]);
      // The place is still claimable.
      const [pl] = await admin`select claimed_by_member_id from places where id = ${place.id}`;
      expect(pl).toEqual({ claimed_by_member_id: null });
    });
  });
});
