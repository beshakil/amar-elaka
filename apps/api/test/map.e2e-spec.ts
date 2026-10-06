import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

/**
 * The self-hosted base map through the real app (ADR 043): the versioned
 * archive under /tiles answers range requests with 206, and GET /map/config
 * points clients at it with the seeded label language and no fallback.
 *
 * src/config/env.ts parses process.env on first import, so the tiles
 * directory is set up before the app is imported (dynamically, below).
 */

const ARCHIVE = 'bd-20990101.pmtiles';
const SIZE = 65_536;
const root = mkdtempSync(join(tmpdir(), 'map-e2e-'));
const bytes = Buffer.from(Array.from({ length: SIZE }, (_, i) => (i * 7) % 256));
writeFileSync(join(root, ARCHIVE), bytes);
writeFileSync(
  join(root, 'current.json'),
  JSON.stringify({
    version: '20990101',
    file: ARCHIVE,
    maxZoom: 14,
    bbox: [87.95, 20.55, 92.75, 26.75],
    bytes: SIZE,
    sha256: 'test',
    source: 'https://build.protomaps.com/20990101.pmtiles',
    builtAt: '2099-01-01T00:00:00Z',
  }),
);
process.env.MAP_TILES_PATH = root;
process.env.MAP_TILES_PUBLIC_URL = 'https://tiles.amarelaka.test/tiles';
process.env.MAP_TILES_CORS_ORIGINS = 'https://*.amarelaka.test';

describe('Base map (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
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
    rmSync(root, { recursive: true, force: true });
  });

  it('serves the archive at /tiles with 206 Partial Content for a range', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/tiles/${ARCHIVE}`,
      headers: { range: 'bytes=0-16383', origin: 'https://mirpur.amarelaka.test' },
    });
    expect(response.statusCode).toBe(206);
    expect(response.headers['content-range']).toBe(`bytes 0-16383/${SIZE}`);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(response.headers['access-control-allow-origin']).toBe('https://mirpur.amarelaka.test');
    expect(response.rawPayload.equals(bytes.subarray(0, 16384))).toBe(true);
  });

  it('is not under the /api prefix and needs no tenant or login', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/v1/tiles/${ARCHIVE}` });
    expect(response.statusCode).toBe(404);
  });

  describe('GET /map/features', () => {
    const features = (query: string) =>
      app.inject({ method: 'GET', url: `/api/v1/map/features?${query}` });

    it('answers an empty viewport (the Bay of Bengal) with an empty FeatureCollection', async () => {
      const response = await features('bbox=89.9,20.6,90.1,20.8&zoom=12');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        type: 'FeatureCollection',
        zoom: 12,
        layers: ['info', 'landmarks', 'places', 'posts', 'stores'],
        clustered: true,
        clipped: false,
        truncated: false,
        open_now_skipped: [],
        features: [],
      });
    });

    it('says when it is clipped to the radius, when it stops clustering, and what open_now skips', async () => {
      const wide = await features('bbox=88.0,20.6,92.7,26.6&zoom=6.7&layers=posts');
      expect(wide.json()).toMatchObject({
        zoom: 6,
        layers: ['posts'],
        clustered: true,
        clipped: true,
      });
      const close = await features(
        'bbox=90.37,23.75,90.38,23.76&zoom=17&layers=places,stores,posts&open_now=true',
      );
      expect(close.json()).toMatchObject({
        clustered: false,
        clipped: false,
        open_now_skipped: ['posts', 'stores'],
      });
    });

    it('validates the viewport, zoom, layers and category', async () => {
      expect((await features('bbox=90.4,23.7,90.3,23.8&zoom=12')).statusCode).toBe(400);
      expect((await features('bbox=90.3,23.7,90.4,23.8&zoom=30')).statusCode).toBe(400);
      expect(
        (await features('bbox=90.3,23.7,90.4,23.8&zoom=12&layers=posts,users')).statusCode,
      ).toBe(400);
      expect(
        (await features('bbox=90.3,23.7,90.4,23.8&zoom=12&category=DROP TABLE')).statusCode,
      ).toBe(400);
      expect((await features('bbox=90.3,23.7,90.4,23.8&zoom=12&open_now=maybe')).statusCode).toBe(
        400,
      );
    });

    it('/map/points is gone', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/map/points?bbox=90.3,23.7,90.4,23.8&zoom=12',
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /map/distance', () => {
    it('answers the straight-line distance from PostGIS, and points at POST /geo/route for the road', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/map/distance?from=23.7556,90.3747&to=23.7629,90.3787',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ straight_line_meters: number }>();
      expect(body).toMatchObject({
        from: { lat: 23.7556, lng: 90.3747 },
        to: { lat: 23.7629, lng: 90.3787 },
        route: { method: 'POST', path: '/api/v1/geo/route' },
      });
      expect(body.straight_line_meters).toBeGreaterThan(800);
      expect(body.straight_line_meters).toBeLessThan(1000);
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/map/distance?from=23.7&to=23.8,90.4' }))
          .statusCode,
      ).toBe(400);
    });
  });

  it('GET /map/config points at the live versioned archive', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/map/config' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      tiles: {
        url: `https://tiles.amarelaka.test/tiles/${ARCHIVE}`,
        version: '20990101',
        maxZoom: 14,
        bounds: [87.95, 20.55, 92.75, 26.75],
      },
      assetsBaseUrl: 'https://tiles.amarelaka.test/tiles',
      labelLanguage: 'en',
      fallbackStyleUrl: null,
    });
  });
});
