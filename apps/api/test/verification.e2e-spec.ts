import { createHash } from 'node:crypto';
import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Sql } from 'postgres';
import sharp from 'sharp';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/tokens/token.service';
import { buildPinoHttpOptions } from '../src/logging/pino-http-options';
import { MediaProcessingService } from '../src/media/media-processing.service';
import { MediaWorkerModule } from '../src/media/media-worker.module';
import { STORAGE_SERVICE, type StorageService } from '../src/storage/storage.ports';
import { VerificationJobsService } from '../src/verification/verification-jobs.service';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';
import { startNotificationWorker, type NotificationWorker } from './support/notification-worker';

/**
 * Verification end to end (ADR 062) over HTTP, on real Postgres + Redis and
 * the local storage driver. The owner proves who they are (NID number +
 * selfie), the area's moderator reviews it through short-lived signed URLs,
 * then the owner's store (trade licence PDF + shop-front photo) — and the
 * badge appears. Then the three guarantees asked for:
 *   - documents can't be reached without a signed URL (no public path, a
 *     forged token fails, an expired one fails);
 *   - the raw NID number is never persisted (no column of any table holds
 *     it; no answer echoes it; the logger redacts it);
 *   - an expired verification drops the badge.
 */

const P = '0191e3a0-7e4e-7000-8000-';
const FIXTURE = `${P}%`;
const PARTNER = `${P}000000000001`;
const AREA = `${P}000000000011`;
const TENANT = `${P}000000000021`;
const STORE = `${P}000000000071`;
const STORE_SLUG = 'verify-e2e-store';
// A 13-digit NID, typed with spaces and Bengali digits as people do.
const RAW_NID = '1990269512345';
const TYPED_NID = '১৯৯০ ২৬৯৫ ১২৩৪৫';

type Who = 'owner' | 'mod';
const PEOPLE: Record<Who, { user: string; member: string; role: string; phone: string }> = {
  owner: {
    user: `${P}000000000031`,
    member: `${P}000000000041`,
    role: 'member',
    phone: '+8801871000001',
  },
  mod: {
    user: `${P}000000000032`,
    member: `${P}000000000042`,
    role: 'moderator',
    phone: '+8801872000002',
  },
};

jest.setTimeout(30_000);

describe('Verification (e2e)', () => {
  let admin: Sql;
  let app: NestFastifyApplication;
  let module: TestingModule;
  let processing: MediaProcessingService;
  let storage: StorageService;
  let worker: NotificationWorker;
  const tokens = {} as Record<Who, string>;
  const responses: string[] = [];

  const call = async (method: 'GET' | 'POST', url: string, as: Who, body?: unknown) => {
    const response = await app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { 'x-tenant-id': TENANT, authorization: `Bearer ${tokens[as]}` },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });
    responses.push(response.body);
    return response;
  };

  /** Presign → PUT → confirm → the worker processes it: a ready private upload's id. */
  const upload = async (base: string, bytes: Buffer, contentType: string): Promise<string> => {
    const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
    const presigned = (
      await call('POST', `${base}/evidence`, 'owner', {
        contentType,
        byteSize: bytes.length,
        checksumSha256,
      })
    ).json<{ mediaId: string; upload: { url: string; headers: Record<string, string> } }>();
    const put = await app.inject({
      method: 'PUT',
      url: new URL(presigned.upload.url).pathname,
      headers: presigned.upload.headers,
      payload: bytes,
    });
    expect(put.statusCode).toBe(200);
    expect(
      (await call('POST', `${base}/evidence/${presigned.mediaId}/confirm`, 'owner')).statusCode,
    ).toBe(202);
    expect(await processing.process(TENANT, presigned.mediaId)).toBe('ready');
    return presigned.mediaId;
  };
  const photo = (color: string) =>
    sharp({ create: { width: 64, height: 48, channels: 3, background: color } })
      .withMetadata({ exif: { IFD0: { Copyright: 'gps-should-go' } } })
      .jpeg()
      .toBuffer();
  const pdf = () =>
    Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n');

  const storePage = async () =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/v1/stores/${STORE_SLUG}`,
        headers: { 'x-tenant-id': TENANT },
      })
    ).json<{ isVerified: boolean; verification: { badge: string } }>();

  async function cleanUp(): Promise<void> {
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const table of [
        'moderation_actions',
        'verification_evidence',
        'verifications',
        'media_assets',
        'seller_profiles',
        'member_trust_scores',
        'store_seller_scores',
        'review_prompts',
        'stores',
        'tenant_members',
      ]) {
        await tx.unsafe(`delete from ${table} where tenant_id = $1`, [TENANT]);
      }
      await tx`delete from notification_deliveries where user_id::text like ${FIXTURE}`;
      await tx`delete from notifications where user_id::text like ${FIXTURE}`;
    });
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from user_profiles where user_id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();
    for (const person of Object.values(PEOPLE)) {
      await admin`insert into users (id, phone_e164, phone_verified_at) values (${person.user}, ${person.phone}, now())`;
    }
    await admin`insert into user_profiles (user_id, display_name) values (${PEOPLE.owner.user}, 'রহিম মালিক')`;
    await admin`insert into partners (id, legal_name, display_name, phone_e164)
                values (${PARTNER}, 'Verify Partner', 'Verify Partner', '+8801871000099')`;
    await admin`insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release)
                values (${AREA}, 3, 'upazila', 'verify-e2e', 'Verify', 'fixture')`;
    await admin`insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
                values (${TENANT}, ${PARTNER}, ${AREA}, 'verify-e2e', 'যাচাই', 'Verify', st_point(89.05, 22.75)::geography, 'active')`;
    for (const person of Object.values(PEOPLE)) {
      await admin`insert into tenant_members (id, tenant_id, user_id, role_code)
                  values (${person.member}, ${TENANT}, ${person.user}, ${person.role})`;
    }
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code)
               values (${STORE}, ${TENANT}, ${PEOPLE.owner.member}, ${STORE_SLUG}, 'যাচাই দোকান', 'active')`;
    });
    module = await Test.createTestingModule({ imports: [AppModule, MediaWorkerModule] }).compile();
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
    processing = module.get(MediaProcessingService);
    storage = module.get(STORAGE_SERVICE);
    const signer = module.get(TokenService);
    for (const [who, person] of Object.entries(PEOPLE) as [Who, (typeof PEOPLE)[Who]][]) {
      tokens[who] = await signer.signAccessToken({
        userId: person.user,
        tenantId: TENANT,
        memberId: person.member,
        role: person.role as 'member' | 'moderator',
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

  let identityId = '';
  let businessId = '';
  let evidenceUrl = '';
  let evidenceKey = '';

  it('a store can’t be verified before its owner’s identity', async () => {
    const store = (await call('GET', `/stores/${STORE}/verification`, 'owner')).json<{
      ownerIdentityChecked: boolean;
    }>();
    expect(store.ownerIdentityChecked).toBe(false);
    const licence = await upload(`/stores/${STORE}/verification`, pdf(), 'application/pdf');
    const front = await upload(`/stores/${STORE}/verification`, await photo('#a62'), 'image/jpeg');
    const refused = await call('POST', `/stores/${STORE}/verification`, 'owner', {
      licenceMediaId: licence,
      shopFrontMediaId: front,
    });
    expect(refused.json()).toMatchObject({
      error: 'VERIFICATION_NOT_ALLOWED',
      details: { reason: 'identity_required' },
    });
  });

  it('identity: a malformed NID is refused without echoing it; then submitted with a selfie', async () => {
    const bad = await call('POST', '/me/verifications/identity', 'owner', {
      nid: '12345',
      selfieMediaId: PEOPLE.owner.user,
    });
    expect(bad.json()).toMatchObject({ error: 'VERIFICATION_NID_INVALID' });
    expect(bad.body).not.toContain('12345');
    const selfie = await upload('/me/verifications', await photo('#26a'), 'image/jpeg');
    const sent = await call('POST', '/me/verifications/identity', 'owner', {
      nid: TYPED_NID,
      selfieMediaId: selfie,
    });
    expect(sent.statusCode).toBe(201);
    identityId = sent.json<{ id: string }>().id;
    const mine = (await call('GET', '/me/verifications', 'owner')).json<{
      level: string;
      identityRequest: string;
      items: unknown[];
    }>();
    expect(mine).toMatchObject({ level: 'phone_verified', identityRequest: 'open_request' });
  });

  it('the moderator sees it with signed links only — and the photo lost its metadata', async () => {
    const queue = (await call('GET', '/verifications/queue', 'mod')).json<{
      items: { id: string; nidLast3: string }[];
    }>();
    expect(queue.items).toEqual([expect.objectContaining({ id: identityId, nidLast3: '345' })]);
    const detail = (await call('GET', `/verifications/${identityId}`, 'mod')).json<{
      evidence: { kind: string; url: string; previewUrl: string | null }[];
      urlExpiresInSeconds: number;
    }>();
    expect(detail.urlExpiresInSeconds).toBe(300);
    const selfie = detail.evidence.find((e) => e.kind === 'selfie')!;
    evidenceUrl = selfie.url;
    expect(new URL(selfie.url).pathname.startsWith('/api/v1/storage/files/')).toBe(true);
    const got = await app.inject({ method: 'GET', url: new URL(selfie.url).pathname });
    expect(got.statusCode).toBe(200);
    expect(got.body).not.toContain('gps-should-go');
    const [row] = await admin<{ storage_key: string }[]>`
      select m.storage_key from media_assets m join verification_evidence e on e.media_asset_id = m.id
      where e.verification_id = ${identityId}`;
    evidenceKey = row!.storage_key;
    // Members and strangers: no queue, no evidence.
    expect((await call('GET', '/verifications/queue', 'owner')).statusCode).toBe(403);
    expect((await call('GET', `/verifications/${identityId}`, 'owner')).statusCode).toBe(403);
  });

  it('documents are unreachable without a signed URL: no public path, no forged or expired token', async () => {
    const publicPath = await app.inject({ method: 'GET', url: `/media/${evidenceKey}` });
    expect(publicPath.statusCode).toBe(404);
    const viaApiPublic = await app.inject({ method: 'GET', url: `/api/v1/media/${evidenceKey}` });
    expect(viaApiPublic.statusCode).not.toBe(200);
    const path = new URL(evidenceUrl).pathname;
    const forged = await app.inject({ method: 'GET', url: `${path.slice(0, -4)}AAAA` });
    expect(forged.statusCode).toBe(404);
    const shortLived = await storage.presignDownload('documents', evidenceKey, 1);
    expect(
      (await app.inject({ method: 'GET', url: new URL(shortLived).pathname })).statusCode,
    ).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect(
      (await app.inject({ method: 'GET', url: new URL(shortLived).pathname })).statusCode,
    ).toBe(404);
  });

  it('approved: the owner is identity-checked; then the store, after review, is business-verified', async () => {
    const approved = await call('POST', `/verifications/${identityId}/decision`, 'mod', {
      decision: 'approve',
    });
    expect(approved.json()).toMatchObject({ status: 'approved' });
    expect((await call('GET', '/me/verifications', 'owner')).json()).toMatchObject({
      level: 'identity_checked',
    });

    const licence = await upload(`/stores/${STORE}/verification`, pdf(), 'application/pdf');
    const front = await upload(`/stores/${STORE}/verification`, await photo('#6a2'), 'image/jpeg');
    const sent = await call('POST', `/stores/${STORE}/verification`, 'owner', {
      licenceMediaId: licence,
      shopFrontMediaId: front,
    });
    expect(sent.statusCode).toBe(201);
    businessId = sent.json<{ id: string }>().id;
    const detail = (await call('GET', `/verifications/${businessId}`, 'mod')).json<{
      evidence: { kind: string; mimeType: string | null; url: string; previewUrl: string | null }[];
      ownerLevel: string;
    }>();
    expect(detail.ownerLevel).toBe('identity_checked');
    const licenceView = detail.evidence.find((e) => e.kind === 'trade_licence')!;
    expect(licenceView.mimeType).toBe('application/pdf');
    expect(
      (await app.inject({ method: 'GET', url: new URL(licenceView.url).pathname })).statusCode,
    ).toBe(200);
    expect(detail.evidence.find((e) => e.kind === 'shop_front')!.previewUrl).not.toBeNull();

    expect(
      (
        await call('POST', `/verifications/${businessId}/decision`, 'mod', { decision: 'reject' })
      ).json(),
    ).toMatchObject({
      error: 'VERIFICATION_DECISION_INVALID',
    });
    expect(
      (
        await call('POST', `/verifications/${businessId}/decision`, 'mod', { decision: 'approve' })
      ).json(),
    ).toMatchObject({
      status: 'approved',
    });
    expect(await storePage()).toMatchObject({
      isVerified: true,
      verification: { badge: 'business' },
    });
    expect(await worker.dispatch((n) => n.type === 'verification_approved')).toBe(2);
  });

  it('the raw NID number is never persisted, never answered, and the logger redacts it', async () => {
    const columns = await admin<{ table_name: string; column_name: string }[]>`
      select c.table_name, c.column_name from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
        and c.data_type in ('text', 'character varying', 'jsonb', 'json', 'ARRAY')`;
    const holding: string[] = [];
    for (const { table_name, column_name } of columns) {
      const [hit] = await admin.unsafe<{ n: number }[]>(
        `select count(*)::int as n from public."${table_name}" where "${column_name}"::text like $1 or "${column_name}"::text like $2`,
        [`%${RAW_NID}%`, `%${TYPED_NID}%`],
      );
      if (hit!.n > 0) holding.push(`${table_name}.${column_name}`);
    }
    expect(holding).toEqual([]);
    const all = responses.join('\n');
    expect(all).not.toContain(RAW_NID);
    expect(all).not.toContain(TYPED_NID);
    const redact =
      (buildPinoHttpOptions({ NODE_ENV: 'test' }) as { redact?: string[] }).redact ?? [];
    expect(redact).toEqual(expect.arrayContaining(['req.body.nid', '*.nid']));
  });

  it('an expired verification drops the badge', async () => {
    await admin`update verifications set expires_at = now() - interval '1 minute' where id in (${identityId}, ${businessId})`;
    const jobs = worker.module.get(VerificationJobsService);
    const outcome = await jobs.expireAndRemind({ batchSize: 50, maxBatches: 1 });
    expect(outcome.details).toMatchObject({ expired: 2 });
    expect(await storePage()).toMatchObject({
      isVerified: false,
      verification: { badge: 'phone' },
    });
    expect((await call('GET', '/me/verifications', 'owner')).json()).toMatchObject({
      level: 'phone_verified',
      identityRequest: 'ok',
    });
    expect(await worker.dispatch((n) => n.type === 'verification_expired')).toBe(2);
  });
});
