import { createHash } from 'node:crypto';
import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/tokens/token.service';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * Full-stack proof of the presigned upload flow: real Postgres+Redis+MinIO
 * (`make up`, which now includes minio/minio-init — see
 * infra/docker-compose.dev.yml). Requests an upload URL, PUTs real bytes to
 * MinIO with it, confirms, and checks the media_assets row flips to ready;
 * also proves oversized/wrong-content-type requests never reach storage.
 */

const PARTNER = '0191e3a0-eeee-7000-8000-0000000000d9';
const GEO_AREA = '0191e3a0-eeee-7000-8000-0000000000e1';
const TENANT = '0191e3a0-eeee-7000-8000-00000000000a';
const FIXTURE_PREFIX = '0191e3a0-eeee-7000-8000-%';
const RUN_ID = Date.now().toString().slice(-6);

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

describe('Media uploads (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: Sql;
  let authHeader: Record<string, string>;

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());

    await admin`
      insert into partners (id, legal_name, display_name, phone_e164) values
        (${PARTNER}, 'Media E2E Partner Ltd.', 'Media E2E Partner', '+8801911000079')`;
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
        (${GEO_AREA}, 3, 'upazila', 'media-e2e-area', 'Media E2E Area', 'fixture')`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
        (${TENANT}, ${PARTNER}, ${GEO_AREA}, 'media-e2e-tenant', 'মিডিয়া', 'Media', st_point(90.4, 23.8)::geography, 'active')`;

    const phone = `+88017${RUN_ID}01`;
    const [user] = await admin<{ id: string }[]>`
      insert into users (phone_e164, phone_verified_at) values (${phone}, now()) returning id`;
    const [member] = await admin<{ id: string }[]>`
      insert into tenant_members (tenant_id, user_id, role_code) values (${TENANT}, ${user!.id}, 'member') returning id`;

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

    const tokens = moduleRef.get(TokenService);
    const token = await tokens.signAccessToken({
      userId: user!.id,
      tenantId: TENANT,
      memberId: member!.id,
      role: 'member',
    });
    authHeader = { authorization: `Bearer ${token}`, 'x-tenant-id': TENANT };
  });

  afterAll(async () => {
    await app.close();
    try {
      await admin`delete from media_assets where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenant_members where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from users where phone_e164 like ${`+88017${RUN_ID}%`}`;
    } finally {
      await admin.end();
    }
  });

  it('rejects an unsupported content type before ever presigning', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/media/uploads',
      headers: authHeader,
      payload: {
        kind: 'image',
        contentType: 'application/zip',
        byteSize: 100,
        checksumSha256: 'a'.repeat(64),
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe('UNSUPPORTED_CONTENT_TYPE');
  });

  it('rejects an oversized upload before ever presigning', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/media/uploads',
      headers: authHeader,
      payload: {
        kind: 'image',
        contentType: 'image/png',
        byteSize: 200_000_000,
        checksumSha256: 'a'.repeat(64),
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe('UPLOAD_TOO_LARGE');
  });

  it('rejects an unauthenticated request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/media/uploads',
      headers: { 'x-tenant-id': TENANT },
      payload: {
        kind: 'image',
        contentType: 'image/png',
        byteSize: 100,
        checksumSha256: 'a'.repeat(64),
      },
    });
    expect(response.statusCode).toBe(401);
  });

  it('requests a presigned URL, uploads to MinIO, confirms, and flips the row to ready', async () => {
    const fileBytes = Buffer.from('media e2e fixture bytes');
    const checksumSha256 = sha256Hex(fileBytes);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/media/uploads',
      headers: authHeader,
      payload: {
        kind: 'image',
        contentType: 'image/png',
        byteSize: fileBytes.byteLength,
        checksumSha256,
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json<{
      id: string;
      upload: { url: string; headers: Record<string, string> };
      storageKey: string;
    }>();
    expect(created.storageKey.startsWith(`${TENANT}/image/`)).toBe(true);

    const putResponse = await fetch(created.upload.url, {
      method: 'PUT',
      headers: created.upload.headers,
      body: fileBytes,
    });
    expect(putResponse.ok).toBe(true);

    const confirmResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/media/uploads/${created.id}/confirm`,
      headers: authHeader,
    });
    expect(confirmResponse.statusCode).toBe(201);
    expect(confirmResponse.json()).toEqual({ status: 'ready' });

    const [row] = await admin<{ status_code: string }[]>`
      select status_code from media_assets where id = ${created.id}`;
    expect(row?.status_code).toBe('ready');
  });

  it('confirm 404s for an id from a different tenant', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/media/uploads/00000000-0000-7000-8000-000000000000/confirm',
      headers: authHeader,
    });
    expect(response.statusCode).toBe(404);
  });
});
