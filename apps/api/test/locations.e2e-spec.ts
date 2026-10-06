import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Sql } from 'postgres';
import { AppModule } from '../src/app.module';
import {
  importBoundaries,
  importReference,
  PILOT_BOUNDARIES_PATH,
  readBoundaries,
  readReference,
  reparentPointsByContainment,
} from '../src/locations/geo-import/geo-import';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * The location and geocoding routes over HTTP, on the real reference data and
 * the pilot district's boundaries. No Barikoi key is configured in tests, so
 * geocoding runs its fallback path — which must answer, never fail.
 */

interface Area {
  id: string;
  parentId: string | null;
  level: string;
  pcode: string | null;
  name: { bn: string | null; en: string };
  center: { lat: number; lng: number } | null;
  hasChildren: boolean;
}

describe('Locations and geocoding (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: Sql;
  const ids = new Map<string, string>();

  const get = (url: string) => app.inject({ method: 'GET', url: `/api/v1${url}` });

  beforeAll(async () => {
    delete process.env.BARIKOI_API_KEY;
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`select set_config('app.is_platform_admin', 'true', true)`;
      for (const [pcode, id] of await importReference(tx, readReference())) ids.set(pcode, id);
      await importBoundaries(tx, readBoundaries(PILOT_BOUNDARIES_PATH));
      await reparentPointsByContainment(tx);
    });

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
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await admin?.end();
  });

  describe('GET /locations (cascading pickers)', () => {
    it('lists the 8 divisions, in both languages, without a parent', async () => {
      const response = await get('/locations');
      expect(response.statusCode).toBe(200);
      const divisions = response.json<Area[]>();
      expect(divisions).toHaveLength(8);
      expect(divisions.find((d) => d.pcode === 'BD45')).toMatchObject({
        level: 'division',
        name: { bn: 'ময়মনসিংহ', en: 'Mymensingh' },
        hasChildren: true,
      });
    });

    it('walks division → district → upazila → union', async () => {
      const districts = (await get(`/locations?parentId=${ids.get('BD45')}`)).json<Area[]>();
      expect(districts.map((d) => d.name.en)).toEqual([
        'Jamalpur',
        'Mymensingh',
        'Netrakona',
        'Sherpur',
      ]);
      const upazilas = (await get(`/locations?parentId=${ids.get('BD4561')}`)).json<Area[]>();
      expect(upazilas).toHaveLength(14); // 13 upazilas + the city corporation
      const trishal = upazilas.find((u) => u.pcode === 'BD45610094')!;
      expect(trishal).toMatchObject({
        level: 'upazila',
        name: { bn: 'ত্রিশাল' },
        hasChildren: true,
      });
      const unions = (await get(`/locations?parentId=${trishal.id}`)).json<Area[]>();
      expect(unions.map((u) => u.name.en)).toEqual(
        expect.arrayContaining(['Amirabari', 'Trishal Paurashava']),
      );
      expect(unions.every((u) => !u.hasChildren && u.center !== null)).toBe(true);
    });

    it('returns an area with its ancestors, to prefill a picker', async () => {
      const response = await get(`/locations/${ids.get('BD45619413')}`);
      expect(response.statusCode).toBe(200);
      const { area, path } = response.json<{ area: Area; path: Area[] }>();
      expect(area.name).toEqual({ bn: 'আমিরাবাড়ী', en: 'Amirabari' });
      expect(path.map((p) => p.pcode)).toEqual(['BD', 'BD45', 'BD4561', 'BD45610094']);
    });

    it('404s an unknown area and 400s a malformed id', async () => {
      const unknown = await get('/locations?parentId=0191e3a0-0000-7000-8000-00000000dead');
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({ error: 'LOCATION_NOT_FOUND' });
      expect((await get('/locations?parentId=not-a-uuid')).statusCode).toBe(400);
      expect((await get('/locations/0191e3a0-0000-7000-8000-00000000dead')).statusCode).toBe(404);
    });
  });

  describe('GET /locations/viewport', () => {
    it('returns simplified GeoJSON boundaries in view, with attribution', async () => {
      const response = await get('/locations/viewport?bbox=90.30,24.50,90.50,24.65&level=upazila');
      expect(response.statusCode).toBe(200);
      const body = response.json<{
        areas: (Area & { boundary: { type: string } | null })[];
        truncated: boolean;
        attribution: string;
      }>();
      const trishal = body.areas.find((a) => a.pcode === 'BD45610094');
      expect(trishal?.boundary?.type).toBe('MultiPolygon');
      expect(body.truncated).toBe(false);
      expect(body.attribution).toMatch(/Bangladesh Bureau of Statistics/);
      expect((await get('/locations/viewport?bbox=90.5,24.5,90.3,24.65')).statusCode).toBe(400);
    });
  });

  describe('GET /locations/lookup', () => {
    it('names the division, district, upazila and nearest union at a point', async () => {
      const response = await get('/locations/lookup?lat=24.581&lng=90.3939');
      expect(response.statusCode).toBe(200);
      const body = response.json<{ areas: Area[]; tenant: unknown }>();
      expect(body.areas.map((a) => a.level)).toEqual([
        'country',
        'division',
        'district',
        'upazila',
        'pourashava',
      ]);
      expect(body.areas[3]!.name.bn).toBe('ত্রিশাল');
      expect(body.tenant).toBeNull(); // no tenant on this request
    });
  });

  describe('the geo endpoints without a provider (no key: own data answers, never failing)', () => {
    const post = (url: string, body: unknown) =>
      app.inject({ method: 'POST', url: `/api/v1${url}`, payload: body as object });

    it('reverse, purpose=area: our own areas, free, not degraded', async () => {
      const response = await get('/geo/reverse?lat=24.581&lng=90.3939');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        location: { lat: 24.581, lng: 90.3939 },
        purpose: 'area',
        address: null,
        degraded: false,
        areas: expect.arrayContaining([
          expect.objectContaining({ pcode: 'BD45610094' }),
        ]) as unknown,
      });
    });

    it('reverse, purpose=post_location: no address without the provider, but the area names still come back', async () => {
      const response = await get('/geo/reverse?lat=24.581&lng=90.3939&purpose=post_location');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        purpose: 'post_location',
        address: null,
        degraded: true,
        areas: expect.arrayContaining([
          expect.objectContaining({ pcode: 'BD45610094' }),
        ]) as unknown,
      });
    });

    it('autocomplete: our own areas in English or Bengali, tagged own, with distances', async () => {
      const en = await get('/geo/autocomplete?q=Trishal&lat=23.8069&lng=90.3687');
      expect(en.statusCode).toBe(200);
      const body = en.json<{
        degraded: boolean;
        results: { label: string; source: string; kind: string; distanceMeters: number }[];
      }>();
      // The upazila, its pourashava, its union…: enough of our own, so Barikoi isn't needed.
      expect(body.degraded).toBe(false);
      expect(body.results[0]).toMatchObject({
        label: 'Trishal, Mymensingh',
        source: 'own',
        kind: 'area',
      });
      expect(body.results[0]!.distanceMeters).toBeGreaterThan(80_000);

      const bn = await get(`/geo/autocomplete?q=${encodeURIComponent('ত্রিশা')}`);
      expect(bn.json<{ results: { labelBn: string }[] }>().results[0]!.labelBn).toBe(
        'ত্রিশাল, ময়মনসিংহ',
      );
    });

    it('autocomplete: too few of our own results and no provider: degraded, still answers', async () => {
      const response = await get('/geo/autocomplete?q=nowhere-at-all');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ results: [], degraded: true });
    });

    it('route: the straight-line distance from PostGIS, no made-up travel time', async () => {
      const response = await post('/geo/route', {
        from: { lat: 23.7556, lng: 90.3747 },
        to: { lat: 23.7629, lng: 90.3787 },
        mode: 'foot',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ distanceMeters: number }>();
      expect(body).toMatchObject({
        mode: 'foot',
        durationSeconds: null,
        polyline: null,
        source: 'straight_line',
        degraded: true,
      });
      expect(body.distanceMeters).toBeGreaterThan(800);
      expect(body.distanceMeters).toBeLessThan(1000);
    });

    it('validates input, and the old endpoints are gone', async () => {
      expect((await get('/geo/autocomplete')).statusCode).toBe(400);
      expect((await get('/geo/autocomplete?q=x&lat=23.8')).statusCode).toBe(400);
      expect((await get('/geo/reverse?lat=100&lng=90')).statusCode).toBe(400);
      expect((await get('/geo/reverse?lat=24.5&lng=90.3&purpose=district')).statusCode).toBe(400);
      expect((await post('/geo/route', { from: { lat: 23.7, lng: 90.3 } })).statusCode).toBe(400);
      expect(
        (
          await post('/geo/route', {
            from: { lat: 23.7, lng: 90.3 },
            to: { lat: 23.8, lng: 90.4 },
            mode: 'plane',
          })
        ).statusCode,
      ).toBe(400);
      for (const old of [
        '/geocode/forward?q=x',
        '/geocode/reverse?lat=1&lng=1',
        '/geocode/autocomplete?q=xyz',
      ]) {
        expect((await get(old)).statusCode).toBe(404);
      }
      expect((await get('/geo/route?fromLat=1&fromLng=1&toLat=2&toLng=2')).statusCode).toBe(404);
    });
  });

  it('keeps tenant boundaries platform-admin only', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/platform/tenants/0191e3a0-0000-7000-8000-000000000001/boundary',
      payload: { mode: 'polygon' },
    });
    expect(response.statusCode).toBe(401);
  });
});
