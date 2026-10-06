import type { PinoLogger } from 'nestjs-pino';
import type { TextCache } from '../cache/cache.service';
import type { TenantDb } from '../database/tenant-db';
import type { LocationsService } from '../locations/locations.service';
import type { SettingsService } from '../settings/settings.service';
import type { MapFeaturesQuery, MapFeaturesResponse } from './map-features.dto';
import type { FeatureRow, FeaturesRequest } from './map-features.repository';
import { MapFeaturesService } from './map-features.service';

const SETTINGS: Record<string, unknown> = {
  map_viewport_max_radius_km: 25,
  map_cluster_until_zoom: 16,
  map_features_max: 3,
  map_features_cache_seconds: 60,
  map_layers_default: ['posts', 'stores', 'places', 'landmarks', 'info'],
  map_cluster_cell_px: 64,
};

const cluster = (n: number): FeatureRow => ({
  layer: 'posts',
  point_count: n,
  lng: 90.37,
  lat: 23.75,
  id: null,
  tenant_id: null,
  name_bn: null,
  name_en: null,
  category_slug: null,
  price: null,
  slug: null,
  info_kind: null,
  open_now: null,
  kind: 'listings',
});
const point: FeatureRow = {
  ...cluster(1),
  layer: 'places',
  id: 'place-1',
  tenant_id: 'tenant-b',
  name_bn: 'ক্রিসেন্ট লেক',
  name_en: 'Crescent Lake',
  slug: 'crescent-lake',
  open_now: true,
  kind: null,
};

class MemoryCache implements TextCache {
  store = new Map<string, { value: string; ttl: number }>();
  getText(key: string) {
    return Promise.resolve(this.store.get(key)?.value);
  }
  setText(key: string, value: string, ttl: number) {
    this.store.set(key, { value, ttl });
    return Promise.resolve();
  }
}

function setup(rows: FeatureRow[] = [cluster(12), point]) {
  const requests: FeaturesRequest[] = [];
  const repo = {
    features: jest.fn((_tx: unknown, request: FeaturesRequest) => {
      requests.push(request);
      return Promise.resolve(rows);
    }),
  };
  const tenantDb = { transaction: (work: (tx: unknown) => unknown) => work({}) };
  const settings = { get: jest.fn((key: string) => Promise.resolve(SETTINGS[key])) };
  const locations = { straightLineMeters: jest.fn(() => Promise.resolve(871.4)) };
  const cache = new MemoryCache();
  const logger = { setContext: jest.fn(), warn: jest.fn() };
  const service = new MapFeaturesService(
    repo,
    tenantDb as unknown as TenantDb,
    settings as unknown as SettingsService,
    locations as unknown as LocationsService,
    cache,
    logger as unknown as PinoLogger,
  );
  /** The service answers with JSON text; the tests read it back. */
  const features = async (q: MapFeaturesQuery) =>
    JSON.parse(await service.features(q)) as MapFeaturesResponse;
  return { service, features, repo, requests, cache, locations };
}

const query = (
  bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number },
  zoom = 14,
) => ({
  bbox,
  zoom,
  layers: undefined,
  category: undefined,
  open_now: false,
  kinds: undefined as string[] | undefined,
});
const DHANMONDI = { minLng: 90.371, minLat: 23.751, maxLng: 90.379, maxLat: 23.759 };

describe('MapFeaturesService', () => {
  it('returns GeoJSON: clusters with count and expansion zoom, points with both names', async () => {
    const { features } = setup();
    const response = await features(query(DHANMONDI));
    expect(response).toMatchObject({
      type: 'FeatureCollection',
      zoom: 14,
      clustered: true,
      truncated: false,
    });
    expect(response.features[0]).toEqual({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [90.37, 23.75] },
      properties: {
        cluster: true,
        layer: 'posts',
        kind: 'listings',
        count: 12,
        expansion_zoom: 15,
      },
    });
    expect(response.features[1]).toMatchObject({
      type: 'Feature',
      id: 'place-1',
      properties: {
        cluster: false,
        layer: 'places',
        name_bn: 'ক্রিসেন্ট লেক',
        name_en: 'Crescent Lake',
        open_now: true,
      },
    });
  });

  it('asks the database for the tile-aligned box, no centre when it fits the radius', async () => {
    const { service, requests } = setup();
    await service.features(query(DHANMONDI));
    const asked = requests[0]!;
    expect(asked.center).toBeNull();
    expect(asked.box.minLng).toBeLessThanOrEqual(DHANMONDI.minLng);
    expect(asked.box.maxLat).toBeGreaterThanOrEqual(DHANMONDI.maxLat);
    expect(asked.limit).toBe(4); // map_features_max + 1, to know it was cut
    expect(asked.layers).toEqual(['info', 'landmarks', 'places', 'posts', 'stores']);
    expect(asked.kinds).toBeNull();
  });

  it('a small pan inside the same tiles is served from the cache (one database query)', async () => {
    const { service, repo, cache } = setup();
    await service.features(query(DHANMONDI));
    await service.features(
      query({ minLng: 90.372, minLat: 23.752, maxLng: 90.3795, maxLat: 23.7595 }),
    );
    expect(repo.features).toHaveBeenCalledTimes(1);
    const [key, entry] = [...cache.store][0]!;
    expect(key).toMatch(
      /^map:features:v3:info\+landmarks\+places\+posts\+stores:-:\*:any:fit:14\/\d+-\d+\/\d+-\d+:tiles$/,
    );
    expect(entry.ttl).toBe(60);
    // The hit is the cached text itself: never parsed or re-serialized.
    await expect(service.features(query(DHANMONDI))).resolves.toBe(entry.value);
  });

  it('a different layer set, filter or zoom is another cache entry', async () => {
    const { service, repo } = setup();
    await service.features(query(DHANMONDI));
    await service.features({ ...query(DHANMONDI), layers: ['posts'] });
    await service.features({ ...query(DHANMONDI), open_now: true });
    await service.features(query(DHANMONDI, 15));
    await service.features({ ...query(DHANMONDI), kinds: ['bank', 'hospital'] });
    await service.features({ ...query(DHANMONDI), kinds: ['hospital', 'bank'] }); // same set: cached
    expect(repo.features).toHaveBeenCalledTimes(5);
  });

  it('zoomed out past the radius: clipped, measured from the snapped viewport centre (in the key)', async () => {
    const { features, requests, cache } = setup();
    const response = await features(
      query({ minLng: 88.0, minLat: 20.6, maxLng: 92.7, maxLat: 26.6 }, 7),
    );
    expect(response.clipped).toBe(true);
    expect(requests[0]!.center).not.toBeNull();
    expect(requests[0]!.center!.lat).toBeCloseTo(23.6, 0);
    expect([...cache.store.keys()][0]).toMatch(/:\d+\.\d{6},\d+\.\d{6}$/);
  });

  it('caps the features at map_features_max and says it was truncated', async () => {
    const { features } = setup([cluster(9), cluster(5), cluster(3), point]);
    const response = await features(query(DHANMONDI));
    expect(response.truncated).toBe(true);
    expect(response.features).toHaveLength(3);
  });

  it('open_now names the layers it had to skip', async () => {
    const { features } = setup();
    const response = await features({
      ...query(DHANMONDI),
      layers: ['posts', 'places'],
      open_now: true,
    });
    expect(response.open_now_skipped).toEqual(['posts']);
  });

  it('distance: the straight line from PostGIS, and where to ask for the road', async () => {
    const { service, locations } = setup();
    await expect(
      service.distance({
        from: { lat: 23.7556, lng: 90.3747 },
        to: { lat: 23.7629, lng: 90.3787 },
      }),
    ).resolves.toEqual({
      from: { lat: 23.7556, lng: 90.3747 },
      to: { lat: 23.7629, lng: 90.3787 },
      straight_line_meters: 871,
      route: { method: 'POST', path: '/api/v1/geo/route' },
    });
    expect(locations.straightLineMeters).toHaveBeenCalledTimes(1);
  });
});
