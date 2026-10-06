import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/tokens/token.service';
import { TenantContext } from '../src/database/tenant-context';
import { DuplicatesService } from '../src/places/duplicates.service';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * Duplicate detection and the merge tool end to end (ADR 048), with the
 * default settings: radius 150 m, likely ≥ 0.8, possible ≥ 0.45.
 */

const FIXTURE = '0191e3a0-d0b2-7000-8000-%';
const PARTNER = '0191e3a0-d0b2-7000-8000-000000000001';
const AREA = '0191e3a0-d0b2-7000-8000-000000000011';
const TENANT = '0191e3a0-d0b2-7000-8000-000000000021';
const AGENT = '0191e3a0-d0b2-7000-8000-000000000031';
const AGENT2 = '0191e3a0-d0b2-7000-8000-000000000032';
const MOD = '0191e3a0-d0b2-7000-8000-000000000033';
const M_AGENT = '0191e3a0-d0b2-7000-8000-000000000041';
const M_AGENT2 = '0191e3a0-d0b2-7000-8000-000000000042';
const M_MOD = '0191e3a0-d0b2-7000-8000-000000000043';
const CATEGORY = '0191e3a0-d0b2-7000-8000-000000000051';
const STORE_A = '0191e3a0-d0b2-7000-8000-000000000061';
const STORE_B = '0191e3a0-d0b2-7000-8000-000000000062';

const square = `SRID=4326;MULTIPOLYGON(((92.4 20.6,92.5 20.6,92.5 20.7,92.4 20.7,92.4 20.6)))`;
const BASE = { lat: 20.65, lng: 92.45 };
// ~20 m and ~800 m north of BASE.
const NEAR = { lat: 20.65018, lng: 92.45 };
const FAR = { lat: 20.6572, lng: 92.45 };

interface Place {
  id: string;
  nameBn: string;
  redirectedFrom: string | null;
}
interface Candidate {
  placeId: string;
  nameBn: string;
  distanceM: number;
  score: number;
  phoneMatch: boolean;
}

describe('Duplicate detection and merge (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: Sql;
  const tokens: Record<'agent' | 'agent2' | 'mod', string> = { agent: '', agent2: '', mod: '' };

  async function cleanUp(): Promise<void> {
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from moderation_actions where tenant_id::text like ${FIXTURE}`;
    });
    const ids = (
      await admin<{ id: string }[]>`
        select id from places where tenant_id::text like ${FIXTURE}
        union all select id from stores where tenant_id::text like ${FIXTURE}
        union all select id from tenant_categories where tenant_id::text like ${FIXTURE}`
    ).map((r) => r.id);
    await admin`delete from place_merges where tenant_id::text like ${FIXTURE}`;
    await admin`delete from duplicate_candidates where tenant_id::text like ${FIXTURE}`;
    await admin`update places set merged_into_place_id = null, merged_at = null where tenant_id::text like ${FIXTURE}`;
    await admin`delete from stores where tenant_id::text like ${FIXTURE}`;
    await admin`delete from places where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_categories where tenant_id::text like ${FIXTURE}`;
    if (ids.length > 0) await admin`delete from outbox_events where aggregate_id in ${admin(ids)}`;
    await admin`delete from categories where id::text like ${FIXTURE}`;
    await admin`delete from tenant_members where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_settings where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();
    await admin`
      insert into users (id, phone_e164) values
        (${AGENT}, '+8801777100001'), (${AGENT2}, '+8801777100002'), (${MOD}, '+8801777100003')`;
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Dup Partner', 'Dup Partner', '+8801777100099')`;
    await admin`
      insert into geo_areas
        (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release, boundary, boundary_simplified)
      values (${AREA}, 3, 'upazila', 'dup-e2e', 'Dup E2E', 'fixture', ${square}, ${square})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values (${TENANT}, ${PARTNER}, ${AREA}, 'dup-e2e', 'ডুপ', 'Dup', st_point(92.45, 20.65)::geography, 'active')`;
    await admin`insert into tenant_settings (tenant_id) values (${TENANT})`;
    await admin`
      insert into tenant_members (id, tenant_id, user_id, role_code) values
        (${M_AGENT}, ${TENANT}, ${AGENT}, 'agent'), (${M_AGENT2}, ${TENANT}, ${AGENT2}, 'agent'),
        (${M_MOD}, ${TENANT}, ${MOD}, 'moderator')`;
    await admin`
      insert into categories (id, kind_code, slug, name_bn, name_en)
      values (${CATEGORY}, 'place', 'dup-e2e-grocery', 'মুদি দোকান', 'Grocery')`;
    await admin`insert into tenant_categories (tenant_id, category_id, is_enabled) values (${TENANT}, ${CATEGORY}, true)`;

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
    tokens.agent = await signer.signAccessToken({
      userId: AGENT,
      tenantId: TENANT,
      memberId: M_AGENT,
      role: 'agent',
    });
    tokens.agent2 = await signer.signAccessToken({
      userId: AGENT2,
      tenantId: TENANT,
      memberId: M_AGENT2,
      role: 'agent',
    });
    tokens.mod = await signer.signAccessToken({
      userId: MOD,
      tenantId: TENANT,
      memberId: M_MOD,
      role: 'moderator',
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    try {
      await cleanUp();
    } finally {
      await admin.end();
    }
  });

  const call = (method: 'GET' | 'POST', url: string, as: keyof typeof tokens, body?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { 'x-tenant-id': TENANT, authorization: `Bearer ${tokens[as]}` },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });
  const add = (
    as: keyof typeof tokens,
    nameBn: string,
    location: { lat: number; lng: number },
    extra = {},
  ) => call('POST', '/places', as, { nameBn, categoryId: CATEGORY, location, ...extra });
  const flagsOf = (placeId: string) =>
    admin<{ candidate_place_id: string; classification_code: string; source_code: string }[]>`
      select candidate_place_id, classification_code, source_code from duplicate_candidates
      where place_id = ${placeId} or candidate_place_id = ${placeId}`;

  let original: Place;

  it('two spellings of the same shop 20 m apart are flagged', async () => {
    const first = await add('agent', 'মায়ের দোয়া স্টোর', BASE, { phone: '01777100500' });
    expect(first.statusCode).toBe(201);
    original = first.json<Place>();

    const second = await add('agent2', 'মায়ের দোআ ষ্টোর', NEAR);
    expect(second.statusCode).toBe(201);
    const spelled = second.json<Place>();
    expect(await flagsOf(spelled.id)).toEqual([
      { candidate_place_id: original.id, classification_code: 'possible', source_code: 'create' },
    ]);
  });

  it('two different shops with similar names 800 m apart are not', async () => {
    const response = await add('agent2', 'মায়ের দোয়া স্টোর', FAR);
    expect(response.statusCode).toBe(201);
    expect(await flagsOf(response.json<Place>().id)).toEqual([]);
  });

  it('a likely duplicate (same name and phone) asks "is this the same place?" first', async () => {
    const held = await add('agent2', 'মায়ের দোয়া স্টোর', NEAR, { phone: '01777100500' });
    expect(held.statusCode).toBe(409);
    const body = held.json<{ error: string; details: { candidates: Candidate[] } }>();
    expect(body.error).toBe('PLACE_LIKELY_DUPLICATE');
    expect(body.details.candidates[0]).toMatchObject({
      placeId: original.id,
      nameBn: 'মায়ের দোয়া স্টোর',
      phoneMatch: true,
      score: 1,
    });
    expect(body.details.candidates[0]!.distanceM).toBeGreaterThan(10);
    expect(body.details.candidates[0]!.distanceM).toBeLessThan(30);

    // "No, it's a different shop": created, but a moderator still looks.
    const anyway = await add('agent2', 'মায়ের দোয়া স্টোর', NEAR, {
      phone: '01777100500',
      confirmNotDuplicate: true,
    });
    expect(anyway.statusCode).toBe(201);
    // Likely against the original (and possible against the other spelling next door).
    expect(await flagsOf(anyway.json<Place>().id)).toContainEqual({
      candidate_place_id: original.id,
      classification_code: 'likely',
      source_code: 'create',
    });
  });

  it('moderators review, merge (the loser redirects), and undo', async () => {
    expect((await call('GET', '/places/duplicates', 'agent')).statusCode).toBe(403);
    const queue = (await call('GET', '/places/duplicates?limit=100', 'mod')).json<{
      items: {
        id: string;
        classification: string;
        entity: { id: string };
        candidate: { id: string };
      }[];
    }>();
    expect(queue.items[0]!.classification).toBe('likely'); // likely first
    const likely = queue.items.find((i) => i.classification === 'likely')!;
    const loserId = likely.entity.id;

    const merged = await call('POST', `/places/${loserId}/merge-into/${original.id}`, 'mod', {
      reasonCode: 'duplicate',
    });
    expect(merged.statusCode).toBe(200);
    const { mergeId, undoUntil } = merged.json<{ mergeId: string; undoUntil: string }>();
    expect(new Date(undoUntil).getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);

    const redirected = (await call('GET', `/places/${loserId}`, 'agent')).json<Place>();
    expect(redirected).toMatchObject({ id: original.id, redirectedFrom: loserId });
    const [pair] =
      await admin`select status_code from duplicate_candidates where id = ${likely.id}`;
    expect(pair).toEqual({ status_code: 'merged' });

    expect((await call('POST', `/place-merges/${mergeId}/undo`, 'mod')).json()).toEqual({
      mergeId,
      restoredPlaceId: loserId,
    });
    expect((await call('GET', `/places/${loserId}`, 'agent')).json<Place>()).toMatchObject({
      id: loserId,
      redirectedFrom: null,
    });
    expect((await call('POST', `/place-merges/${mergeId}/undo`, 'mod')).json()).toMatchObject({
      error: 'PLACE_MERGE_ALREADY_UNDONE',
    });

    // "Not a duplicate": dismissed for good.
    const possible = queue.items.find((i) => i.classification === 'possible')!;
    expect(
      (await call('POST', `/places/duplicates/${possible.id}/dismiss`, 'mod')).statusCode,
    ).toBe(204);
    expect(
      (await call('POST', `/places/duplicates/${possible.id}/dismiss`, 'mod')).statusCode,
    ).toBe(404);
  });

  it('the nightly batch backfills transliterations and flags look-alike stores', async () => {
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`
        insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code, location, phone_e164) values
          (${STORE_A}, ${TENANT}, ${M_AGENT}, 'dup-rahman-1', 'রহমান ফার্মেসি', 'active', 'SRID=4326;POINT(92.46 20.66)', '+8801777100600'),
          (${STORE_B}, ${TENANT}, ${M_AGENT2}, 'dup-rahman-2', 'রহমান ফার্মেসী', 'active', 'SRID=4326;POINT(92.46 20.66025)', null)`;
    });
    const duplicates = app.get(DuplicatesService);
    const context = app.get(TenantContext);
    await context.run({}, () => duplicates.runBatch({ batchSize: 100, maxBatches: 50 }));

    const translit =
      await admin`select name_translit from stores where id in (${STORE_A}, ${STORE_B}) order by id`;
    expect(translit).toEqual([
      { name_translit: 'rohman pharmesi' },
      { name_translit: 'rohman pharmesi' },
    ]);
    const flagged = await admin<
      {
        store_id: string;
        candidate_store_id: string;
        classification_code: string;
        source_code: string;
      }[]
    >`
      select store_id, candidate_store_id, classification_code, source_code from duplicate_candidates
      where entity_type_code = 'store' and tenant_id = ${TENANT}`;
    expect(flagged).toHaveLength(1);
    expect([flagged[0]!.store_id, flagged[0]!.candidate_store_id].sort()).toEqual([
      STORE_A,
      STORE_B,
    ]);
    expect(flagged[0]).toMatchObject({ classification_code: 'likely', source_code: 'batch' });
  });
});
