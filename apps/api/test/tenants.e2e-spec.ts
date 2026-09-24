import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * Full-stack proof of tenant resolution (all four outcomes), the
 * SUSPENDED/TERMINATED gate and its allowlist, and the three read-only
 * tenant endpoints. Requires `make up` + a migrated test database, same as
 * auth.e2e-spec.ts.
 */

const PARTNER = '0191e3a0-9999-7000-8000-0000000000d9';
const FIXTURE_PREFIX = '0191e3a0-9999-7000-8000-%';

const GEO_AREA_COVERING = '0191e3a0-9999-7000-8000-0000000000e1';
const GEO_AREA_FAR = '0191e3a0-9999-7000-8000-0000000000e2';
const GEO_AREA_SUSPENDED = '0191e3a0-9999-7000-8000-0000000000e3';
const GEO_AREA_TERMINATED = '0191e3a0-9999-7000-8000-0000000000e4';

const TENANT_COVERING = '0191e3a0-9999-7000-8000-00000000000a';
const TENANT_NEAREST = '0191e3a0-9999-7000-8000-00000000000b';
const TENANT_SUSPENDED = '0191e3a0-9999-7000-8000-00000000000c';
const TENANT_TERMINATED = '0191e3a0-9999-7000-8000-00000000000d';

const SLUG_COVERING = 'tenants-e2e-covering';
const CUSTOM_DOMAIN = 'tenants-e2e.example.com';
const ROOT_DOMAIN = process.env.APP_ROOT_DOMAIN ?? 'amarelaka.local';

// Sylhet-area coordinates, deliberately away from the ~90.4,23.8 Dhaka-ish
// cluster other fixture files in this suite use (auth.e2e-spec.ts,
// rls-tenant-isolation.db-spec.ts) — /tenants/nearby scans every tenant with
// no tenant-scoping, so an overlapping fixture elsewhere could otherwise win
// the "nearest" pick instead of this file's own fixture.
const INSIDE_POINT = { lat: 24.9, lng: 91.8 };
const NEAREST_TENANT_POINT = { lat: 24.9, lng: 92.4 };
const NEAR_FALLBACK_POINT = { lat: 24.9, lng: 92.35 };
// The Indian Ocean, thousands of km from any real or fixture tenant — safe
// from collision with whatever else may already be seeded in the test DB.
const FAR_BEYOND_RADIUS_POINT = { lat: 0, lng: 80 };

describe('Tenant resolution + tenant module (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: Sql;

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());

    await admin`
      insert into partners (id, legal_name, display_name, phone_e164) values
        (${PARTNER}, 'Tenants E2E Partner Ltd.', 'Tenants E2E Partner', '+8801911000049')`;

    // A small polygon around INSIDE_POINT (~11km square) — covers it.
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release, boundary) values
        (${GEO_AREA_COVERING}, 3, 'upazila', 'tenants-e2e-covering', 'Tenants E2E Covering Area', 'fixture',
          st_multi(st_geomfromtext('POLYGON((91.75 24.85, 91.85 24.85, 91.85 24.95, 91.75 24.95, 91.75 24.85))', 4326))::geography)`;
    // No boundary at all — always skipped by the containment check, only ever reachable via the nearest-within-radius fallback.
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
        (${GEO_AREA_FAR}, 3, 'upazila', 'tenants-e2e-far', 'Tenants E2E Far Area', 'fixture'),
        (${GEO_AREA_SUSPENDED}, 3, 'upazila', 'tenants-e2e-suspended', 'Tenants E2E Suspended Area', 'fixture'),
        (${GEO_AREA_TERMINATED}, 3, 'upazila', 'tenants-e2e-terminated', 'Tenants E2E Terminated Area', 'fixture')`;

    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, custom_domain, name_bn, name_en, map_center, status_code) values
        (${TENANT_COVERING}, ${PARTNER}, ${GEO_AREA_COVERING}, ${SLUG_COVERING}, ${CUSTOM_DOMAIN}, 'কভারিং', 'Covering',
          st_point(${INSIDE_POINT.lng}, ${INSIDE_POINT.lat})::geography, 'active'),
        (${TENANT_NEAREST}, ${PARTNER}, ${GEO_AREA_FAR}, 'tenants-e2e-nearest', null, 'নিকটতম', 'Nearest',
          st_point(${NEAREST_TENANT_POINT.lng}, ${NEAREST_TENANT_POINT.lat})::geography, 'active'),
        (${TENANT_SUSPENDED}, ${PARTNER}, ${GEO_AREA_SUSPENDED}, 'tenants-e2e-suspended', null, 'সাসপেন্ডেড', 'Suspended',
          st_point(92.6, 25.4)::geography, 'suspended'),
        (${TENANT_TERMINATED}, ${PARTNER}, ${GEO_AREA_TERMINATED}, 'tenants-e2e-terminated', null, 'টার্মিনেটেড', 'Terminated',
          st_point(93.0, 24.5)::geography, 'terminated')`;

    await admin`
      insert into tenant_settings (tenant_id, contact_phone_e164, contact_email, whatsapp_e164, logo_storage_key) values
        (${TENANT_COVERING}, '+8801911000059', 'support@tenants-e2e.example.com', '+8801911000059', 'logos/covering.png')`;

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
  });

  afterAll(async () => {
    await app.close();
    try {
      await admin`delete from tenant_settings where tenant_id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from tenants where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from geo_areas where id::text like ${FIXTURE_PREFIX}`;
      await admin`delete from partners where id::text like ${FIXTURE_PREFIX}`;
    } finally {
      await admin.end();
    }
  });

  describe('resolution precedence', () => {
    it('resolves via X-Tenant-Id', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/tenant/config',
        headers: { 'x-tenant-id': TENANT_COVERING },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ slug: string }>().slug).toBe(SLUG_COVERING);
    });

    it('resolves via subdomain when there is no X-Tenant-Id', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/tenant/config',
        headers: { host: `${SLUG_COVERING}.${ROOT_DOMAIN}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ slug: string }>().slug).toBe(SLUG_COVERING);
    });

    it('resolves via custom domain when the host is not under the root domain', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/tenant/config',
        headers: { host: CUSTOM_DOMAIN },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ slug: string }>().slug).toBe(SLUG_COVERING);
    });

    it('rejects with 400 when nothing resolves, on a non-allowlisted route', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/tenant/config' });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toBe('TENANT_REQUIRED');
    });
  });

  describe('status enforcement + allowlist', () => {
    it('rejects a suspended tenant on a non-allowlisted route', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/tenant/config',
        headers: { 'x-tenant-id': TENANT_SUSPENDED },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json<{ error: string }>().error).toBe('TENANT_SUSPENDED');
    });

    it('rejects a terminated tenant on a non-allowlisted route', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/tenant/config',
        headers: { 'x-tenant-id': TENANT_TERMINATED },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json<{ error: string }>().error).toBe('TENANT_TERMINATED');
    });

    it('health stays reachable with no tenant at all', async () => {
      const response = await app.inject({ method: 'GET', url: '/health/live' });
      expect(response.statusCode).toBe(200);
    });

    it('auth/otp/request stays reachable for a suspended tenant', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/request',
        headers: { 'x-tenant-id': TENANT_SUSPENDED },
        payload: { phone: '+8801799999911' },
      });
      // Not asserting OTP delivery (SMS_PROVIDER is real here, not overridden)
      // — only that TenantGateGuard let a suspended tenant's request through.
      expect(response.statusCode).not.toBe(403);
    });

    it('tenants directory stays reachable with no tenant at all', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/tenants' });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('GET /tenant/config', () => {
    it('returns branding, feature flags and support contact, with ETag + Cache-Control', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/tenant/config',
        headers: { 'x-tenant-id': TENANT_COVERING },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toMatch(/^public, max-age=\d+, must-revalidate$/);
      expect(response.headers.etag).toBeDefined();
      expect(response.json()).toMatchObject({
        slug: SLUG_COVERING,
        support: { phoneE164: '+8801911000059', email: 'support@tenants-e2e.example.com' },
        branding: { logoStorageKey: 'logos/covering.png' },
      });
    });

    it('returns 304 when If-None-Match matches the current ETag', async () => {
      const first = await app.inject({
        method: 'GET',
        url: '/api/v1/tenant/config',
        headers: { 'x-tenant-id': TENANT_COVERING },
      });
      const etag = first.headers.etag as string;

      const second = await app.inject({
        method: 'GET',
        url: '/api/v1/tenant/config',
        headers: { 'x-tenant-id': TENANT_COVERING, 'if-none-match': etag },
      });
      expect(second.statusCode).toBe(304);
    });
  });

  describe('GET /tenants/nearby', () => {
    it('returns the tenant whose boundary covers the point', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/tenants/nearby?lat=${INSIDE_POINT.lat}&lng=${INSIDE_POINT.lng}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ id: string }>().id).toBe(TENANT_COVERING);
    });

    it('falls back to the nearest tenant within range when outside every boundary', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/tenants/nearby?lat=${NEAR_FALLBACK_POINT.lat}&lng=${NEAR_FALLBACK_POINT.lng}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ id: string }>().id).toBe(TENANT_NEAREST);
    });

    it('404s when nothing is within range', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/tenants/nearby?lat=${FAR_BEYOND_RADIUS_POINT.lat}&lng=${FAR_BEYOND_RADIUS_POINT.lng}`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json<{ error: string }>().error).toBe('NO_TENANT_NEARBY');
    });

    it('rejects an out-of-range latitude', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/tenants/nearby?lat=999&lng=90',
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /tenants', () => {
    it('lists active tenants and excludes suspended/terminated ones (a picker for new signups, not a general directory)', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/tenants' });
      expect(response.statusCode).toBe(200);
      const ids = response.json<{ id: string }[]>().map((row) => row.id);
      expect(ids).toEqual(expect.arrayContaining([TENANT_COVERING, TENANT_NEAREST]));
      expect(ids).not.toEqual(expect.arrayContaining([TENANT_SUSPENDED, TENANT_TERMINATED]));
    });
  });
});
