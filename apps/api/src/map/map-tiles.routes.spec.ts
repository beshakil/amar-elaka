import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { mapTilesRoutes, originMatcher, tilesCorsOrigins } from './map-tiles.routes';

describe('originMatcher', () => {
  const allowed = originMatcher(['https://amarelaka.com', 'https://*.amarelaka.com']);

  it.each([
    'https://amarelaka.com',
    'https://mirpur.amarelaka.com',
    'https://MIRPUR.amarelaka.com',
  ])('allows %s', (origin) => expect(allowed(origin)).toBe(true));

  it.each([
    'http://mirpur.amarelaka.com', // wrong scheme
    'https://a.b.amarelaka.com', // `*` is one label
    'https://amarelaka.com.evil.com',
    'https://evilamarelaka.com',
    'https://evil.com/?.amarelaka.com',
    'null',
  ])('refuses %s', (origin) => expect(allowed(origin)).toBe(false));

  it('defaults to the root domain and its subdomains', () => {
    expect(
      tilesCorsOrigins({ MAP_TILES_CORS_ORIGINS: undefined, APP_ROOT_DOMAIN: 'amarelaka.com' }),
    ).toEqual(['https://amarelaka.com', 'https://*.amarelaka.com']);
  });
});

describe('mapTilesRoutes (static base map with range requests)', () => {
  const ARCHIVE = 'bd-20990101.pmtiles';
  const SIZE = 100_000;
  const bytes = Buffer.from(Array.from({ length: SIZE }, (_, i) => (i * 31) % 256));
  let root: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'map-tiles-'));
    writeFileSync(join(root, ARCHIVE), bytes);
    mkdirSync(join(root, 'fonts', 'Noto Sans Regular'), { recursive: true });
    writeFileSync(join(root, 'fonts', 'Noto Sans Regular', '0-255.pbf'), 'glyphs');
    writeFileSync(join(root, '.secret'), 'no');
    app = Fastify();
    await app.register(mapTilesRoutes(root, originMatcher(['http://*.localhost:3001'])));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('answers a range request with 206 and exactly those bytes', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/tiles/${ARCHIVE}`,
      headers: { range: 'bytes=0-16383' },
    });
    expect(response.statusCode).toBe(206);
    expect(response.headers['content-range']).toBe(`bytes 0-16383/${SIZE}`);
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.rawPayload.equals(bytes.subarray(0, 16384))).toBe(true);
  });

  it('serves a range from the middle (how PMTiles reads a directory or tile)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/tiles/${ARCHIVE}`,
      headers: { range: 'bytes=50000-50999' },
    });
    expect(response.statusCode).toBe(206);
    expect(response.rawPayload.equals(bytes.subarray(50000, 51000))).toBe(true);
  });

  it('caches the versioned archive forever, the fonts for a day', async () => {
    const archive = await app.inject({ method: 'HEAD', url: `/tiles/${ARCHIVE}` });
    expect(archive.statusCode).toBe(200);
    expect(archive.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(archive.headers.etag).toBeTruthy();

    const font = await app.inject({
      method: 'GET',
      url: '/tiles/fonts/Noto%20Sans%20Regular/0-255.pbf',
    });
    expect(font.statusCode).toBe(200);
    expect(font.headers['cache-control']).toBe('public, max-age=86400');
  });

  it('refuses an unsatisfiable range with 416', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/tiles/${ARCHIVE}`,
      headers: { range: `bytes=${SIZE + 10}-${SIZE + 20}` },
    });
    expect(response.statusCode).toBe(416);
  });

  it('reflects an allowed web origin and exposes the headers PMTiles reads', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/tiles/${ARCHIVE}`,
      headers: { range: 'bytes=0-99', origin: 'http://mirpur.localhost:3001' },
    });
    expect(response.statusCode).toBe(206);
    expect(response.headers['access-control-allow-origin']).toBe('http://mirpur.localhost:3001');
    expect(response.headers['access-control-expose-headers']).toContain('Content-Range');
    expect(response.headers.vary).toContain('Origin');
  });

  it('gives no CORS grant to other origins', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/tiles/${ARCHIVE}`,
      headers: { range: 'bytes=0-99', origin: 'https://evil.example' },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers the CORS preflight for a Range header', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: `/tiles/${ARCHIVE}`,
      headers: {
        origin: 'http://mirpur.localhost:3001',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'range',
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-headers']).toContain('Range');
  });

  it('serves nothing outside the directory, no dotfiles and no listing', async () => {
    for (const url of [
      '/tiles/../package.json',
      '/tiles/%2e%2e/package.json',
      '/tiles/.secret',
      '/tiles/',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      expect([403, 404]).toContain(response.statusCode);
    }
  });
});
