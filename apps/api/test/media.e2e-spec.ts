import { createHash } from 'node:crypto';
import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import sharp from 'sharp';
import { TokenService } from '../src/auth/tokens/token.service';
import { MediaProcessingService } from '../src/media/media-processing.service';
import { MediaWorkerModule } from '../src/media/media-worker.module';
import { STORAGE_SERVICE, type StorageService } from '../src/storage/storage.ports';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * The media pipeline end to end on real Postgres + Redis + MinIO (`make up`):
 * presign, PUT real bytes straight to MinIO (never through the API), confirm,
 * then the worker step: metadata stripped (a JPEG with GPS EXIF comes back
 * without it), thumb/card/full WebP variants in storage, a ThumbHash, `ready`.
 * Also: wrong type or size never gets a URL, and a file that only *claims* to
 * be an image is rejected on confirm by its magic bytes and deleted.
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
  let processing: MediaProcessingService;
  let storage: StorageService;

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

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, MediaWorkerModule],
    }).compile();
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

    processing = moduleRef.get(MediaProcessingService);
    storage = moduleRef.get<StorageService>(STORAGE_SERVICE);
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

  async function presign(bytes: Buffer, contentType: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/media/presign',
      headers: authHeader,
      payload: {
        kind: 'image',
        contentType,
        byteSize: bytes.byteLength,
        checksumSha256: sha256Hex(bytes),
      },
    });
  }

  async function upload(bytes: Buffer, contentType: string) {
    const response = await presign(bytes, contentType);
    expect(response.statusCode).toBe(201);
    const created = response.json<{
      id: string;
      storageKey: string;
      upload: { url: string; headers: Record<string, string> };
    }>();
    const put = await fetch(created.upload.url, {
      method: 'PUT',
      headers: created.upload.headers,
      body: bytes,
    });
    expect(put.ok).toBe(true);
    return created;
  }

  it('rejects an unsupported content type or an oversized file before presigning', async () => {
    const gif = await app.inject({
      method: 'POST',
      url: '/api/v1/media/presign',
      headers: authHeader,
      payload: {
        kind: 'image',
        contentType: 'image/gif',
        byteSize: 10,
        checksumSha256: 'a'.repeat(64),
      },
    });
    expect(gif.statusCode).toBe(400);
    expect(gif.json()).toMatchObject({ error: 'UNSUPPORTED_CONTENT_TYPE' });

    const huge = await app.inject({
      method: 'POST',
      url: '/api/v1/media/presign',
      headers: authHeader,
      payload: {
        kind: 'image',
        contentType: 'image/jpeg',
        byteSize: 500_000_000,
        checksumSha256: 'a'.repeat(64),
      },
    });
    expect(huge.statusCode).toBe(400);
    expect(huge.json()).toMatchObject({ error: 'UPLOAD_TOO_LARGE' });
  });

  it('confirm before the PUT says the file is missing', async () => {
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123' } })
      .png()
      .toBuffer();
    const response = await presign(bytes, 'image/png');
    const { id } = response.json<{ id: string }>();
    const confirm = await app.inject({
      method: 'POST',
      url: `/api/v1/media/${id}/confirm`,
      headers: authHeader,
    });
    expect(confirm.statusCode).toBe(409);
  });

  it('processes a real photo: EXIF stripped, WebP variants, ThumbHash, ready', async () => {
    // 2000x1500 JPEG carrying GPS coordinates in its EXIF.
    const photo = await sharp({
      create: { width: 2000, height: 1500, channels: 3, background: { r: 30, g: 140, b: 90 } },
    })
      .jpeg({ quality: 85 })
      .withExif({
        IFD0: { Make: 'TestCam' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '23/1 48/1 0/1' },
      })
      .toBuffer();
    expect((await sharp(photo).metadata()).exif).toBeDefined();

    const created = await upload(photo, 'image/jpeg');
    const confirm = await app.inject({
      method: 'POST',
      url: `/api/v1/media/${created.id}/confirm`,
      headers: authHeader,
    });
    expect(confirm.statusCode).toBe(202);
    expect(confirm.json()).toMatchObject({ status: 'processing' });

    // The worker step (in production: the `media` queue, media.processor.ts).
    expect(await processing.process(TENANT, created.id)).toBe('ready');

    const status = await app.inject({
      method: 'GET',
      url: `/api/v1/media/${created.id}`,
      headers: authHeader,
    });
    const body = status.json<{
      status: string;
      width: number;
      height: number;
      thumbhash: string;
      variants: Record<'thumb' | 'card' | 'full', { url: string; width: number; height: number }>;
    }>();
    expect(body).toMatchObject({ status: 'ready', width: 2000, height: 1500 });
    expect(body.thumbhash.length).toBeGreaterThan(10);
    expect([body.variants.thumb.width, body.variants.card.width, body.variants.full.width]).toEqual(
      [200, 600, 1200],
    );

    const stored = await storage.getObject('media', created.storageKey);
    const meta = await sharp(stored).metadata();
    expect(meta.exif).toBeUndefined();
    const full = await storage.getObject('media', `${created.storageKey}.full.webp`);
    expect((await sharp(full).metadata()).format).toBe('webp');
  });

  it('rejects a file that only claims to be an image, by its magic bytes, and deletes it', async () => {
    const fake = Buffer.from('<html><script>alert(1)</script></html>');
    const created = await upload(fake, 'image/png');
    const confirm = await app.inject({
      method: 'POST',
      url: `/api/v1/media/${created.id}/confirm`,
      headers: authHeader,
    });
    expect(confirm.statusCode).toBe(422);
    expect(confirm.json()).toMatchObject({ error: 'UPLOAD_REJECTED' });
    expect(await storage.head('media', created.storageKey)).toBeUndefined();
  });

  it("404s for an id that is not the caller's", async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/media/00000000-0000-7000-8000-000000000000/confirm',
      headers: authHeader,
    });
    expect(response.statusCode).toBe(404);
  });
});
