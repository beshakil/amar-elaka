import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { KeyValueCache } from '../../cache/cache.service';
import { SettingsService } from '../../settings/settings.service';
import type {
  GeocodeQuery,
  GeocodeResponse,
  GeocodeResultDto,
  ReverseGeocodeResponse,
} from '../dto/locations.dto';
import { distanceMeters } from '../geo/geodesic';
import type { AreaSearchRow } from '../locations.repository';
import { LocationsService } from '../locations.service';
import {
  GEOCODING_PROVIDER,
  GeocodingUnavailableError,
  type GeocodeResult,
  type GeocodingProvider,
  type GeoPoint,
} from './geocoding.port';

export const GEOCODING_CACHE = Symbol('GEOCODING_CACHE');

// settings-exempt: circuit-breaker window after a provider failure (resilience tuning)
const PROVIDER_COOLDOWN_MS = 30_000;
const SECONDS_PER_DAY = 86_400; // settings-exempt: unit conversion
// settings-exempt: cache-key format version; bump when a cached value's shape changes
const CACHE_VERSION = 'v1';
// settings-exempt: length of the hashed part of a cache key (collision-free in practice)
const CACHE_KEY_HASH_CHARS = 40;

/** The same query, however it was typed, hits the same cache entry. */
export function normalizeQuery(query: string): string {
  return query
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function roundPoint(point: GeoPoint, decimals: number): GeoPoint {
  // settings-exempt: decimal base
  const factor = 10 ** decimals;
  return {
    lat: Math.round(point.lat * factor) / factor,
    lng: Math.round(point.lng * factor) / factor,
  };
}

/**
 * Forward geocode, reverse geocode and autocomplete, with:
 *
 *   - a Redis cache of every provider answer for `geocode_cache_days` (30):
 *     addresses rarely change and each provider call costs money. Reverse
 *     points are rounded (`geocode_reverse_cache_decimals`, ≈ 11 m) so nearby
 *     taps share an entry. A cache outage is logged, never fatal.
 *   - a fallback that never fails the request: when the provider is down
 *     (timeout, 5xx, rate limit, unpaid or missing key), reverse still answers
 *     with the coordinates and our own administrative areas from PostGIS;
 *     forward and autocomplete answer from our area names. `degraded: true`
 *     tells the client. Degraded answers are not cached.
 *   - a short circuit breaker, so an outage doesn't cost every request a timeout.
 */
@Injectable()
export class GeocodingService {
  private providerDownUntil = 0;

  constructor(
    @Inject(GEOCODING_PROVIDER) private readonly provider: GeocodingProvider,
    @Inject(GEOCODING_CACHE) private readonly cache: KeyValueCache,
    private readonly locations: LocationsService,
    private readonly settings: SettingsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(GeocodingService.name);
  }

  async forward(query: GeocodeQuery): Promise<GeocodeResponse> {
    return this.search('forward', query, (q) => this.provider.forward(q));
  }

  async autocomplete(query: GeocodeQuery): Promise<GeocodeResponse> {
    const minChars = await this.settings.get('geocode_autocomplete_min_chars');
    if ([...normalizeQuery(query.q)].length < minChars) {
      return { query: query.q, results: [], degraded: false };
    }
    return this.search('autocomplete', query, (q) => this.provider.autocomplete(q));
  }

  async reverse(point: GeoPoint): Promise<ReverseGeocodeResponse> {
    const [decimals, areas] = await Promise.all([
      this.settings.get('geocode_reverse_cache_decimals'),
      this.locations.areasAt(point.lat, point.lng),
    ]);
    const rounded = roundPoint(point, decimals);
    const answer = await this.cached(`reverse:${rounded.lat},${rounded.lng}`, () =>
      this.provider.reverse(rounded),
    );
    return {
      location: point,
      address: answer.value ? toDto(answer.value, 'provider', point) : null,
      areas,
      degraded: answer.degraded,
    };
  }

  private async search(
    kind: 'forward' | 'autocomplete',
    query: GeocodeQuery,
    call: (q: string) => Promise<GeocodeResult[]>,
  ): Promise<GeocodeResponse> {
    const limit = await this.settings.get('geocode_results_max');
    const q = normalizeQuery(query.q);
    const near =
      query.lat !== undefined && query.lng !== undefined
        ? { lat: query.lat, lng: query.lng }
        : null;
    const answer = await this.cached(`${kind}:${q}`, () => call(q));

    if (!answer.degraded) {
      return {
        query: query.q,
        results: (answer.value ?? []).slice(0, limit).map((r) => toDto(r, 'provider', near)),
        degraded: false,
      };
    }
    const local = await this.localSearch(q, limit);
    return { query: query.q, results: local.map((r) => toDto(r, 'local', near)), degraded: true };
  }

  /** Our own area names, in both scripts: "Trishal, Mymensingh" at the area's centre. */
  private async localSearch(q: string, limit: number): Promise<GeocodeResult[]> {
    try {
      const rows = await this.locations.searchByName(q, limit);
      return rows.map(localResult);
    } catch (error) {
      this.logger.warn({ err: error }, 'local area search failed during geocoding fallback');
      return [];
    }
  }

  /**
   * Cache-aside around a provider call. `degraded` is true when the provider
   * was unavailable (or skipped by the breaker); only real answers are cached.
   */
  private async cached<T>(
    key: string,
    call: () => Promise<T>,
  ): Promise<{ value: T | null; degraded: boolean }> {
    const cacheKey = `geocode:${CACHE_VERSION}:${this.provider.name}:${createHash('sha256').update(key).digest('hex').slice(0, CACHE_KEY_HASH_CHARS)}`;
    const hit = await this.safeCache(() => this.cache.get<{ value: T }>(cacheKey));
    if (hit !== undefined) return { value: hit.value, degraded: false };
    if (Date.now() < this.providerDownUntil) return { value: null, degraded: true };

    let value: T;
    try {
      value = await call();
    } catch (error) {
      if (!(error instanceof GeocodingUnavailableError)) throw error;
      this.providerDownUntil = Date.now() + PROVIDER_COOLDOWN_MS;
      this.logger.warn(
        { reason: error.reason, provider: this.provider.name },
        'geocoding provider unavailable; degrading',
      );
      return { value: null, degraded: true };
    }
    const days = await this.settings.get('geocode_cache_days');
    await this.safeCache(() => this.cache.set(cacheKey, { value }, days * SECONDS_PER_DAY));
    return { value, degraded: false };
  }

  private async safeCache<T>(work: () => Promise<T>): Promise<T | undefined> {
    try {
      return await work();
    } catch (error) {
      this.logger.warn({ err: error }, 'geocoding cache unavailable');
      return undefined;
    }
  }
}

function localResult(row: AreaSearchRow): GeocodeResult {
  const label = row.parent_name_en ? `${row.name_en}, ${row.parent_name_en}` : row.name_en;
  const labelBn = row.name_bn
    ? row.parent_name_bn
      ? `${row.name_bn}, ${row.parent_name_bn}`
      : row.name_bn
    : null;
  return {
    label,
    labelBn,
    location: { lat: row.lat!, lng: row.lng! },
    area: row.name_en,
    city: row.parent_name_en,
    postCode: null,
    providerRef: row.cod_pcode,
  };
}

function toDto(
  result: GeocodeResult,
  source: 'provider' | 'local',
  near: GeoPoint | null,
): GeocodeResultDto {
  return {
    label: result.label,
    labelBn: result.labelBn,
    location: result.location,
    area: result.area,
    city: result.city,
    postCode: result.postCode,
    source,
    distanceMeters: near === null ? null : Math.round(distanceMeters(near, result.location)),
  };
}
