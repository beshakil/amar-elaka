import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { KeyValueCache } from '../../cache/cache.service';
import { TenantContext } from '../../database/tenant-context';
import { SettingsService } from '../../settings/settings.service';
import { distanceMeters } from '../geo/geodesic';
import { geohash } from '../geo/geohash';
import { LocationsService } from '../locations.service';
import { GeoBudgetAlerts } from './geo-budget-alerts';
import { GEO_BUDGET_STORE, type GeoBudgetStore } from './geo-budget.store';
import { GeoCallLog, type GeoCallStatus } from './geo-call-log';
import { GeoRateLimitedException } from './geo.exceptions';
import type {
  GeoAutocompleteQuery,
  GeoAutocompleteResponse,
  GeoReverseQuery,
  GeoReverseResponse,
  GeoRouteBody,
  GeoRouteResponse,
  GeoSuggestion,
} from './geo.dto';
import {
  GEO_PROVIDERS,
  GeoProviderError,
  type Candidate,
  type GeoEndpoint,
  type GeoPoint,
  type GeoProvider,
  type ReverseField,
  type Suggestion,
} from './geo-provider.port';
import { NullProvider } from './providers/null.provider';
import { OwnGeoLookup, type OwnGeoResult } from './own-geo-lookup';

export const GEOCODING_CACHE = Symbol('GEOCODING_CACHE');

const SECONDS_PER_MINUTE = 60; // settings-exempt: unit conversion
const SECONDS_PER_HOUR = 3_600; // settings-exempt: unit conversion
const SECONDS_PER_DAY = 86_400; // settings-exempt: unit conversion
const MS_PER_SECOND = 1_000; // settings-exempt: unit conversion
// settings-exempt: a day's budget counter outlives its Dhaka day in any timezone
const BUDGET_KEY_TTL_SECONDS = 2 * SECONDS_PER_DAY;
// settings-exempt: cache-key format version; bump when a cached value's shape changes
const CACHE_VERSION = 'v3';
// settings-exempt: length of the hashed part of a cache key (collision-free in practice)
const CACHE_KEY_HASH_CHARS = 40;
/** The Bengali Unicode block: a query written in it asks for the provider's Bengali variant. */
const BENGALI = /[ঀ-৿]/;

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

/** Today in Bangladesh (YYYY-MM-DD): the day the budget is counted over. */
export function dhakaDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(now);
}

function statusOf(error: GeoProviderError): GeoCallStatus {
  switch (error.reason) {
    case 'rate_limited':
      return 'rate_limited';
    case 'unauthorized':
      return 'unauthorized';
    case 'timeout':
      return 'timeout';
    default:
      return 'error';
  }
}

/** Whether a failure should open the circuit breaker: the provider is struggling, not refusing us. */
function trips(error: GeoProviderError): boolean {
  return ['rate_limited', 'timeout', 'network', 'server_error'].includes(error.reason);
}

type Answer<T> = { value: T | null; degraded: boolean };

/**
 * The geo provider layer (ADR 044): the only way anything reaches a geo
 * provider. For every request:
 *
 *   1. Own data first — places, landmarks, stores and geo_areas. Autocomplete
 *      asks Barikoi only below `geo_own_results_min`; reverse geocoding always
 *      answers areas from geo_areas, and asks Barikoi only for a purpose that
 *      shows a street address, with only that purpose's fields.
 *   2. Cache — every provider answer, `geo_cache_ttl_hours`. Reverse answers
 *      are keyed by the point's geohash (`reverse_geocode_cache_precision`),
 *      routes by rounded endpoints (`route_point_decimals`).
 *   3. Provider choice — `geo_provider` (barikoi | null), else NullProvider
 *      without a key, while the breaker is open, or over budget.
 *   4. Budget — `barikoi_daily_call_budget`, in Barikoi CALLS (settings
 *      barikoi_cost_*), reserved before the call, per Asia/Dhaka day; one
 *      alert at `barikoi_budget_warn_pct`, one at 100%, then NullProvider
 *      until midnight.
 *   5. Log — one geo_provider_calls row per request: a call, a cache hit, or
 *      a refusal.
 *   6. Never fatal — 429/timeout open the breaker (`geo_breaker_cooldown_seconds`)
 *      and our own data answers; straight-line distance is PostGIS, never a call.
 */
@Injectable()
export class GeoService {
  private breakerOpenUntil = 0;
  private readonly providers: Map<string, GeoProvider>;

  constructor(
    @Inject(GEO_PROVIDERS) providers: readonly GeoProvider[],
    private readonly nullProvider: NullProvider,
    @Inject(GEOCODING_CACHE) private readonly cache: KeyValueCache,
    @Inject(GEO_BUDGET_STORE) private readonly budget: GeoBudgetStore,
    private readonly callLog: GeoCallLog,
    private readonly alerts: GeoBudgetAlerts,
    private readonly own: OwnGeoLookup,
    private readonly locations: LocationsService,
    private readonly settings: SettingsService,
    private readonly tenantContext: TenantContext,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(GeoService.name);
    this.providers = new Map(providers.map((p) => [p.name, p]));
  }

  async autocomplete(
    query: GeoAutocompleteQuery,
    clientKey: string,
  ): Promise<GeoAutocompleteResponse> {
    const [minChars, perMinute, limit, ownMin, radiusKm] = await Promise.all([
      this.settings.get('geocode_autocomplete_min_chars'),
      this.settings.get('geo_autocomplete_per_client_per_minute'),
      this.settings.get('geocode_results_max'),
      this.settings.get('geo_own_results_min'),
      this.settings.get('geo_own_radius_km'),
    ]);
    const q = normalizeQuery(query.q);
    if ([...q].length < minChars) return { query: query.q, results: [], degraded: false };
    await this.limit(`autocomplete:${clientKey}`, perMinute, SECONDS_PER_MINUTE);

    const near =
      query.lat !== undefined && query.lng !== undefined
        ? { lat: query.lat, lng: query.lng }
        : null;
    const own = (await this.own.search(q, near, radiusKm, limit)).map((r) =>
      ownSuggestion(r, near),
    );
    if (own.length >= ownMin) return { query: query.q, results: own, degraded: false };

    const bangla = BENGALI.test(q);
    const cost = await this.settings.get('barikoi_cost_autocomplete');
    const answer = await this.paid<Suggestion[]>(
      'autocomplete',
      `autocomplete:${bangla ? 'bn' : 'en'}:${q}`,
      cost,
      (provider) => provider.autocomplete(q, near ?? undefined, { bangla }),
    );
    const fromProvider = (answer.value ?? []).map((r) => providerSuggestion(r, near));
    return {
      query: query.q,
      results: [...own, ...fromProvider].slice(0, limit),
      degraded: answer.degraded,
    };
  }

  async reverse(query: GeoReverseQuery): Promise<GeoReverseResponse> {
    const location = { lat: query.lat, lng: query.lng };
    const areas = await this.locations.areasAt(query.lat, query.lng);
    if (query.purpose === 'area') {
      return { location, purpose: query.purpose, address: null, areas, degraded: false };
    }
    const [fields, base, perField, precision] = await Promise.all([
      this.settings.get(`geo_reverse_fields_${query.purpose}`),
      this.settings.get('barikoi_cost_reverse_base'),
      this.settings.get('barikoi_cost_reverse_per_field'),
      this.settings.get('reverse_geocode_cache_precision'),
    ]);
    const asked: ReverseField[] = [...new Set(fields)].sort();
    const cell = geohash(query.lat, query.lng, precision);
    const answer = await this.paid(
      'reverse',
      `reverse:${cell}:${asked.join(',')}`,
      base + perField * asked.length,
      (provider) => provider.reverseGeocode(query.lat, query.lng, asked),
    );
    const address = answer.value;
    return {
      location,
      purpose: query.purpose,
      address: address
        ? {
            label: address.label,
            labelBn: address.labelBn,
            area: address.area,
            city: address.city,
            postCode: address.postCode,
            source: 'barikoi',
          }
        : null,
      areas,
      degraded: answer.degraded,
    };
  }

  async route(body: GeoRouteBody, clientKey: string): Promise<GeoRouteResponse> {
    const [perHour, decimals, cost] = await Promise.all([
      this.settings.get('route_requests_per_client_per_hour'),
      this.settings.get('route_point_decimals'),
      this.settings.get('barikoi_cost_route'),
    ]);
    await this.limit(`route:${clientKey}`, perHour, SECONDS_PER_HOUR);
    const a = roundPoint(body.from, decimals);
    const b = roundPoint(body.to, decimals);
    const answer = await this.paid(
      'route',
      `route:${body.mode}:${a.lat},${a.lng};${b.lat},${b.lng}`,
      cost,
      (provider) => provider.route(a, b, body.mode),
    );
    if (answer.value) {
      return {
        mode: body.mode,
        distanceMeters: Math.round(answer.value.distanceMeters),
        durationSeconds: Math.round(answer.value.durationSeconds),
        polyline: answer.value.polyline ?? null,
        source: 'barikoi',
        degraded: false,
      };
    }
    return {
      mode: body.mode,
      distanceMeters: Math.round(await this.locations.straightLineMeters(body.from, body.to)),
      durationSeconds: null,
      polyline: null,
      source: 'straight_line',
      degraded: answer.degraded,
    };
  }

  /** Free-text address → candidates (Rupantor). Bulk/agent use only: no client endpoint calls this. */
  async geocodeAddress(text: string): Promise<{ candidates: Candidate[]; degraded: boolean }> {
    const cost = await this.settings.get('barikoi_cost_rupantor');
    const q = normalizeQuery(text);
    const answer = await this.paid('geocode_address', `geocode_address:${q}`, cost, (provider) =>
      provider.geocodeAddress(q),
    );
    return { candidates: answer.value ?? [], degraded: answer.degraded };
  }

  /** The provider `geo_provider` names, or NullProvider when it can't be used. */
  private async provider(): Promise<GeoProvider> {
    const name = await this.settings.get('geo_provider');
    const provider = this.providers.get(name);
    return provider?.configured ? provider : this.nullProvider;
  }

  /** Per-client window (user, else IP); Redis down lets it through — the budget still caps spend. */
  private async limit(key: string, max: number, windowSeconds: number): Promise<void> {
    const allowed = await this.budget.hit(`geo:client:${hash(key)}`, max, windowSeconds);
    if (allowed === false) throw new GeoRateLimitedException();
  }

  /**
   * One provider request with everything around it. `degraded` is true when
   * the provider was needed but not used (disabled, breaker, over budget,
   * failure); the answer is then null and callers use our own data.
   */
  private async paid<T>(
    endpoint: GeoEndpoint,
    key: string,
    cost: number,
    call: (provider: GeoProvider) => Promise<T | null>,
  ): Promise<Answer<T>> {
    const provider = await this.provider();
    const tenantId = this.tenantContext.current()?.tenantId ?? null;
    const log = (
      status: GeoCallStatus,
      calls: number,
      latencyMs: number | null,
      cacheHit = false,
    ) =>
      void this.callLog.record({
        provider: provider.name,
        endpoint,
        callsCounted: calls,
        cacheHit,
        latencyMs,
        status,
        tenantId,
      });

    const cacheKey = `geo:${CACHE_VERSION}:${provider.name}:${hash(key)}`;
    const hit = await this.safeCache(() => this.cache.get<{ value: T | null }>(cacheKey));
    if (hit !== undefined) {
      log('cache_hit', 0, 0, true);
      return { value: hit.value, degraded: false };
    }
    if (provider === this.nullProvider || Date.now() < this.breakerOpenUntil) {
      log('disabled', 0, null);
      return { value: null, degraded: true };
    }

    const day = dhakaDay(new Date());
    const budgetKey = `geo:budget:${provider.name}:${day}`;
    const [budget, warnPct] = await Promise.all([
      this.settings.get('barikoi_daily_call_budget'),
      this.settings.get('barikoi_budget_warn_pct'),
    ]);
    const total = await this.reserve(provider.name, budgetKey, cost, budget);
    if (total === null) {
      log('over_budget', 0, null);
      if (budget > 0) void this.alerts.exhausted(provider.name, day, budget);
      return { value: null, degraded: true };
    }
    void this.alerts.afterReserve(provider.name, day, total, budget, warnPct);

    const started = Date.now();
    let value: T | null;
    try {
      value = await call(provider);
    } catch (error) {
      if (!(error instanceof GeoProviderError)) throw error;
      if (!error.reachedProvider) await this.budget.release(budgetKey, cost);
      if (trips(error)) {
        const cooldown = await this.settings.get('geo_breaker_cooldown_seconds');
        this.breakerOpenUntil = Date.now() + cooldown * MS_PER_SECOND;
      }
      log(statusOf(error), error.reachedProvider ? cost : 0, Date.now() - started);
      this.logger.warn(
        { reason: error.reason, provider: provider.name, endpoint },
        'geo provider unavailable; own data answers',
      );
      return { value: null, degraded: true };
    }

    const empty = value === null || (Array.isArray(value) && value.length === 0);
    log(empty ? 'empty' : 'ok', cost, Date.now() - started);
    const hours = await this.settings.get('geo_cache_ttl_hours');
    await this.safeCache(() => this.cache.set(cacheKey, { value }, hours * SECONDS_PER_HOUR));
    return { value, degraded: false };
  }

  /** Takes `cost` calls out of today's budget: the day's new total, or null when there isn't enough left. */
  private async reserve(
    provider: string,
    budgetKey: string,
    cost: number,
    budget: number,
  ): Promise<number | null> {
    if (budget <= 0) return null;
    const reserved = await this.budget.reserve(budgetKey, cost, budget, BUDGET_KEY_TTL_SECONDS);
    if (reserved !== null) return reserved.ok ? reserved.total : null;
    // Redis can't count: geo_provider_calls can (slower, and fine while Redis is down).
    try {
      const total = (await this.callLog.callsToday(provider)) + cost;
      return total <= budget ? total : null;
    } catch (error) {
      this.logger.error({ err: error }, 'cannot count the geo budget; not calling the provider');
      return null;
    }
  }

  private async safeCache<T>(work: () => Promise<T>): Promise<T | undefined> {
    try {
      return await work();
    } catch (error) {
      this.logger.warn({ err: error }, 'geo cache unavailable');
      return undefined;
    }
  }
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, CACHE_KEY_HASH_CHARS);
}

function distanceFrom(near: GeoPoint | null, at: GeoPoint): number | null {
  return near === null ? null : Math.round(distanceMeters(near, at));
}

function ownSuggestion(result: OwnGeoResult, near: GeoPoint | null): GeoSuggestion {
  return {
    label: result.label,
    labelBn: result.labelBn,
    location: result.location,
    area: result.area,
    city: result.city,
    postCode: null,
    source: 'own',
    kind: result.kind,
    refId: result.kind === 'area' ? null : result.ref,
    distanceMeters: distanceFrom(near, result.location),
  };
}

function providerSuggestion(result: Suggestion, near: GeoPoint | null): GeoSuggestion {
  return {
    label: result.label,
    labelBn: result.labelBn,
    location: result.location,
    area: result.area,
    city: result.city,
    postCode: result.postCode,
    source: 'barikoi',
    kind: 'address',
    refId: null,
    distanceMeters: distanceFrom(near, result.location),
  };
}
