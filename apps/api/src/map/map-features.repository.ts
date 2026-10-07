import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import type { BoundingBox } from '../locations/geo/geodesic';
import type { MapLayer } from './map-features.dto';

const featureRow = z.object({
  layer: z.enum(['posts', 'stores', 'places', 'landmarks', 'info']),
  point_count: z.coerce.number(),
  lng: z.coerce.number(),
  lat: z.coerce.number(),
  id: z.string().nullable(),
  tenant_id: z.string().nullable(),
  name_bn: z.string().nullable(),
  name_en: z.string().nullable(),
  category_slug: z.string().nullable(),
  price: z.string().nullable(),
  slug: z.string().nullable(),
  info_kind: z.string().nullable(),
  open_now: z.boolean().nullable(),
  kind: z.string().nullable(),
  open_state: z.string().nullable(),
  open_changes_at: z.coerce.date().nullable(),
});
export type FeatureRow = z.infer<typeof featureRow>;

export interface FeaturesRequest {
  box: BoundingBox;
  zoom: number;
  layers: readonly MapLayer[];
  category: string | null;
  openNow: boolean;
  /** Required when the box is wider than map_viewport_max_radius_km around its own centre. */
  center: { lat: number; lng: number } | null;
  limit: number;
  /** map_kinds codes to keep; null = every feature, whatever its kind. */
  kinds: readonly string[] | null;
}

/**
 * The geo query layer's map read (ADR 045, 046): map_features (0044) — one
 * query, our own tables only, radius-bounded and grid-clustered in PostGIS.
 */
@Injectable()
export class MapFeaturesRepository {
  async features(tx: DatabaseTransaction, request: FeaturesRequest): Promise<FeatureRow[]> {
    const { box, center } = request;
    const rows = await tx.execute(sql`
      select layer, point_count, lng, lat, id, tenant_id, name_bn, name_en,
             category_slug, price, slug, info_kind, open_now, kind, open_state, open_changes_at
      from public.map_features(
        ${box.minLng}, ${box.minLat}, ${box.maxLng}, ${box.maxLat}, ${request.zoom},
        ${textArray(request.layers)}, ${request.category}, ${request.openNow},
        ${center?.lat ?? null}, ${center?.lng ?? null}, ${request.limit},
        ${request.kinds ? textArray(request.kinds) : sql`null::text[]`})`);
    return z.array(featureRow).parse([...rows]);
  }
}

/** A bound-parameter array literal: `array[$1, $2]::text[]` (never interpolated text). */
function textArray(values: readonly string[]): SQL {
  return sql`array[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}
