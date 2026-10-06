import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env.schema';
import {
  GeoProviderError,
  type Address,
  type AutocompleteOptions,
  type Candidate,
  type GeoPoint,
  type GeoProvider,
  type ReverseField,
  type RouteMode,
  type RouteResult,
  type Suggestion,
} from '../geo-provider.port';

/**
 * Barikoi (barikoi.com), Bangladesh's local maps provider, behind
 * GeoProvider (ADR 044). Endpoints (docs.barikoi.com):
 *
 *   autocomplete     GET  /v2/api/search/autocomplete/place   q [, bangla]
 *   geocodeAddress   POST /v2/api/search/rupantor/geocode     q, bangla (form)
 *   reverseGeocode   GET  /v2/api/search/reverse/geocode      latitude, longitude [, fields…]
 *   route            GET  /v2/api/route/{lng,lat};{lng,lat}   profile, geometries
 *
 * It sends exactly what it is asked for and nothing more: every optional
 * reverse-geocode field is an extra billed call. The base reverse answer
 * already has the English address, area and city; `bangla` adds the Bengali
 * ones. What a call costs is GeoService's business (settings barikoi_cost_*).
 * Autocomplete takes no position: Barikoi's location bias is another
 * parameter, and our own data already answers near the user first.
 * Barikoi map tiles are never used (ADR 043).
 *
 * Every call has a timeout and one retry on a network error or 5xx
 * (CLAUDE.md rule 5). 401/402/403/429 are not retried. The API key rides in
 * the query string, so URLs are never logged or put in errors.
 */

// settings-exempt: transport tuning (CLAUDE.md rule 5), not a business rule
const RETRY_DELAY_MS = 200;
// settings-exempt: one retry (CLAUDE.md rule 5)
const ATTEMPTS = 2;
const HTTP_OK_MIN = 200; // settings-exempt: HTTP status class bounds
const HTTP_OK_MAX = 299; // settings-exempt: HTTP status class bounds
const HTTP_SERVER_ERROR = 500; // settings-exempt: HTTP status code
const HTTP_TOO_MANY_REQUESTS = 429; // settings-exempt: HTTP status code
const HTTP_UNAUTHORIZED = new Set([401, 402, 403]); // settings-exempt: HTTP status codes

// Barikoi mixes numbers and strings for the same fields across endpoints.
const looseNumber = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]).transform(Number);
const looseText = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v === null || v === undefined || v === '' ? null : String(v)));

const placeSchema = z
  .object({
    id: looseText,
    uCode: looseText,
    address: z.string().nullish(),
    Address: z.string().nullish(),
    address_bn: looseText,
    area: looseText,
    city: looseText,
    postCode: looseText,
    // Optional: one place without coordinates is dropped, not the whole answer.
    latitude: looseNumber.optional(),
    longitude: looseNumber.optional(),
  })
  .passthrough();
type Place = z.infer<typeof placeSchema>;

const autocompleteResponse = z.object({ places: z.array(placeSchema).nullish() }).passthrough();
const reverseResponse = z.object({ place: placeSchema.nullish() }).passthrough();
const rupantorResponse = z
  .object({
    bangla_address: looseText,
    geocoded_address: placeSchema.nullish(),
  })
  .passthrough();
const lngLat = z.tuple([z.number(), z.number()]);
const routeResponse = z
  .object({
    code: z.string(),
    routes: z
      .array(
        z
          .object({
            distance: z.number().nonnegative(),
            duration: z.number().nonnegative(),
            geometry: z.object({ type: z.literal('LineString'), coordinates: z.array(lngLat) }),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

function toSuggestion(place: Place, fallbackLabelBn: string | null = null): Suggestion | null {
  const label = place.address ?? place.Address ?? null;
  const { latitude: lat, longitude: lng } = place;
  if (
    label === null ||
    lat === undefined ||
    lng === undefined ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    return null;
  }
  return {
    label,
    labelBn: place.address_bn ?? fallbackLabelBn,
    location: { lat, lng },
    area: place.area,
    city: place.city,
    postCode: place.postCode,
    providerRef: place.uCode ?? place.id,
  };
}

@Injectable()
export class BarikoiProvider implements GeoProvider {
  readonly name = 'barikoi';
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    @Inject(APP_CONFIG)
    env: Pick<Env, 'BARIKOI_API_KEY' | 'BARIKOI_BASE_URL' | 'GEOCODING_TIMEOUT_MS'>,
  ) {
    this.apiKey = env.BARIKOI_API_KEY;
    // Paths below carry /v2/api themselves; accept a base written either way
    // (https://barikoi.xyz or https://barikoi.xyz/v2/api) instead of 404ing.
    this.baseUrl = env.BARIKOI_BASE_URL.replace(/\/+$/, '').replace(/\/v2\/api$/, '');
    this.timeoutMs = env.GEOCODING_TIMEOUT_MS;
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  async autocomplete(
    q: string,
    _near: GeoPoint | undefined,
    opts: AutocompleteOptions,
  ): Promise<Suggestion[]> {
    const json = await this.request('/v2/api/search/autocomplete/place', {
      q,
      ...(opts.bangla ? { bangla: 'true' } : {}),
    });
    return (this.parse(autocompleteResponse, json).places ?? [])
      .map((p) => toSuggestion(p))
      .filter((r): r is Suggestion => r !== null);
  }

  async reverseGeocode(
    lat: number,
    lng: number,
    fields: readonly ReverseField[],
  ): Promise<Address | null> {
    const json = await this.request('/v2/api/search/reverse/geocode', {
      latitude: String(lat),
      longitude: String(lng),
      ...Object.fromEntries([...new Set(fields)].map((field) => [field, 'true'])),
    });
    const place = this.parse(reverseResponse, json).place;
    const label = place?.address ?? place?.Address ?? null;
    if (!place || label === null) return null;
    return {
      label,
      labelBn: place.address_bn,
      area: place.area,
      city: place.city,
      postCode: place.postCode,
      providerRef: place.uCode ?? place.id,
    };
  }

  async geocodeAddress(text: string): Promise<Candidate[]> {
    const body = new URLSearchParams({ q: text, bangla: 'yes' });
    const json = await this.request('/v2/api/search/rupantor/geocode', {}, body);
    const parsed = this.parse(rupantorResponse, json);
    if (!parsed.geocoded_address) return [];
    const result = toSuggestion(parsed.geocoded_address, parsed.bangla_address);
    return result === null ? [] : [result];
  }

  async route(from: GeoPoint, to: GeoPoint, mode: RouteMode): Promise<RouteResult | null> {
    const json = await this.request(`/v2/api/route/${from.lng},${from.lat};${to.lng},${to.lat}`, {
      profile: mode,
      geometries: 'geojson',
      overview: 'full',
    });
    const parsed = this.parse(routeResponse, json);
    const route = parsed.code === 'Ok' ? parsed.routes?.[0] : undefined;
    if (!route) return null;
    return {
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      polyline: route.geometry.coordinates,
    };
  }

  private parse<S extends z.ZodTypeAny>(schema: S, json: unknown): z.output<S> {
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new GeoProviderError('bad_response', HTTP_OK_MIN);
    return parsed.data as z.output<S>;
  }

  private async request(
    path: string,
    query: Record<string, string>,
    form?: URLSearchParams,
  ): Promise<unknown> {
    if (!this.apiKey) throw new GeoProviderError('not_configured');
    const url = `${this.baseUrl}${path}?${new URLSearchParams({ api_key: this.apiKey, ...query }).toString()}`;
    let failure = new GeoProviderError('network');
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      let response: Response;
      try {
        response = await fetch(url, {
          method: form ? 'POST' : 'GET',
          headers: { accept: 'application/json' },
          ...(form ? { body: form } : {}),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        failure = new GeoProviderError(
          error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network',
        );
        continue;
      }
      if (response.status >= HTTP_OK_MIN && response.status <= HTTP_OK_MAX) {
        try {
          return await response.json();
        } catch {
          throw new GeoProviderError('bad_response', response.status);
        }
      }
      if (response.status === HTTP_TOO_MANY_REQUESTS) {
        throw new GeoProviderError('rate_limited', response.status);
      }
      if (HTTP_UNAUTHORIZED.has(response.status)) {
        throw new GeoProviderError('unauthorized', response.status);
      }
      failure = new GeoProviderError('server_error', response.status);
      if (response.status < HTTP_SERVER_ERROR) break; // other 4xx: retrying won't help
    }
    throw failure;
  }
}
