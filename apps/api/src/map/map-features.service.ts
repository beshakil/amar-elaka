import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { TextCache } from '../cache/cache.service';
import { TenantDb } from '../database/tenant-db';
import { distanceMeters, type BoundingBox } from '../locations/geo/geodesic';
import { LocationsService } from '../locations/locations.service';
import { SettingsService } from '../settings/settings.service';
import type {
  MapDistanceQuery,
  MapDistanceResponse,
  MapFeature,
  MapFeaturesQuery,
  MapFeaturesResponse,
  MapLayer,
} from './map-features.dto';
import { MapFeaturesRepository, type FeatureRow } from './map-features.repository';
import { boxCenter, snapToCell, tileRangeBounds, tilesCovering } from './tiles';

export const MAP_FEATURES_CACHE = Symbol('MAP_FEATURES_CACHE');

const METERS_PER_KM = 1000; // settings-exempt: unit conversion
const METERS_PER_DEGREE_LAT = 111_320; // settings-exempt: metres per degree of latitude (WGS84 mean)
const DEGREES_TO_RADIANS = Math.PI / 180; // settings-exempt: unit conversion
// settings-exempt: cache-key format version; bump when a cached value's shape changes
const CACHE_VERSION = 'v2';
// settings-exempt: a snapped centre's digits in a cache key (~0.1 m, far below a cell)
const KEY_DECIMALS = 6;
/** Layers without opening hours: `open_now` leaves them out. */
const NO_HOURS: readonly MapLayer[] = ['posts', 'stores'];

/** The viewport clamped to the square of side 2·radius around its centre (CLAUDE.md rule 10). */
function clampToRadius(
  box: BoundingBox,
  center: { lat: number; lng: number },
  radiusM: number,
): BoundingBox {
  const dLat = radiusM / METERS_PER_DEGREE_LAT;
  const dLng = radiusM / (METERS_PER_DEGREE_LAT * Math.cos(center.lat * DEGREES_TO_RADIANS));
  return {
    minLng: Math.max(box.minLng, center.lng - dLng),
    minLat: Math.max(box.minLat, center.lat - dLat),
    maxLng: Math.min(box.maxLng, center.lng + dLng),
    maxLat: Math.min(box.maxLat, center.lat + dLat),
  };
}

/**
 * The map's data (ADR 045): GeoJSON for a viewport from our own database —
 * never a geo provider call.
 *
 *   1. The viewport is clamped to map_viewport_max_radius_km around its
 *      centre (discovery is radius-based; tenants never filter what shows),
 *      then rounded out to whole tiles at its zoom.
 *   2. Cached per (layers, filters, zoom, tile-aligned box) for
 *      map_features_cache_seconds, as the JSON text sent: panning inside the
 *      same tiles is free, and a hit is never parsed or re-serialized.
 *      When that box reaches past the radius (zoomed out), the radius is
 *      measured from the viewport centre snapped to the clustering grid, and
 *      that centre joins the key.
 *   3. map_features clusters on a tile-aligned Web Mercator grid below
 *      map_cluster_until_zoom; at most map_features_max features.
 */
@Injectable()
export class MapFeaturesService {
  constructor(
    private readonly repo: MapFeaturesRepository,
    private readonly tenantDb: TenantDb,
    private readonly settings: SettingsService,
    private readonly locations: LocationsService,
    @Inject(MAP_FEATURES_CACHE) private readonly cache: TextCache,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MapFeaturesService.name);
  }

  /** The response as a JSON string (what the controller sends). */
  async features(query: MapFeaturesQuery): Promise<string> {
    const [radiusKm, untilZoom, cap, ttl, defaults, cellPx] = await Promise.all([
      this.settings.get('map_viewport_max_radius_km'),
      this.settings.get('map_cluster_until_zoom'),
      this.settings.get('map_features_max'),
      this.settings.get('map_features_cache_seconds'),
      this.settings.get('map_layers_default'),
      this.settings.get('map_cluster_cell_px'),
    ]);
    const layers = [...(query.layers ?? defaults)].sort();
    const zoom = query.zoom;
    const radiusM = radiusKm * METERS_PER_KM;
    const view = query.bbox;
    const center = boxCenter(view);
    const clipped = distanceMeters(center, { lat: view.maxLat, lng: view.maxLng }) > radiusM;

    const tiles = tilesCovering(clampToRadius(view, center, radiusM), zoom);
    const box = tileRangeBounds(tiles);
    const tilesCenter = boxCenter(box);
    const fits = distanceMeters(tilesCenter, { lat: box.maxLat, lng: box.maxLng }) <= radiusM;
    const radiusCenter = fits ? null : snapToCell(center, zoom, cellPx);
    const openNowSkipped = query.open_now ? layers.filter((l) => NO_HOURS.includes(l)) : [];

    const key = [
      'map:features',
      CACHE_VERSION,
      layers.join('+'),
      query.category ?? '-',
      query.open_now ? 'open' : 'any',
      // clipped is per viewport, so it is part of the cached text's key.
      clipped ? 'clip' : 'fit',
      `${zoom}/${tiles.minX}-${tiles.maxX}/${tiles.minY}-${tiles.maxY}`,
      radiusCenter
        ? `${radiusCenter.lat.toFixed(KEY_DECIMALS)},${radiusCenter.lng.toFixed(KEY_DECIMALS)}`
        : 'tiles',
    ].join(':');
    const cached = await this.safeCache(() => this.cache.getText(key));
    if (cached !== undefined) return cached;

    const rows = await this.tenantDb.transaction(
      (tx) =>
        this.repo.features(tx, {
          box,
          zoom,
          layers,
          category: query.category ?? null,
          openNow: query.open_now,
          center: radiusCenter,
          limit: cap + 1,
        }),
      { accessMode: 'read only' },
    );
    const response: MapFeaturesResponse = {
      type: 'FeatureCollection',
      zoom,
      layers,
      clustered: zoom < untilZoom,
      clipped,
      truncated: rows.length > cap,
      open_now_skipped: openNowSkipped,
      features: rows.slice(0, cap).map((row) => feature(row, Math.min(zoom + 1, untilZoom))),
    };
    const json = JSON.stringify(response);
    await this.safeCache(() => this.cache.setText(key, json, ttl));
    return json;
  }

  /** Straight-line distance from PostGIS, instantly; the road route is a separate, explicit request. */
  async distance(query: MapDistanceQuery): Promise<MapDistanceResponse> {
    const meters = await this.locations.straightLineMeters(query.from, query.to);
    return {
      from: query.from,
      to: query.to,
      straight_line_meters: Math.round(meters),
      route: { method: 'POST', path: '/api/v1/geo/route' },
    };
  }

  private async safeCache<T>(work: () => Promise<T>): Promise<T | undefined> {
    try {
      return await work();
    } catch (error) {
      this.logger.warn({ err: error }, 'map features cache unavailable');
      return undefined;
    }
  }
}

function feature(row: FeatureRow, expansionZoom: number): MapFeature {
  const geometry = { type: 'Point' as const, coordinates: [row.lng, row.lat] };
  if (row.point_count > 1 || row.id === null || row.tenant_id === null) {
    return {
      type: 'Feature',
      geometry,
      properties: {
        cluster: true,
        layer: row.layer,
        count: row.point_count,
        expansion_zoom: expansionZoom,
      },
    };
  }
  return {
    type: 'Feature',
    id: row.id,
    geometry,
    properties: {
      cluster: false,
      layer: row.layer,
      id: row.id,
      tenant_id: row.tenant_id,
      name_bn: row.name_bn,
      name_en: row.name_en,
      category_slug: row.category_slug,
      price: row.price,
      slug: row.slug,
      info_kind: row.info_kind,
      open_now: row.open_now,
    },
  };
}
