import { Injectable } from '@nestjs/common';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { SettingsService } from '../settings/settings.service';
import type {
  LocationArea,
  LocationDetail,
  PointLookup,
  TenantBoundaryInput,
  TenantBoundaryResponse,
  ViewportResponse,
} from './dto/locations.dto';
import type { BoundingBox } from './geo/geodesic';
import {
  BoundaryTenantNotFoundException,
  LocationNotFoundException,
  ServiceRadiusTooLargeException,
  TenantPolygonUnavailableException,
} from './locations.exceptions';
import { LocationsRepository, type AreaRow, type AreaSearchRow } from './locations.repository';

/** CC BY-IGO credit, in the dataset's own wording (ADR 003). */
export const GEO_ATTRIBUTION =
  'Administrative boundaries: Bangladesh Bureau of Statistics (BBS), via OCHA / HDX, CC BY 3.0 IGO';

export function toArea(row: AreaRow): LocationArea {
  return {
    id: row.id,
    parentId: row.parent_id,
    level: row.level_code,
    pcode: row.cod_pcode,
    name: { bn: row.name_bn, en: row.name_en },
    center: row.lat === null || row.lng === null ? null : { lat: row.lat, lng: row.lng },
    hasChildren: row.has_children,
  };
}

/**
 * The location hierarchy for cascading pickers and maps, point lookups, and
 * tenant boundaries. Country > Division > District > Upazila / City
 * Corporation > Union / Pourashava, from HDX COD-AB (ADR 026).
 */
@Injectable()
export class LocationsService {
  constructor(
    private readonly repo: LocationsRepository,
    private readonly tenantDb: TenantDb,
    private readonly tenantContext: TenantContext,
    private readonly settings: SettingsService,
  ) {}

  /** GET /locations?parentId= — no parentId gives the divisions. */
  async children(parentId?: string): Promise<LocationArea[]> {
    return this.read(async (tx) => {
      if (parentId !== undefined && !(await this.repo.exists(tx, parentId))) {
        throw new LocationNotFoundException();
      }
      return (await this.repo.children(tx, parentId ?? null)).map(toArea);
    });
  }

  async detail(id: string): Promise<LocationDetail> {
    const rows = await this.read((tx) => this.repo.withAncestors(tx, id));
    const area = rows.find((r) => r.id === id);
    if (!area) throw new LocationNotFoundException();
    return { area: toArea(area), path: rows.filter((r) => r.id !== id).map(toArea) };
  }

  async viewport(box: BoundingBox, level: string): Promise<ViewportResponse> {
    const max = await this.settings.get('map_viewport_max_areas');
    // One extra row tells whether the viewport holds more than the cap.
    const rows = await this.read((tx) => this.repo.inViewport(tx, box, level, max + 1));
    return {
      level,
      areas: rows.slice(0, max).map((r) => ({
        id: r.id,
        parentId: r.parent_id,
        level: r.level_code,
        pcode: r.cod_pcode,
        name: { bn: r.name_bn, en: r.name_en },
        center: r.lat === null || r.lng === null ? null : { lat: r.lat, lng: r.lng },
        boundary: (r.boundary as Record<string, unknown> | null) ?? null,
      })),
      truncated: rows.length > max,
      attribution: GEO_ATTRIBUTION,
    };
  }

  /** Areas at a point, plus the point's relation to the request's tenant (if any). */
  async lookup(lat: number, lng: number): Promise<PointLookup> {
    const tenantId = this.tenantContext.current()?.tenantId;
    return this.read(async (tx) => {
      const areas = (await this.repo.areasAtPoint(tx, lat, lng)).map(toArea);
      const relation = tenantId
        ? await this.repo.tenantPointRelation(tx, tenantId, lat, lng)
        : undefined;
      return {
        location: { lat, lng },
        areas,
        tenant: relation ? { inside: relation.inside, distanceMeters: relation.distance_m } : null,
      };
    });
  }

  /** Name search over the hierarchy (geocoding fallback). */
  searchByName(query: string, limit: number): Promise<AreaSearchRow[]> {
    return this.read((tx) => this.repo.searchByName(tx, query, limit));
  }

  areasAt(lat: number, lng: number): Promise<LocationArea[]> {
    return this.read(async (tx) => (await this.repo.areasAtPoint(tx, lat, lng)).map(toArea));
  }

  /**
   * Platform admin: a tenant covers either its area's polygon or a circle
   * around a centre. Polygon mode needs the area's boundary to be imported.
   */
  async setTenantBoundary(
    tenantId: string,
    input: TenantBoundaryInput,
  ): Promise<TenantBoundaryResponse> {
    if (input.mode === 'radius') {
      const maxKm = await this.settings.get('tenant_service_radius_max_km');
      if (input.radiusKm > maxKm) throw new ServiceRadiusTooLargeException(maxKm);
    }
    return this.tenantDb.transaction(async (tx) => {
      const area = await this.repo.tenantArea(tx, tenantId);
      if (!area) throw new BoundaryTenantNotFoundException();
      if (input.mode === 'polygon' && !area.has_boundary)
        throw new TenantPolygonUnavailableException();
      await this.repo.setTenantBoundary(tx, tenantId, input);
      const current = await this.repo.tenantBoundary(tx, tenantId);
      return { tenantId, ...current! };
    });
  }

  private read<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.tenantDb.transaction(work, { accessMode: 'read only' });
  }
}
