/**
 * Geocoding behind a port, so the provider (Barikoi today) can be swapped or
 * faked without touching callers. Providers return plain results or throw one
 * of the typed errors below; caching, fallback and limits live in
 * GeocodingService.
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface GeocodeResult {
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

export interface GeocodingProvider {
  /** Stable name, part of every cache key. */
  readonly name: string;
  /** Address text → best-matching places. */
  forward(query: string): Promise<GeocodeResult[]>;
  /** Point → the address there, or null when the provider knows none. */
  reverse(point: GeoPoint): Promise<GeocodeResult | null>;
  /** As-you-type suggestions. */
  autocomplete(query: string): Promise<GeocodeResult[]>;
}

export const GEOCODING_PROVIDER = Symbol('GEOCODING_PROVIDER');

/** Timeout, network failure, 5xx, rate limit, unpaid or missing key: fall back, don't fail. */
export class GeocodingUnavailableError extends Error {
  constructor(
    readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`geocoding provider unavailable: ${reason}`, options);
    this.name = 'GeocodingUnavailableError';
  }
}
