import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { RequestMethod, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Sql } from 'postgres';
import { resolveTestDatabaseUrl, testSqlClient } from './db/test-database';

/**
 * Offline map areas (ADR 050) through the real app and the real go-pmtiles
 * CLI (PMTILES_BIN; installed in CI): the build cuts a tenant's file out of
 * the national fixture archive (z6), GET /map/offline describes it with its
 * fonts and sprites, the file range-reads (resumable downloads), and
 * GET /map/offline/areas gives the outlines. A fake extractor covers the
 * size cap (stepping down a zoom, then too_large), a failing CLI, and a
 * refreshed national archive (a new file, the previous kept one cycle).
 *
 * src/config/env.ts parses process.env on first import: the tiles directory
 * is a copy of apps/e2e/fixtures/map, set up before the app is imported.
 */

const FIXTURE = '0191e3a0-0ff1-7000-8000-%';
const PARTNER = '0191e3a0-0ff1-7000-8000-000000000001';
const AREA = '0191e3a0-0ff1-7000-8000-000000000011';
const UNION = '0191e3a0-0ff1-7000-8000-000000000012';
const TENANT = '0191e3a0-0ff1-7000-8000-000000000021';
const OTHER = '0191e3a0-0ff1-7000-8000-000000000022';
const OTHER_AREA = '0191e3a0-0ff1-7000-8000-000000000013';

const root = mkdtempSync(join(tmpdir(), 'offline-map-e2e-'));
cpSync(join(__dirname, '..', '..', 'e2e', 'fixtures', 'map'), root, { recursive: true });
process.env.MAP_TILES_PATH = root;
process.env.MAP_TILES_PUBLIC_URL = 'https://tiles.amarelaka.test/tiles';

const national = JSON.parse(readFileSync(join(root, 'current.json'), 'utf8')) as {
  version: string;
  file: string;
  maxZoom: number;
};
const square = (west: number, south: number, size: number) =>
  `SRID=4326;MULTIPOLYGON(((${west} ${south},${west + size} ${south},${west + size} ${south + size},${west} ${south + size},${west} ${south})))`;

type Builder = import('../src/map/offline/offline-map.builder').OfflineMapBuilder;
type Extractor = import('../src/map/offline/pmtiles-cli').PmtilesExtractor;

describe('Offline map areas (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: Sql;
  let builder: Builder;
  let makeBuilder: (extractor: Extractor) => Builder;

  async function cleanUp(): Promise<void> {
    await admin`delete from offline_map_files where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenant_settings where tenant_id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();
    await admin`
      insert into partners (id, legal_name, display_name, phone_e164)
      values (${PARTNER}, 'Offline Partner', 'Offline Partner', '+8801700000999')`;
    // An upazila near Mymensingh with one union inside it, and a second tenant.
    await admin`
      insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, name_bn, source_release, boundary, boundary_simplified)
      values
        (${AREA}, 3, 'upazila', 'offline-e2e', 'Offline Upazila', 'অফলাইন উপজেলা', 'fixture',
         ${square(90.3, 24.5, 0.2)}, ${square(90.3, 24.5, 0.2)}),
        (${OTHER_AREA}, 3, 'upazila', 'offline-e2e-o', 'Other', 'অন্য', 'fixture',
         ${square(91.0, 23.0, 0.1)}, ${square(91.0, 23.0, 0.1)})`;
    // ancestor_ids follow parent_id (a trigger keeps them).
    await admin`
      insert into geo_areas (id, parent_id, adm_level, level_code, bbs_code_geocode11, name_en, name_bn, source_release, boundary, boundary_simplified)
      values (${UNION}, ${AREA}, 4, 'union', 'offline-e2e-u', 'Offline Union', 'অফলাইন ইউনিয়ন', 'fixture',
              ${square(90.35, 24.55, 0.05)}, ${square(90.35, 24.55, 0.05)})`;
    await admin`
      insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code)
      values (${TENANT}, ${PARTNER}, ${AREA}, 'offline-e2e', 'অফলাইন', 'Offline', 'SRID=4326;POINT(90.4 24.6)', 'active'),
             (${OTHER}, ${PARTNER}, ${OTHER_AREA}, 'offline-e2e-o', 'অন্য', 'Other', 'SRID=4326;POINT(91.05 23.05)', 'active')`;
    await admin.begin(async (tx) => {
      // OTHER's files are capped at 1 MB (offline_map_max_mb is platform-scoped).
      await tx`select set_config('app.role', 'platform_admin', true)`;
      await tx`insert into tenant_settings (tenant_id, setting_overrides)
               values (${TENANT}, '{}'), (${OTHER}, ${tx.json({ offline_map_max_mb: 1 })})`;
    });

    const { AppModule } = await import('../src/app.module');
    const { OfflineMapBuilder } = await import('../src/map/offline/offline-map.builder');
    const { OfflineMapRepository } = await import('../src/map/offline/offline-map.repository');
    const { MapConfigService } = await import('../src/map/map-config.service');
    const { PMTILES_EXTRACTOR, PmtilesCli } = await import('../src/map/offline/pmtiles-cli');
    const { TenantDb } = await import('../src/database/tenant-db');
    const { TenantContext } = await import('../src/database/tenant-context');
    const { SettingsService } = await import('../src/settings/settings.service');
    const { SettingsModule } = await import('../src/settings/settings.module');
    const { PinoLogger } = await import('nestjs-pino');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, SettingsModule],
      // The worker's builder, beside the app (it lives in WorkerModule).
      providers: [
        OfflineMapBuilder,
        OfflineMapRepository,
        MapConfigService,
        { provide: PMTILES_EXTRACTOR, useClass: PmtilesCli },
      ],
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
    builder = moduleRef.get(OfflineMapBuilder);
    const logger = await moduleRef.resolve(PinoLogger);
    makeBuilder = (extractor) =>
      new OfflineMapBuilder(
        moduleRef.get(TenantDb),
        moduleRef.get(TenantContext),
        moduleRef.get(OfflineMapRepository),
        moduleRef.get(MapConfigService),
        moduleRef.get(SettingsService),
        extractor,
        logger,
      );
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    try {
      await cleanUp();
    } finally {
      await admin.end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  const get = (url: string, tenant = TENANT, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers: { 'x-tenant-id': tenant, ...headers } });
  const rows = (tenant: string) =>
    admin<
      {
        national_version: string;
        status_code: string;
        file_name: string | null;
        max_zoom: number | null;
        sha256: string | null;
      }[]
    >`
      select national_version, status_code, file_name, max_zoom, sha256 from offline_map_files
      where tenant_id = ${tenant} order by built_at`;

  it('before a build, GET /map/offline says there is nothing yet', async () => {
    const response = await get('/api/v1/map/offline');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      available: false,
      reason: 'not_built',
      archive: null,
      totalBytes: 0,
    });
  });

  it("cuts the tenant's area out of the national archive with pmtiles extract", async () => {
    const outcome = await builder.run({ batchSize: 50, maxBatches: 2 });
    expect(outcome.rows).toBeGreaterThanOrEqual(2);
    const [row] = await rows(TENANT);
    expect(row).toMatchObject({
      national_version: national.version,
      status_code: 'ready',
      file_name: `tenants/${TENANT}-${national.version}.pmtiles`,
      // The national fixture stops at z6, below offline_map_max_zoom.
      max_zoom: national.maxZoom,
    });
    const path = join(root, row!.file_name!);
    const bytes = readFileSync(path);
    expect(bytes.subarray(0, 7).toString()).toBe('PMTiles');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(row!.sha256);
    expect(statSync(path).size).toBeLessThan(statSync(join(root, national.file)).size);

    // Nothing to do on the next run: every tenant has this version.
    expect((await builder.run({ batchSize: 50, maxBatches: 2 })).rows).toBe(0);
  });

  it('GET /map/offline describes the file and every asset the style needs, with sizes and checksums', async () => {
    const manifest = (await get('/api/v1/map/offline')).json<{
      available: boolean;
      archive: {
        url: string;
        path: string;
        bytes: number;
        sha256: string;
        version: string;
        bounds: number[];
      };
      assets: { path: string; url: string; bytes: number; sha256: string }[];
      assetsBytes: number;
      totalBytes: number;
      pointSets: { layers: string[]; kinds: string[] | null }[];
      labelLanguage: string;
    }>();
    expect(manifest.available).toBe(true);
    expect(manifest.archive.url).toBe(
      `https://tiles.amarelaka.test/tiles/tenants/${TENANT}-${national.version}.pmtiles`,
    );
    // Boundary 90.3–90.5 × 24.5–24.7 grown by offline_map_buffer_km (2 km).
    const [minLng, minLat, maxLng, maxLat] = manifest.archive.bounds;
    expect(minLng).toBeLessThan(90.3);
    expect(maxLng).toBeGreaterThan(90.5);
    expect(minLat).toBeLessThan(24.5);
    expect(maxLat).toBeGreaterThan(24.7);

    const paths = manifest.assets.map((a) => a.path);
    expect(paths).toContain('fonts/Noto Sans Regular/2304-2559.pbf');
    expect(paths).toContain('fonts/Noto Sans Medium/0-255.pbf');
    expect(paths).toContain('sprites/v4/light.json');
    expect(paths.some((p) => p.startsWith('fonts/bengali/') && p.endsWith('.ttf'))).toBe(true);
    const glyph = manifest.assets.find((a) => a.path === 'fonts/Noto Sans Regular/2304-2559.pbf')!;
    expect(glyph.url).toBe(
      'https://tiles.amarelaka.test/tiles/fonts/Noto%20Sans%20Regular/2304-2559.pbf',
    );
    expect(glyph.sha256).toBe(
      createHash('sha256')
        .update(readFileSync(join(root, glyph.path)))
        .digest('hex'),
    );
    expect(manifest.totalBytes).toBe(manifest.archive.bytes + manifest.assetsBytes);
    expect(manifest.pointSets).toContainEqual({ layers: ['landmarks'], kinds: null });
    expect(['bn', 'en']).toContain(manifest.labelLanguage);
  });

  it('serves the file with byte ranges, so a broken download resumes', async () => {
    const path = `/tiles/tenants/${TENANT}-${national.version}.pmtiles`;
    const whole = await app.inject({ method: 'GET', url: path });
    expect(whole.statusCode).toBe(200);
    expect(whole.headers['cache-control']).toContain('immutable');
    const tail = await app.inject({ method: 'GET', url: path, headers: { range: 'bytes=100-' } });
    expect(tail.statusCode).toBe(206);
    expect(tail.rawPayload.equals(whole.rawPayload.subarray(100))).toBe(true);
  });

  it('GET /map/offline/areas gives the area and the unions inside it, simplified', async () => {
    const areas = (await get('/api/v1/map/offline/areas')).json<{
      type: string;
      features: {
        properties: { id: string; level: string; name_bn: string };
        geometry: { type: string };
      }[];
    }>();
    expect(areas.type).toBe('FeatureCollection');
    expect(areas.features.map((f) => f.properties.id)).toEqual([AREA, UNION]);
    expect(areas.features[1]).toMatchObject({
      properties: { level: 'union', name_bn: 'অফলাইন ইউনিয়ন' },
      geometry: { type: 'MultiPolygon' },
    });
  });

  it('steps a zoom down to fit offline_map_max_mb, and gives up as too_large below the floor', async () => {
    const MB = 1024 * 1024;
    // A fake CLI over a z14 national archive: 3 MB at z14, 0.5 MB below.
    const sizes = (zoom: number) => (zoom >= 14 ? 3 * MB : MB / 2);
    const fake = makeBuilder({
      extract: (_input, output, _bounds, zoom) => {
        writeFileSync(output, Buffer.alloc(sizes(zoom)));
        return Promise.resolve();
      },
    });
    {
      const fitted = await fake.buildTenant(OTHER, {
        ...national,
        maxZoom: 14,
        version: '20990101',
      } as never);
      expect(fitted).toMatchObject({ status: 'ready', maxZoom: 13, bytes: MB / 2 });

      const huge = makeBuilder({
        extract: (_input, output) => {
          writeFileSync(output, Buffer.alloc(2 * MB));
          return Promise.resolve();
        },
      });
      // Too big at every zoom from 14 down to offline_map_min_zoom (11).
      const refused = await huge.buildTenant(OTHER, {
        ...national,
        maxZoom: 14,
        version: '20990102',
      } as never);
      expect(refused).toMatchObject({ status: 'too_large', fileName: null });
    }
  });

  it('records a failing CLI as failed (no detail leaked) and tries it again next run', async () => {
    const { PmtilesExtractError } = await import('../src/map/offline/pmtiles-cli');
    const broken = makeBuilder({
      extract: () => Promise.reject(new PmtilesExtractError('boom: /secret/path', 2)),
    });
    const result = await broken.buildTenant(OTHER, { ...national, version: '20990103' } as never);
    expect(result).toMatchObject({ status: 'failed', error: 'pmtiles extract failed' });
    const [stored] = await admin`
      select status_code, error from offline_map_files where tenant_id = ${OTHER} and national_version = '20990103'`;
    expect(stored).toEqual({ status_code: 'failed', error: 'pmtiles extract failed' });
  });

  it('a refreshed national archive is cut again; the previous file stays one cycle, older ones go', async () => {
    const write = (zoom: number) =>
      makeBuilder({
        extract: (_input, output) => {
          writeFileSync(output, Buffer.from(`PMTiles fake z${zoom}`));
          return Promise.resolve();
        },
      });
    const versions = ['20991101', '20991201', '20991231'];
    for (const version of versions)
      await write(6).buildTenant(TENANT, { ...national, version } as never);
    const ready = (await rows(TENANT))
      .filter((r) => r.status_code === 'ready')
      .map((r) => r.national_version);
    expect(ready).toEqual(['20991201', '20991231']);
    expect(existsSync(join(root, `tenants/${TENANT}-20991101.pmtiles`))).toBe(false);
    expect(existsSync(join(root, `tenants/${TENANT}-${national.version}.pmtiles`))).toBe(false);
    expect(existsSync(join(root, `tenants/${TENANT}-20991231.pmtiles`))).toBe(true);
    // The app is offered the newest.
    const manifest = (await get('/api/v1/map/offline')).json<{ archive: { version: string } }>();
    expect(manifest.archive.version).toBe('20991231');
  });
});
