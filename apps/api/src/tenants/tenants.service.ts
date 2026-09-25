import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import type { DatabaseTransaction } from '../database/database.client';
import { rootDomainSuffixOf, tenantSignalFromHostname } from '../database/hostname-tenant-signal';
import { emergencyContacts } from '../database/schema/local-info';
import { categories, geoAreas, tenantCategories } from '../database/schema/catalog';
import { tenants, tenantSettings } from '../database/schema/tenancy';
import { TenantDb } from '../database/tenant-db';
import { TenantLookupService } from '../database/tenant-lookup.service';
import { SettingsService } from '../settings/settings.service';
import type { ResolvedHost, TenantConfig, TenantSummary } from './dto/tenant-responses.dto';
import { NoTenantNearbyException } from './tenants.exceptions';

// Directory is for new users picking a tenant to sign up in, not a general
// listing — suspended/terminated tenants are real (nearby still finds them,
// existing members can still browse/log in per schema.md §13.30) but
// picking one to *join* would be misleading, so they're left out here.
const LISTED_STATUSES = ['active', 'past_due'] as const;

// District is the ADM2 entry in geo_areas.ancestor_ids (tenants are always
// upazila/ADM3, ADR 003's ADM0–ADM4 levels).
// settings-exempt: fixed by the HDX COD-AB administrative level numbering, not a tunable business threshold.
const DISTRICT_ADM_LEVEL = 2;

const districtArea = alias(geoAreas, 'district_area');

const RadiusRow = z.object({ radius_m: z.coerce.number().nullable() });
const NearbyRow = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name_bn: z.string(),
  name_en: z.string(),
  lng: z.coerce.number(),
  lat: z.coerce.number(),
  district_name_bn: z.string().nullable(),
  district_name_en: z.string().nullable(),
});

@Injectable()
export class TenantsService {
  private readonly rootDomainSuffix: string;

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly settings: SettingsService,
    private readonly lookup: TenantLookupService,
    @Inject(APP_CONFIG) env: Pick<Env, 'APP_ROOT_DOMAIN'>,
  ) {
    this.rootDomainSuffix = rootDomainSuffixOf(env.APP_ROOT_DOMAIN);
  }

  /**
   * Resolves a *browser's* hostname to a tenant id, for a server-side caller
   * (apps/web's middleware) that can't forward the original Host header to
   * this API and so can't rely on TenantResolutionMiddleware's own Host
   * handling. Same precedence and same lookups as that middleware — an
   * unknown host is a legitimate answer (`tenantId: null`), not an error.
   */
  async resolveByHost(host: string): Promise<ResolvedHost> {
    const signal = tenantSignalFromHostname(host, this.rootDomainSuffix);
    const tenant = await (() => {
      switch (signal.kind) {
        case 'slug':
          return this.lookup.resolveBySlug(signal.slug);
        case 'custom_domain':
          return this.lookup.resolveByCustomDomain(signal.domain);
        case 'absent':
        case 'unusable':
          return undefined;
      }
    })();
    return { tenantId: tenant?.id ?? null };
  }

  async getConfig(tenantId: string): Promise<TenantConfig> {
    return this.tenantDb.transaction(
      async (tx) => {
        const [tenant] = await tx
          .select({
            id: tenants.id,
            slug: tenants.slug,
            nameBn: tenants.nameBn,
            nameEn: tenants.nameEn,
            defaultLocale: tenants.defaultLocale,
            geoAreaId: tenants.geoAreaId,
            lng: sql<number>`st_x(${tenants.mapCenter}::geometry)`,
            lat: sql<number>`st_y(${tenants.mapCenter}::geometry)`,
          })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .limit(1);
        // TenantGateGuard already confirmed this tenant exists and is active.
        if (!tenant) throw new Error(`tenants: config requested for unknown tenant ${tenantId}`);
        const { lng, lat } = tenant;

        const [settingsRow] = await tx
          .select({
            contactPhoneE164: tenantSettings.contactPhoneE164,
            contactEmail: tenantSettings.contactEmail,
            whatsappE164: tenantSettings.whatsappE164,
            logoStorageKey: tenantSettings.logoStorageKey,
            featureFlags: tenantSettings.featureFlags,
          })
          .from(tenantSettings)
          .where(eq(tenantSettings.tenantId, tenantId))
          .limit(1);

        const categoryRows = await tx
          .select({
            slug: categories.slug,
            nameBn: categories.nameBn,
            nameEn: categories.nameEn,
            iconKey: categories.iconKey,
          })
          .from(tenantCategories)
          .innerJoin(categories, eq(categories.id, tenantCategories.categoryId))
          .where(and(eq(tenantCategories.tenantId, tenantId), eq(tenantCategories.isEnabled, true)))
          .orderBy(asc(tenantCategories.sortOrder));

        const emergencyRows = await tx
          .select({
            serviceType: emergencyContacts.serviceTypeCode,
            nameBn: emergencyContacts.nameBn,
            nameEn: emergencyContacts.nameEn,
            phones: emergencyContacts.phones,
            is24h: emergencyContacts.is24h,
          })
          .from(emergencyContacts)
          .where(
            and(
              eq(emergencyContacts.tenantId, tenantId),
              eq(emergencyContacts.isActive, true),
              isNull(emergencyContacts.deletedAt),
            ),
          )
          .orderBy(asc(emergencyContacts.sortOrder));

        const radiusKm = await this.boundaryRadiusKm(tx, tenant.id);

        return {
          id: tenant.id,
          slug: tenant.slug,
          nameBn: tenant.nameBn,
          nameEn: tenant.nameEn,
          defaultLocale: tenant.defaultLocale,
          mapCenter: { lat, lng },
          radiusKm,
          branding: { logoStorageKey: settingsRow?.logoStorageKey ?? null },
          featureFlags: settingsRow?.featureFlags ?? {},
          enabledCategories: categoryRows,
          emergencyNumbers: emergencyRows,
          support: {
            phoneE164: settingsRow?.contactPhoneE164 ?? null,
            email: settingsRow?.contactEmail ?? null,
            whatsappE164: settingsRow?.whatsappE164 ?? null,
          },
        };
      },
      { accessMode: 'read only' },
    );
  }

  async findNearby(lat: number, lng: number): Promise<TenantSummary> {
    const maxRadiusKm = await this.settings.get('tenant_nearby_max_radius_km');
    // settings-exempt: km-to-metres, not a business threshold (maxRadiusKm itself is settings-driven).
    const maxRadiusMeters = maxRadiusKm * 1000;

    return this.tenantDb.transaction(
      async (tx) => {
        // nearest_tenants() (0021): a tenant whose area contains the point
        // wins; otherwise the smallest distance to a tenant's area — its
        // polygon, or its centre + radius for radius-mode tenants.
        const rows = await tx.execute(sql`
        select t.id, t.slug, t.name_bn, t.name_en,
          st_x(t.map_center::geometry) as lng, st_y(t.map_center::geometry) as lat,
          district.name_bn as district_name_bn, district.name_en as district_name_en
        from public.nearest_tenants(public.geo_point(${lat}, ${lng}), ${maxRadiusMeters}, 1) n
        join public.tenants t on t.id = n.tenant_id
        left join public.geo_areas ga on ga.id = t.geo_area_id
        left join public.geo_areas district
          on district.id = any(ga.ancestor_ids) and district.adm_level = ${DISTRICT_ADM_LEVEL}
      `);
        const [nearestRow] = z.array(NearbyRow).parse([...rows]);
        if (!nearestRow) throw new NoTenantNearbyException();
        return toSummary(nearestRow);
      },
      { accessMode: 'read only' },
    );
  }

  async list(): Promise<TenantSummary[]> {
    return this.tenantDb.transaction(
      async (tx) => {
        const rows = await tx
          .select({
            id: tenants.id,
            slug: tenants.slug,
            nameBn: tenants.nameBn,
            nameEn: tenants.nameEn,
            lng: sql<number>`st_x(${tenants.mapCenter}::geometry)`,
            lat: sql<number>`st_y(${tenants.mapCenter}::geometry)`,
            districtNameBn: districtArea.nameBn,
            districtNameEn: districtArea.nameEn,
          })
          .from(tenants)
          .leftJoin(geoAreas, eq(geoAreas.id, tenants.geoAreaId))
          .leftJoin(
            districtArea,
            and(
              sql`${districtArea.id} = any(${geoAreas.ancestorIds})`,
              eq(districtArea.admLevel, DISTRICT_ADM_LEVEL),
            ),
          )
          .where(inArray(tenants.statusCode, [...LISTED_STATUSES]))
          .orderBy(asc(tenants.slug));

        return rows.map((row) => ({
          id: row.id,
          slug: row.slug,
          nameBn: row.nameBn,
          nameEn: row.nameEn,
          mapCenter: { lat: row.lat, lng: row.lng },
          districtNameBn: row.districtNameBn,
          districtNameEn: row.districtNameEn,
        }));
      },
      { accessMode: 'read only' },
    );
  }

  /**
   * How far the tenant reaches from its centre, in km: the service radius in
   * radius mode; in polygon mode the geodesic distance from the centre to the
   * farthest boundary vertex (display boundary — this is for map zoom, not
   * ownership). Geography, so metres: a geometry in EPSG:4326 would measure
   * degrees.
   */
  private async boundaryRadiusKm(
    tx: DatabaseTransaction,
    tenantId: string,
  ): Promise<number | null> {
    const rows = await tx.execute(sql`
      select case
        when t.boundary_mode = 'radius' then t.service_radius_km::float8 * 1000
        else (
          select max(st_distance(t.map_center, (dp).geom::geography))
          from st_dumppoints(coalesce(ga.boundary_simplified, ga.boundary)::geometry) dp
        )
      end as radius_m
      from public.tenants t
      left join public.geo_areas ga on ga.id = t.geo_area_id
      where t.id = ${tenantId}::uuid
    `);
    const [row] = z.array(RadiusRow).parse([...rows]);
    // settings-exempt: metres-to-km, not a business threshold.
    return row?.radius_m != null ? row.radius_m / 1000 : null;
  }
}

function toSummary(row: z.infer<typeof NearbyRow>): TenantSummary {
  return {
    id: row.id,
    slug: row.slug,
    nameBn: row.name_bn,
    nameEn: row.name_en,
    mapCenter: { lat: row.lat, lng: row.lng },
    districtNameBn: row.district_name_bn,
    districtNameEn: row.district_name_en,
  };
}
