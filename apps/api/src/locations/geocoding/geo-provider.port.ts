import type { REVERSE_FIELDS } from '../../settings/settings.registry';

/**
 * The geo provider layer (ADR 026, ADR 044): one implementation per provider
 * behind this port, chosen by the `geo_provider` setting —
 *
 *   BarikoiProvider  the real one (providers/barikoi.provider.ts)
 *   NullProvider     answers nothing; used when disabled, with no key, over
 *                    the daily budget, or while the circuit breaker is open
 *   FakeProvider     tests only, no network (providers/fake.provider.ts)
 *
 * Providers return plain results or throw GeoProviderError. Own data first,
 * caching, the budget, the call log and the fallback live in GeoService.
 * Only apps/api ever talks to a provider: its key never reaches a client.
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** An optional reverse-geocode field; each is an extra billed call. */
export type ReverseField = (typeof REVERSE_FIELDS)[number];

/** An autocomplete suggestion or an address-geocoding candidate. */
export interface Suggestion {
  /** Full address as the provider writes it (English). */
  label: string;
  labelBn: string | null;
  location: GeoPoint;
  area: string | null;
  city: string | null;
  postCode: string | null;
  /** The provider's id for the place, when it has one. */
  providerRef: string | null;
}
export type Candidate = Suggestion;

/** The street-level address at a point. Admin areas come from our geo_areas, never from here. */
export interface Address {
  label: string;
  labelBn: string | null;
  area: string | null;
  city: string | null;
  postCode: string | null;
  providerRef: string | null;
}

export interface AutocompleteOptions {
  /** The query is in Bengali: ask for the provider's Bengali variant. */
  bangla: boolean;
}

export type RouteMode = 'car' | 'foot';

export interface RouteResult {
  distanceMeters: number;
  durationSeconds: number;
  /** The road, as GeoJSON LineString coordinates ([lng, lat] pairs). */
  polyline?: [number, number][];
}

export type GeoEndpoint = 'autocomplete' | 'reverse' | 'geocode_address' | 'route';

export interface GeoProvider {
  /** Stable name: part of every cache key and of the call log. */
  readonly name: string;
  /** False when it can't be called (no key, or the null provider). */
  readonly configured: boolean;
  autocomplete(
    q: string,
    near: GeoPoint | undefined,
    opts: AutocompleteOptions,
  ): Promise<Suggestion[]>;
  /** Asks only for `fields` beyond the base answer. Null when nothing is known there. */
  reverseGeocode(
    lat: number,
    lng: number,
    fields: readonly ReverseField[],
  ): Promise<Address | null>;
  /** Free-text address → candidates (Barikoi Rupantor). Bulk/agent use only, never a client endpoint. */
  geocodeAddress(text: string): Promise<Candidate[]>;
  /** The road route, or null when there is none. */
  route(from: GeoPoint, to: GeoPoint, mode: RouteMode): Promise<RouteResult | null>;
}

/** Every provider implementation the module knows, by name. */
export const GEO_PROVIDERS = Symbol('GEO_PROVIDERS');

/**
 * Why a provider call failed. All of them fall back, none fail the request.
 *   not_configured  no key                     (never reached the provider)
 *   timeout         no answer in time          (never reached / unknown)
 *   network         connection failed          (never reached)
 *   rate_limited    HTTP 429
 *   unauthorized    HTTP 401/402/403: wrong, unpaid or blocked key
 *   server_error    HTTP 5xx after the retry
 *   bad_response    an answer we can't read
 */
export type GeoProviderFailure =
  | 'not_configured'
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'unauthorized'
  | 'server_error'
  | 'bad_response';

export class GeoProviderError extends Error {
  constructor(
    readonly reason: GeoProviderFailure,
    readonly httpStatus: number | null = null,
    options?: { cause?: unknown },
  ) {
    super(`geo provider unavailable: ${reason}`, options);
    this.name = 'GeoProviderError';
  }

  /** Whether the provider received the call (and so may bill it). */
  get reachedProvider(): boolean {
    return this.httpStatus !== null;
  }
}
