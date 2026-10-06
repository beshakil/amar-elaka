import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';
import { locationAreaSchema } from '../dto/locations.dto';

// settings-exempt: latitude/longitude ranges, facts of the coordinate system.
const MAX_LAT = 90;
// settings-exempt: see above
const MAX_LNG = 180;
// settings-exempt: generic input-length cap, not a business threshold.
const QUERY_MAX_CHARS = 200;

const lat = z.coerce.number().min(-MAX_LAT).max(MAX_LAT);
const lng = z.coerce.number().min(-MAX_LNG).max(MAX_LNG);
const point = z.object({
  lat: z.number().min(-MAX_LAT).max(MAX_LAT),
  lng: z.number().min(-MAX_LNG).max(MAX_LNG),
});

// ---- GET /geo/autocomplete -----------------------------------------------

export const geoAutocompleteQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(QUERY_MAX_CHARS),
    /** The user's position: our own data near them first, and each result's distance. */
    lat: lat.optional(),
    lng: lng.optional(),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), {
    message: 'lat and lng go together',
    path: ['lat'],
  });
export class GeoAutocompleteQueryDto extends createZodDto(geoAutocompleteQuerySchema) {}
export type GeoAutocompleteQuery = z.infer<typeof geoAutocompleteQuerySchema>;

export const geoSuggestionSchema = z.object({
  label: z.string(),
  labelBn: z.string().nullable(),
  location: z.object({ lat: z.number(), lng: z.number() }),
  area: z.string().nullable(),
  city: z.string().nullable(),
  postCode: z.string().nullable(),
  /** own: our places, landmarks, stores and areas; barikoi: the provider (show its credit). */
  source: z.enum(['own', 'barikoi']),
  kind: z.enum(['landmark', 'place', 'store', 'area', 'address']),
  /** Our place's or store's id; null for an area or a provider address. */
  refId: z.string().nullable(),
  /** From the request's lat/lng, when given. */
  distanceMeters: z.number().nullable(),
});
export type GeoSuggestion = z.infer<typeof geoSuggestionSchema>;

export const geoAutocompleteResponseSchema = z.object({
  query: z.string(),
  /** Own results first. */
  results: z.array(geoSuggestionSchema),
  /** The provider was needed but not used (budget, breaker, disabled): own results only. */
  degraded: z.boolean(),
});
export type GeoAutocompleteResponse = z.infer<typeof geoAutocompleteResponseSchema>;
export class GeoAutocompleteResponseDto extends createZodDto(geoAutocompleteResponseSchema) {}

// ---- GET /geo/reverse ----------------------------------------------------

/**
 * Why the point is being looked up. Areas always come from our geo_areas;
 * the street address is asked of the provider only for the purposes that
 * show one, with only the fields settings map to that purpose
 * (`geo_reverse_fields_<purpose>`): every field is an extra billed call.
 */
export const GEO_PURPOSES = ['area', 'post_location', 'store_setup', 'place_marking'] as const;
export type GeoPurpose = (typeof GEO_PURPOSES)[number];

export const geoReverseQuerySchema = z.object({
  lat,
  lng,
  purpose: z.enum(GEO_PURPOSES).default('area'),
});
export class GeoReverseQueryDto extends createZodDto(geoReverseQuerySchema) {}
export type GeoReverseQuery = z.infer<typeof geoReverseQuerySchema>;

export const geoReverseResponseSchema = z.object({
  location: z.object({ lat: z.number(), lng: z.number() }),
  purpose: z.enum(GEO_PURPOSES),
  /** The provider's street address (show its credit), or null: not needed, unknown there, or degraded. */
  address: z
    .object({
      label: z.string(),
      labelBn: z.string().nullable(),
      area: z.string().nullable(),
      city: z.string().nullable(),
      postCode: z.string().nullable(),
      source: z.literal('barikoi'),
    })
    .nullable(),
  /** Our own administrative areas at the point, country first. Always present, always free. */
  areas: z.array(locationAreaSchema),
  /** An address was needed but the provider wasn't used (budget, breaker, disabled). */
  degraded: z.boolean(),
});
export type GeoReverseResponse = z.infer<typeof geoReverseResponseSchema>;
export class GeoReverseResponseDto extends createZodDto(geoReverseResponseSchema) {}

// ---- POST /geo/route -----------------------------------------------------

export const ROUTE_MODES = ['car', 'foot'] as const;
export const geoRouteBodySchema = z.object({
  from: point,
  to: point,
  mode: z.enum(ROUTE_MODES).default('car'),
});
export class GeoRouteBodyDto extends createZodDto(geoRouteBodySchema) {}
export type GeoRouteBody = z.infer<typeof geoRouteBodySchema>;

export const geoRouteResponseSchema = z.object({
  mode: z.enum(ROUTE_MODES),
  /** Along the road (provider), else the straight line (PostGIS). */
  distanceMeters: z.number(),
  /** Null when degraded: no made-up travel time. */
  durationSeconds: z.number().nullable(),
  /** The road as GeoJSON LineString coordinates ([lng, lat] pairs); null when degraded. */
  // settings-exempt: a GeoJSON position is a [lng, lat] pair
  polyline: z.array(z.array(z.number()).length(2)).nullable(),
  /** barikoi: a real route (show its credit); straight_line: PostGIS distance only. */
  source: z.enum(['barikoi', 'straight_line']),
  degraded: z.boolean(),
});
export type GeoRouteResponse = z.infer<typeof geoRouteResponseSchema>;
export class GeoRouteResponseDto extends createZodDto(geoRouteResponseSchema) {}

// ---- GET /analytics/geo-usage --------------------------------------------

export const geoUsageQuerySchema = z.object({
  /** Days back, today included (capped by geo_usage_report_days_max). */
  days: z.coerce.number().int().min(1).optional(),
});
export class GeoUsageQueryDto extends createZodDto(geoUsageQuerySchema) {}
export type GeoUsageQuery = z.infer<typeof geoUsageQuerySchema>;

const usageCounts = {
  /** Requests that reached the provider layer (calls, cache hits, refusals). */
  requests: z.number(),
  /** Barikoi calls as billed. */
  calls: z.number(),
  cacheHits: z.number(),
  /** Percent of the requests needing a provider answer that the cache gave; null with none. */
  cacheHitRate: z.number().nullable(),
};

export const geoUsageResponseSchema = z.object({
  provider: z.string(),
  days: z.array(z.object({ day: z.string(), ...usageCounts })),
  topEndpoints: z.array(z.object({ endpoint: z.string(), ...usageCounts })),
  today: z.object({
    calls: z.number(),
    budget: z.number(),
    /** Share of today's budget used, in percent. */
    usedPct: z.number().nullable(),
  }),
  month: z.object({
    callsSoFar: z.number(),
    /** Calls so far ÷ days elapsed × days in the month. */
    projectedCalls: z.number(),
  }),
});
export type GeoUsageResponse = z.infer<typeof geoUsageResponseSchema>;
export class GeoUsageResponseDto extends createZodDto(geoUsageResponseSchema) {}
