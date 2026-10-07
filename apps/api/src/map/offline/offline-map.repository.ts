import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../../database/database.client';
import type { Bounds } from './pmtiles-cli';

// settings-exempt: unit conversion
const METERS_PER_KM = 1000;

const FILE_ROW = z.object({
  id: z.string(),
  national_version: z.string(),
  status_code: z.enum(['ready', 'too_large', 'failed']),
  file_name: z.string().nullable(),
  bytes: z.coerce.number().nullable(),
  sha256: z.string().nullable(),
  max_zoom: z.number().nullable(),
  min_lng: z.coerce.number().nullable(),
  min_lat: z.coerce.number().nullable(),
  max_lng: z.coerce.number().nullable(),
  max_lat: z.coerce.number().nullable(),
  built_at: z.coerce.date(),
});
export type OfflineFileRow = z.infer<typeof FILE_ROW>;

const FILE_COLUMNS = sql`
  id, national_version, status_code, file_name, bytes, sha256, max_zoom,
  min_lng, min_lat, max_lng, max_lat, built_at`;

export interface OfflineFileResult {
  tenantId: string;
  nationalVersion: string;
  status: 'ready' | 'too_large' | 'failed';
  fileName: string | null;
  bytes: number | null;
  sha256: string | null;
  maxZoom: number | null;
  bounds: Bounds | null;
  error: string | null;
}

/** offline_map_files and the geometry the offline map needs (0045). */
@Injectable()
export class OfflineMapRepository {
  /** Tenants that serve visitors: the ones whose maps are worth cutting. */
  async liveTenants(tx: DatabaseTransaction): Promise<{ id: string }[]> {
    const rows = await tx.execute(sql`
      select id from public.tenants where status_code in ('active', 'past_due') order by id`);
    return z.array(z.object({ id: z.string() })).parse([...rows]);
  }

  /**
   * The tenant's boundary grown by `bufferKm`, as a lng/lat box (the map's
   * centre, grown the same, when the area has no boundary).
   */
  async tenantBounds(
    tx: DatabaseTransaction,
    tenantId: string,
    bufferKm: number,
  ): Promise<Bounds | undefined> {
    const rows = await tx.execute(sql`
      select st_xmin(b)::float8 as min_lng, st_ymin(b)::float8 as min_lat,
             st_xmax(b)::float8 as max_lng, st_ymax(b)::float8 as max_lat
      from (
        -- The tenant's area as nearest_tenants (0021) defines it: a radius-mode
        -- tenant's circle (centre + service_radius_km), else its polygon (or
        -- just its centre); then the offline buffer around that.
        select st_extent(case
                 when t.boundary_mode = 'radius'
                   then st_buffer(t.map_center::geography,
                                  coalesce(t.service_radius_km, 0) * ${METERS_PER_KM}::float8
                                  + ${bufferKm * METERS_PER_KM}::float8)
                 else st_buffer(coalesce(g.boundary, g.boundary_simplified, t.map_center::geography),
                                ${bufferKm * METERS_PER_KM}::float8)
               end::geometry) as b
        from public.tenants t
        left join public.geo_areas g on g.id = t.geo_area_id
        where t.id = ${tenantId}::uuid
      ) x`);
    const row = z
      .array(
        z.object({
          min_lng: z.number().nullable(),
          min_lat: z.number().nullable(),
          max_lng: z.number().nullable(),
          max_lat: z.number().nullable(),
        }),
      )
      .max(1)
      .parse([...rows])[0];
    if (
      !row ||
      row.min_lng === null ||
      row.min_lat === null ||
      row.max_lng === null ||
      row.max_lat === null
    ) {
      return undefined;
    }
    return [row.min_lng, row.min_lat, row.max_lng, row.max_lat];
  }

  async forVersion(
    tx: DatabaseTransaction,
    tenantId: string,
    version: string,
  ): Promise<OfflineFileRow | undefined> {
    const rows = await tx.execute(sql`
      select ${FILE_COLUMNS} from public.offline_map_files
      where tenant_id = ${tenantId}::uuid and national_version = ${version}`);
    return z
      .array(FILE_ROW)
      .max(1)
      .parse([...rows])[0];
  }

  async save(tx: DatabaseTransaction, result: OfflineFileResult): Promise<void> {
    const [minLng, minLat, maxLng, maxLat] = result.bounds ?? [null, null, null, null];
    await tx.execute(sql`
      insert into public.offline_map_files
        (tenant_id, national_version, status_code, file_name, bytes, sha256, max_zoom,
         min_lng, min_lat, max_lng, max_lat, error, built_at)
      values (${result.tenantId}::uuid, ${result.nationalVersion}, ${result.status}, ${result.fileName},
              ${result.bytes}, ${result.sha256}, ${result.maxZoom}, ${minLng}, ${minLat}, ${maxLng}, ${maxLat},
              ${result.error}, now())
      on conflict (tenant_id, national_version) do update set
        status_code = excluded.status_code, file_name = excluded.file_name, bytes = excluded.bytes,
        sha256 = excluded.sha256, max_zoom = excluded.max_zoom, min_lng = excluded.min_lng,
        min_lat = excluded.min_lat, max_lng = excluded.max_lng, max_lat = excluded.max_lat,
        error = excluded.error, built_at = now()`);
  }

  /** Ready files of a tenant beyond the newest `keep`: removed, their file names returned. */
  async pruneReady(tx: DatabaseTransaction, tenantId: string, keep: number): Promise<string[]> {
    const rows = await tx.execute(sql`
      delete from public.offline_map_files
      where id in (
        select id from public.offline_map_files
        where tenant_id = ${tenantId}::uuid and status_code = 'ready'
        order by built_at desc, id desc
        offset ${keep}
      )
      returning file_name`);
    return z
      .array(z.object({ file_name: z.string().nullable() }))
      .parse([...rows])
      .flatMap((r) => (r.file_name ? [r.file_name] : []));
  }

  /** The current tenant's newest ready file (RLS: its own rows). */
  async latestReady(tx: DatabaseTransaction): Promise<OfflineFileRow | undefined> {
    const rows = await tx.execute(sql`
      select ${FILE_COLUMNS} from public.offline_map_files
      where status_code = 'ready'
      order by built_at desc, id desc
      limit 1`);
    return z
      .array(FILE_ROW)
      .max(1)
      .parse([...rows])[0];
  }

  /** The current tenant's own outline and the areas inside it, simplified, as GeoJSON features. */
  async areas(tx: DatabaseTransaction, toleranceDeg: number): Promise<unknown[]> {
    const rows = await tx.execute(sql`
      with own as (
        select g.id from public.tenants t join public.geo_areas g on g.id = t.geo_area_id
        where t.id = public.current_tenant_id()
      )
      select jsonb_build_object(
               'type', 'Feature',
               'id', g.id,
               'geometry', st_asgeojson(st_multi(st_simplifypreservetopology(
                             coalesce(g.boundary_simplified, g.boundary)::geometry, ${toleranceDeg}::float8)), 6)::jsonb,
               'properties', jsonb_build_object(
                 'id', g.id, 'level', g.level_code, 'adm_level', g.adm_level,
                 'name_bn', g.name_bn, 'name_en', g.name_en)) as feature
      from public.geo_areas g, own
      where (g.id = own.id or own.id = any (g.ancestor_ids))
        and g.is_active and coalesce(g.boundary_simplified, g.boundary) is not null
      order by g.adm_level, g.id`);
    return z
      .array(z.object({ feature: z.unknown() }))
      .parse([...rows])
      .map((r) => r.feature);
  }
}
