import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';

// settings-exempt: latitude/longitude ranges, facts of the coordinate system.
const MAX_LAT = 90;
// settings-exempt: see above
const MAX_LNG = 180;
// settings-exempt: generic input-length cap, not a business threshold.
const QUERY_MAX_CHARS = 200;
// settings-exempt: a bbox has four numbers (minLng,minLat,maxLng,maxLat)
const BBOX_PARTS = 4;

const lat = z.coerce.number().min(-MAX_LAT).max(MAX_LAT);
const lng = z.coerce.number().min(-MAX_LNG).max(MAX_LNG);

/** Levels a viewport can draw (ADM4 has no polygons). */
export const VIEWPORT_LEVELS = [
  'country',
  'division',
  'district',
  'upazila',
  'city_corporation',
] as const;

export const childrenQuerySchema = z.object({ parentId: z.string().uuid().optional() });
export class ChildrenQueryDto extends createZodDto(childrenQuerySchema) {}

export const locationIdParamSchema = z.object({ id: z.string().uuid() });
export class LocationIdParamDto extends createZodDto(locationIdParamSchema) {}

export const pointQuerySchema = z.object({ lat, lng });
export class PointQueryDto extends createZodDto(pointQuerySchema) {}

/** `bbox=minLng,minLat,maxLng,maxLat` — the order map libraries use. */
export const viewportQuerySchema = z.object({
  bbox: z.string().transform((text, ctx) => {
    const parts = text.split(',').map((p) => Number(p.trim()));
    const [minLng, minLat, maxLng, maxLat] = parts;
    const valid =
      parts.length === BBOX_PARTS &&
      parts.every(Number.isFinite) &&
      Math.abs(minLat!) <= MAX_LAT &&
      Math.abs(maxLat!) <= MAX_LAT &&
      Math.abs(minLng!) <= MAX_LNG &&
      Math.abs(maxLng!) <= MAX_LNG &&
      minLng! < maxLng! &&
      minLat! < maxLat!;
    if (!valid) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bbox is minLng,minLat,maxLng,maxLat' });
      return z.NEVER;
    }
    return { minLng: minLng!, minLat: minLat!, maxLng: maxLng!, maxLat: maxLat! };
  }),
  level: z.enum(VIEWPORT_LEVELS).default('upazila'),
});
export class ViewportQueryDto extends createZodDto(viewportQuerySchema) {}

const geocodeQuery = {
  q: z.string().trim().min(1).max(QUERY_MAX_CHARS),
  /** Optional: the caller's position, to report each result's distance. */
  lat: lat.optional(),
  lng: lng.optional(),
};
const bothOrNeither = (v: { lat?: number | undefined; lng?: number | undefined }) =>
  (v.lat === undefined) === (v.lng === undefined);

export const geocodeQuerySchema = z
  .object(geocodeQuery)
  .refine(bothOrNeither, { message: 'lat and lng go together', path: ['lat'] });
export class GeocodeQueryDto extends createZodDto(geocodeQuerySchema) {}
export type GeocodeQuery = z.infer<typeof geocodeQuerySchema>;

export const tenantIdParamSchema = z.object({ tenantId: z.string().uuid() });
export class TenantIdParamDto extends createZodDto(tenantIdParamSchema) {}

/**
 * `{"mode":"polygon"}` — the tenant's area boundary; or
 * `{"mode":"radius","center":{"lat":…,"lng":…},"radiusKm":…}`.
 */
export const tenantBoundarySchema = z
  .object({
    mode: z.enum(['polygon', 'radius']),
    center: z.object({ lat, lng }).optional(),
    radiusKm: z.number().positive().optional(),
  })
  .refine(
    (v) =>
      v.mode === 'polygon'
        ? v.center === undefined && v.radiusKm === undefined
        : v.center !== undefined && v.radiusKm !== undefined,
    {
      message: 'radius mode needs center and radiusKm; polygon mode takes neither',
      path: ['mode'],
    },
  );
export class TenantBoundaryDto extends createZodDto(tenantBoundarySchema) {}
export type TenantBoundaryInput =
  { mode: 'polygon' } | { mode: 'radius'; center: { lat: number; lng: number }; radiusKm: number };

/** The validated body, as the union the service works with. */
export function toBoundaryInput(body: z.infer<typeof tenantBoundarySchema>): TenantBoundaryInput {
  return body.mode === 'radius' && body.center && body.radiusKm !== undefined
    ? { mode: 'radius', center: body.center, radiusKm: body.radiusKm }
    : { mode: 'polygon' };
}

// ---- responses ----------------------------------------------------------

const point = z.object({ lat: z.number(), lng: z.number() });

export const locationAreaSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  /** country / division / district / upazila / city_corporation / union / pourashava / … */
  level: z.string(),
  /** HDX COD-AB pcode, e.g. BD30260014 (null for hand-made areas). */
  pcode: z.string().nullable(),
  name: z.object({ bn: z.string().nullable(), en: z.string() }),
  center: point.nullable(),
  hasChildren: z.boolean(),
});
export type LocationArea = z.infer<typeof locationAreaSchema>;
export class LocationAreaDto extends createZodDto(locationAreaSchema) {}

export const locationDetailSchema = z.object({
  area: locationAreaSchema,
  /** Ancestors, country first — prefills a cascading picker. */
  path: z.array(locationAreaSchema),
});
export type LocationDetail = z.infer<typeof locationDetailSchema>;
export class LocationDetailDto extends createZodDto(locationDetailSchema) {}

export const viewportResponseSchema = z.object({
  level: z.string(),
  areas: z.array(
    locationAreaSchema.omit({ hasChildren: true }).extend({
      /** GeoJSON (Multi)Polygon, simplified for display — never for ownership. */
      boundary: z.record(z.unknown()).nullable(),
    }),
  ),
  /** More areas intersect the viewport than map_viewport_max_areas: zoom in. */
  truncated: z.boolean(),
  /** Required wherever boundaries are shown (CC BY-IGO, ADR 003). */
  attribution: z.string(),
});
export type ViewportResponse = z.infer<typeof viewportResponseSchema>;
export class ViewportResponseDto extends createZodDto(viewportResponseSchema) {}

export const pointLookupSchema = z.object({
  location: point,
  /** Administrative areas at the point, country first (ADM4 is the nearest union centre). */
  areas: z.array(locationAreaSchema),
  /** Relation to the request's tenant, when there is one. */
  tenant: z.object({ inside: z.boolean(), distanceMeters: z.number() }).nullable(),
});
export type PointLookup = z.infer<typeof pointLookupSchema>;
export class PointLookupDto extends createZodDto(pointLookupSchema) {}

export const geocodeResultSchema = z.object({
  label: z.string(),
  labelBn: z.string().nullable(),
  location: point,
  area: z.string().nullable(),
  city: z.string().nullable(),
  postCode: z.string().nullable(),
  /** `provider` (e.g. Barikoi) or `local` (our own area data, when the provider is unavailable). */
  source: z.enum(['provider', 'local']),
  /** From the request's lat/lng, when given. */
  distanceMeters: z.number().nullable(),
});
export type GeocodeResultDto = z.infer<typeof geocodeResultSchema>;

export const geocodeResponseSchema = z.object({
  query: z.string(),
  results: z.array(geocodeResultSchema),
  /** The provider was unavailable; results (if any) come from our own area data. */
  degraded: z.boolean(),
});
export type GeocodeResponse = z.infer<typeof geocodeResponseSchema>;
export class GeocodeResponseDto extends createZodDto(geocodeResponseSchema) {}

export const reverseGeocodeResponseSchema = z.object({
  /** Always present: the coordinates asked about. */
  location: point,
  /** The provider's address, or null (degraded, or nothing known there). */
  address: geocodeResultSchema.nullable(),
  /** Our own administrative areas at the point, independent of the provider. */
  areas: z.array(locationAreaSchema),
  degraded: z.boolean(),
});
export type ReverseGeocodeResponse = z.infer<typeof reverseGeocodeResponseSchema>;
export class ReverseGeocodeResponseDto extends createZodDto(reverseGeocodeResponseSchema) {}

export const tenantBoundaryResponseSchema = z.object({
  tenantId: z.string(),
  mode: z.enum(['polygon', 'radius']),
  center: point,
  radiusKm: z.number().nullable(),
});
export type TenantBoundaryResponse = z.infer<typeof tenantBoundaryResponseSchema>;
export class TenantBoundaryResponseDto extends createZodDto(tenantBoundaryResponseSchema) {}
