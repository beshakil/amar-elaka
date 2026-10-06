import { z } from 'zod';
import { createZodDto } from '../common/pipes/zod-dto';
import { bboxParam } from '../locations/dto/locations.dto';
import { MAP_LAYERS } from '../settings/settings.registry';

export type MapLayer = (typeof MAP_LAYERS)[number];
export { MAP_LAYERS };

// settings-exempt: zoom levels map libraries use (0 = the world, 24 = deepest)
const MAX_ZOOM = 24;
// settings-exempt: latitude/longitude ranges, facts of the coordinate system.
const MAX_LAT = 90;
// settings-exempt: see above
const MAX_LNG = 180;
// settings-exempt: a point is "lat,lng"
const POINT_PARTS = 2;
// settings-exempt: generic input-length cap, not a business threshold
const SLUG_MAX_CHARS = 100;
// settings-exempt: generic input cap on a comma list, not a business threshold
const KINDS_MAX = 50;

/** `lat,lng` → a point. */
const pointParam = z.string().transform((text, ctx) => {
  const parts = text.split(',').map((p) => Number(p.trim()));
  const [lat, lng] = parts;
  if (
    parts.length !== POINT_PARTS ||
    !parts.every(Number.isFinite) ||
    Math.abs(lat!) > MAX_LAT ||
    Math.abs(lng!) > MAX_LNG
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a point is lat,lng' });
    return z.NEVER;
  }
  return { lat: lat!, lng: lng! };
});

/**
 * GET /map/features (ADR 045). `zoom` is the camera zoom (fractions
 * floored); `layers` a comma list (default: map_layers_default); `category`
 * a category slug (with its descendants); `open_now=true` keeps what is open
 * now.
 */
export const mapFeaturesQuerySchema = z.object({
  bbox: bboxParam,
  zoom: z.coerce.number().min(0).max(MAX_ZOOM).transform(Math.floor),
  layers: z
    .string()
    .optional()
    .transform((text, ctx) => {
      if (text === undefined || text.trim() === '') return undefined;
      const layers = [...new Set(text.split(',').map((k) => k.trim()))];
      if (!layers.every((k) => (MAP_LAYERS as readonly string[]).includes(k))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `layers are any of ${MAP_LAYERS.join(',')}`,
        });
        return z.NEVER;
      }
      return layers as MapLayer[];
    }),
  category: z
    .string()
    .trim()
    .min(1)
    .max(SLUG_MAX_CHARS)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .optional(),
  open_now: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  /** map_kinds codes (GET /map/config `kinds`), comma-separated: only features of these kinds. */
  kinds: z
    .string()
    .optional()
    .transform((text, ctx) => {
      if (text === undefined || text.trim() === '') return undefined;
      const kinds = [...new Set(text.split(',').map((k) => k.trim()))];
      if (kinds.length > KINDS_MAX || !kinds.every((k) => /^[a-z][a-z0-9_]*$/.test(k))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'kinds are map_kinds codes' });
        return z.NEVER;
      }
      return kinds;
    }),
});
export class MapFeaturesQueryDto extends createZodDto(mapFeaturesQuerySchema) {}
export type MapFeaturesQuery = z.infer<typeof mapFeaturesQuerySchema>;

const pointGeometry = z.object({
  type: z.literal('Point'),
  /** [lng, lat] */
  // settings-exempt: a GeoJSON position is a [lng, lat] pair
  coordinates: z.array(z.number()).length(2),
});

/**
 * Feature properties are snake_case, like the base map tiles' own (`name`,
 * `kind`), so a map style reads them the same way.
 */
const clusterFeature = z.object({
  type: z.literal('Feature'),
  geometry: pointGeometry,
  properties: z.object({
    cluster: z.literal(true),
    layer: z.enum(MAP_LAYERS),
    /** map_kinds code of the cluster's features (clusters group per layer and kind); null = none. */
    kind: z.string().nullable(),
    count: z.number(),
    /** Zoom to go to on a tap: the cluster splits there (or every point shows). */
    expansion_zoom: z.number(),
  }),
});

const pointFeature = z.object({
  type: z.literal('Feature'),
  id: z.string(),
  geometry: pointGeometry,
  properties: z.object({
    cluster: z.literal(false),
    layer: z.enum(MAP_LAYERS),
    /** map_kinds code (the pin's icon); null when the feature matches no kind. */
    kind: z.string().nullable(),
    id: z.string(),
    tenant_id: z.string(),
    /** Both always present (null when unknown), so a client can show Bengali in its own UI whatever the map label language. */
    name_bn: z.string().nullable(),
    name_en: z.string().nullable(),
    category_slug: z.string().nullable(),
    /** Posts: money string with two decimals. */
    price: z.string().nullable(),
    /** Stores, places, landmarks: URL slug. */
    slug: z.string().nullable(),
    /** info: the emergency service type (hospital, pharmacy_24h, police…), bus_stop, or the place category slug of a map_info_place_categories place (bank-atm). */
    info_kind: z.string().nullable(),
    /** Places/landmarks by their hours, 24h info as true; null when unknown. */
    open_now: z.boolean().nullable(),
  }),
});

export const mapFeaturesResponseSchema = z.object({
  type: z.literal('FeatureCollection'),
  zoom: z.number(),
  layers: z.array(z.enum(MAP_LAYERS)),
  /** False from map_cluster_until_zoom on: every feature is a point. */
  clustered: z.boolean(),
  /** The viewport reaches past map_viewport_max_radius_km from its centre: only features within it. */
  clipped: z.boolean(),
  /** map_features_max was reached: the biggest clusters, then the nearest points, were kept. */
  truncated: z.boolean(),
  /** With open_now: layers that have no opening hours, so they were left out. */
  open_now_skipped: z.array(z.enum(MAP_LAYERS)),
  features: z.array(z.union([clusterFeature, pointFeature])),
});
export type MapFeaturesResponse = z.infer<typeof mapFeaturesResponseSchema>;
export type MapFeature = MapFeaturesResponse['features'][number];
export class MapFeaturesResponseDto extends createZodDto(mapFeaturesResponseSchema) {}

/** GET /map/distance?from=lat,lng&to=lat,lng */
export const mapDistanceQuerySchema = z.object({ from: pointParam, to: pointParam });
export class MapDistanceQueryDto extends createZodDto(mapDistanceQuerySchema) {}
export type MapDistanceQuery = z.infer<typeof mapDistanceQuerySchema>;

export const mapDistanceResponseSchema = z.object({
  from: z.object({ lat: z.number(), lng: z.number() }),
  to: z.object({ lat: z.number(), lng: z.number() }),
  /** On the WGS84 spheroid (PostGIS), instantly, never a provider call. */
  straight_line_meters: z.number(),
  /** Road distance and ETA: POST this endpoint, only on an explicit tap (a paid call). */
  route: z.object({ method: z.literal('POST'), path: z.literal('/api/v1/geo/route') }),
});
export type MapDistanceResponse = z.infer<typeof mapDistanceResponseSchema>;
export class MapDistanceResponseDto extends createZodDto(mapDistanceResponseSchema) {}
