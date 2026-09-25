import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import {
  GeocodingUnavailableError,
  type GeocodeResult,
  type GeocodingProvider,
  type GeoPoint,
} from './geocoding.port';

/**
 * Barikoi (barikoi.com), Bangladesh's local maps provider, behind
 * GeocodingProvider. Endpoints (docs.barikoi.com):
 *
 *   forward       POST /v2/api/search/rupantor/geocode   (form: q, thana, district, bangla)
 *   reverse       GET  /v2/api/search/reverse/geocode
 *   autocomplete  GET  /v2/api/search/autocomplete/place
 *
 * Every call has a timeout and one retry on a network error or 5xx
 * (CLAUDE.md rule 5). 401/402/429 are not retried — the key is wrong, unpaid
 * or rate-limited — and surface as GeocodingUnavailableError so the caller
 * degrades. The API key rides in the query string, so URLs are never logged
 * or put in errors.
 */

// settings-exempt: transport tuning (CLAUDE.md rule 5), not a business rule
const RETRY_DELAY_MS = 200;
// settings-exempt: one retry (CLAUDE.md rule 5)
const ATTEMPTS = 2;
const HTTP_OK_MIN = 200; // settings-exempt: HTTP status class bounds
const HTTP_OK_MAX = 299; // settings-exempt: HTTP status class bounds
const HTTP_SERVER_ERROR = 500; // settings-exempt: HTTP status code

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
const reverseResponse = z
  .object({
    place: placeSchema.nullish(),
  })
  .passthrough();
const rupantorResponse = z
  .object({
    bangla_address: looseText,
    geocoded_address: placeSchema.nullish(),
  })
  .passthrough();

function toResult(place: Place, fallbackLabelBn: string | null = null): GeocodeResult | null {
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
export class BarikoiGeocodingProvider implements GeocodingProvider {
  readonly name = 'barikoi';
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    @Inject(APP_CONFIG)
    env: Pick<Env, 'BARIKOI_API_KEY' | 'BARIKOI_BASE_URL' | 'GEOCODING_TIMEOUT_MS'>,
  ) {
    this.apiKey = env.BARIKOI_API_KEY;
    this.baseUrl = env.BARIKOI_BASE_URL.replace(/\/$/, '');
    this.timeoutMs = env.GEOCODING_TIMEOUT_MS;
  }

  async forward(query: string): Promise<GeocodeResult[]> {
    const body = new URLSearchParams({ q: query, thana: 'yes', district: 'yes', bangla: 'yes' });
    const json = await this.request('/v2/api/search/rupantor/geocode', {}, body);
    const parsed = this.parse(rupantorResponse, json);
    if (!parsed.geocoded_address) return [];
    const result = toResult(parsed.geocoded_address, parsed.bangla_address);
    return result === null ? [] : [result];
  }

  async reverse(point: GeoPoint): Promise<GeocodeResult | null> {
    const json = await this.request('/v2/api/search/reverse/geocode', {
      latitude: String(point.lat),
      longitude: String(point.lng),
      address: 'true',
      area: 'true',
      post_code: 'true',
      district: 'true',
      sub_district: 'true',
      thana: 'true',
      union: 'true',
      pauroshova: 'true',
      division: 'true',
      bangla: 'true',
    });
    const place = this.parse(reverseResponse, json).place;
    if (!place) return null;
    // The reverse answer describes the given point; it has no coordinates of its own.
    return toResult({
      ...place,
      latitude: place.latitude ?? point.lat,
      longitude: place.longitude ?? point.lng,
    });
  }

  async autocomplete(query: string): Promise<GeocodeResult[]> {
    const json = await this.request('/v2/api/search/autocomplete/place', {
      q: query,
      bangla: 'true',
    });
    return (this.parse(autocompleteResponse, json).places ?? [])
      .map((p) => toResult(p))
      .filter((r): r is GeocodeResult => r !== null);
  }

  private parse<S extends z.ZodTypeAny>(schema: S, json: unknown): z.output<S> {
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new GeocodingUnavailableError('unexpected response shape');
    return parsed.data as z.output<S>;
  }

  private async request(
    path: string,
    query: Record<string, string>,
    form?: URLSearchParams,
  ): Promise<unknown> {
    if (!this.apiKey) throw new GeocodingUnavailableError('BARIKOI_API_KEY is not set');
    const url = `${this.baseUrl}${path}?${new URLSearchParams({ api_key: this.apiKey, ...query }).toString()}`;
    let lastReason = 'unknown';
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
        lastReason =
          error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network error';
        continue;
      }
      if (response.status >= HTTP_OK_MIN && response.status <= HTTP_OK_MAX) {
        try {
          return await response.json();
        } catch {
          throw new GeocodingUnavailableError('response was not JSON');
        }
      }
      lastReason = `HTTP ${response.status}`;
      if (response.status < HTTP_SERVER_ERROR) break; // 4xx: retrying won't help
    }
    throw new GeocodingUnavailableError(lastReason);
  }
}
