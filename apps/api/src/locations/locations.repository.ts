import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import type { BoundingBox } from './geo/geodesic';

/**
 * Reads of the location hierarchy (geo_areas, global reference data readable
 * by everyone) and the tenant-boundary write. SQL helpers from 0021 do the
 * spatial work; this file never computes a distance itself.
 */

const nullableText = z.string().nullable();

const areaRow = z.object({
  id: z.string(),
  parent_id: nullableText,
  adm_level: z.coerce.number().int(),
  level_code: z.string(),
  cod_pcode: nullableText,
  name_en: z.string(),
  name_bn: nullableText,
  lat: z.coerce.number().nullable(),
  lng: z.coerce.number().nullable(),
  has_children: z.boolean(),
});
export type AreaRow = z.infer<typeof areaRow>;

const viewportRow = areaRow.omit({ has_children: true, adm_level: true }).extend({
  boundary: z.unknown().nullable(),
});
export type ViewportRow = z.infer<typeof viewportRow>;

const searchRow = areaRow.extend({ parent_name_en: nullableText, parent_name_bn: nullableText });
export type AreaSearchRow = z.infer<typeof searchRow>;

const AREA_COLUMNS = sql.raw(`
  g.id, g.parent_id, g.adm_level, g.level_code, g.cod_pcode, g.name_en, g.name_bn,
  st_y(g.centroid::geometry) as lat, st_x(g.centroid::geometry) as lng,
  exists (select 1 from public.geo_areas c where c.parent_id = g.id and c.is_active) as has_children`);

/** ILIKE pattern, LIKE wildcards in the input escaped. */
export function prefixPattern(text: string): string {
  return `${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

@Injectable()
export class LocationsRepository {
  /** Active children of an area, or the divisions (children of the country) when parentId is null. */
  async children(tx: DatabaseTransaction, parentId: string | null): Promise<AreaRow[]> {
    const parent =
      parentId === null
        ? sql`(select id from public.geo_areas where adm_level = 0 and is_active order by cod_pcode nulls last limit 1)`
        : sql`${parentId}::uuid`;
    const rows = await tx.execute(sql`
      select ${AREA_COLUMNS}
      from public.geo_areas g
      where g.parent_id = ${parent} and g.is_active
      order by g.name_en, g.id`);
    return z.array(areaRow).parse([...rows]);
  }

  /** The area and its ancestors, root first. */
  async withAncestors(tx: DatabaseTransaction, id: string): Promise<AreaRow[]> {
    const rows = await tx.execute(sql`
      select ${AREA_COLUMNS}
      from public.geo_areas g
      where g.id = ${id}::uuid
         or g.id in (select unnest(ancestor_ids) from public.geo_areas where id = ${id}::uuid)
      order by g.adm_level`);
    return z.array(areaRow).parse([...rows]);
  }

  async exists(tx: DatabaseTransaction, id: string): Promise<boolean> {
    const rows = await tx.execute(
      sql`select 1 from public.geo_areas where id = ${id}::uuid and is_active`,
    );
    return [...rows].length > 0;
  }

  /** Areas of one level in a map viewport, with the SIMPLIFIED boundary as GeoJSON (ADR 003). */
  async inViewport(
    tx: DatabaseTransaction,
    box: BoundingBox,
    levelCode: string,
    limit: number,
  ): Promise<ViewportRow[]> {
    const rows = await tx.execute(sql`
      select v.id, v.parent_id, v.level_code, v.cod_pcode, v.name_en, v.name_bn,
             st_y(v.centroid::geometry) as lat, st_x(v.centroid::geometry) as lng,
             st_asgeojson(v.boundary_simplified::geometry, 6)::json as boundary
      from public.geo_areas_in_bbox(${box.minLng}, ${box.minLat}, ${box.maxLng}, ${box.maxLat}, ${levelCode}, ${limit}) v`);
    return z.array(viewportRow).parse([...rows]);
  }

  /**
   * The administrative areas at a point, root first: the ADM3 area whose
   * full-precision boundary covers it (upazila or city corporation), its
   * ancestors, and — ADM4 being points only — the nearest union/pourashava
   * centre inside that ADM3 area. Empty outside Bangladesh or where no
   * boundary is loaded.
   */
  async areasAtPoint(tx: DatabaseTransaction, lat: number, lng: number): Promise<AreaRow[]> {
    const rows = await tx.execute(sql`
      with here as (select public.geo_point(${lat}, ${lng}) as p),
      adm3 as (
        select g.id, g.ancestor_ids from public.geo_areas g, here
        where g.adm_level = 3 and g.is_active and g.boundary is not null and st_covers(g.boundary, here.p)
        order by g.id limit 1
      ),
      adm4 as (
        select g.id from public.geo_areas g, here, adm3
        where g.parent_id = adm3.id and g.is_active and g.centroid is not null
        order by g.centroid <-> here.p limit 1
      )
      select ${AREA_COLUMNS}
      from public.geo_areas g
      where g.id in (select id from adm3)
         or g.id in (select unnest(ancestor_ids) from adm3)
         or g.id in (select id from adm4)
      order by g.adm_level`);
    return z.array(areaRow).parse([...rows]);
  }

  /**
   * Name search over the hierarchy, in both scripts — the geocoding fallback
   * when the provider is down. Prefix matches first, then by level (a
   * district before a union of the same name).
   */
  async searchByName(
    tx: DatabaseTransaction,
    query: string,
    limit: number,
  ): Promise<AreaSearchRow[]> {
    const pattern = prefixPattern(query);
    const rows = await tx.execute(sql`
      select ${AREA_COLUMNS}, p.name_en as parent_name_en, p.name_bn as parent_name_bn
      from public.geo_areas g
      left join public.geo_areas p on p.id = g.parent_id
      where g.is_active and g.adm_level > 0 and g.centroid is not null
        and (g.name_en ilike ${pattern} or g.name_bn ilike ${pattern}
             or g.name_en ilike ${`%${pattern}`})
      order by (g.name_en ilike ${pattern} or g.name_bn ilike ${pattern}) desc, g.adm_level, g.name_en
      limit ${limit}`);
    return z.array(searchRow).parse([...rows]);
  }

  /** Tenant id + whether its geo area has a boundary (polygon mode needs one). */
  async tenantArea(
    tx: DatabaseTransaction,
    tenantId: string,
  ): Promise<{ has_boundary: boolean } | undefined> {
    const rows = await tx.execute(sql`
      select ga.boundary is not null as has_boundary
      from public.tenants t join public.geo_areas ga on ga.id = t.geo_area_id
      where t.id = ${tenantId}::uuid`);
    return z.array(z.object({ has_boundary: z.boolean() })).parse([...rows])[0];
  }

  async setTenantBoundary(
    tx: DatabaseTransaction,
    tenantId: string,
    boundary:
      | { mode: 'polygon' }
      | { mode: 'radius'; center: { lat: number; lng: number }; radiusKm: number },
  ): Promise<void> {
    if (boundary.mode === 'polygon') {
      await tx.execute(sql`
        update public.tenants set boundary_mode = 'polygon', service_radius_km = null
        where id = ${tenantId}::uuid`);
    } else {
      await tx.execute(sql`
        update public.tenants
        set boundary_mode = 'radius',
            service_radius_km = ${boundary.radiusKm},
            map_center = public.geo_point(${boundary.center.lat}, ${boundary.center.lng})
        where id = ${tenantId}::uuid`);
    }
  }

  async tenantBoundary(
    tx: DatabaseTransaction,
    tenantId: string,
  ): Promise<
    | { mode: 'polygon' | 'radius'; center: { lat: number; lng: number }; radiusKm: number | null }
    | undefined
  > {
    const rows = await tx.execute(sql`
      select boundary_mode, service_radius_km::float8 as radius_km,
             st_y(map_center::geometry) as lat, st_x(map_center::geometry) as lng
      from public.tenants where id = ${tenantId}::uuid`);
    const row = z
      .array(
        z.object({
          boundary_mode: z.enum(['polygon', 'radius']),
          radius_km: z.coerce.number().nullable(),
          lat: z.coerce.number(),
          lng: z.coerce.number(),
        }),
      )
      .parse([...rows])[0];
    return (
      row && {
        mode: row.boundary_mode,
        center: { lat: row.lat, lng: row.lng },
        radiusKm: row.radius_km,
      }
    );
  }

  /** Is the point inside the tenant, and how far is it from the tenant's area (0 inside). */
  async tenantPointRelation(
    tx: DatabaseTransaction,
    tenantId: string,
    lat: number,
    lng: number,
  ): Promise<{ inside: boolean; distance_m: number } | undefined> {
    const rows = await tx.execute(sql`
      select public.tenant_covers_point(${tenantId}::uuid, public.geo_point(${lat}, ${lng})) as inside,
             public.tenant_distance_m(${tenantId}::uuid, public.geo_point(${lat}, ${lng})) as distance_m`);
    const row = z
      .array(z.object({ inside: z.boolean().nullable(), distance_m: z.coerce.number().nullable() }))
      .parse([...rows])[0];
    return row?.inside === null || row?.inside === undefined
      ? undefined
      : { inside: row.inside, distance_m: row.distance_m ?? 0 };
  }
}
