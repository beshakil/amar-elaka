import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';

/**
 * Response shapes, defined once: the service's return types are inferred from
 * these schemas (so the compiler proves the schema matches what is actually
 * returned), and the DTO classes carry the same schemas into the OpenAPI
 * document, which is where the generated clients get their response types.
 */

const mapCenterSchema = z.object({ lat: z.number(), lng: z.number() });

export const tenantSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  nameBn: z.string(),
  nameEn: z.string(),
  mapCenter: mapCenterSchema,
  districtNameBn: z.string().nullable(),
  districtNameEn: z.string().nullable(),
});
export type TenantSummary = z.infer<typeof tenantSummarySchema>;
export class TenantSummaryDto extends createZodDto(tenantSummarySchema) {}

export const tenantConfigSchema = z.object({
  id: z.string(),
  slug: z.string(),
  nameBn: z.string(),
  nameEn: z.string(),
  defaultLocale: z.string(),
  mapCenter: mapCenterSchema,
  radiusKm: z.number().nullable(),
  branding: z.object({ logoStorageKey: z.string().nullable() }),
  featureFlags: z.record(z.unknown()),
  enabledCategories: z.array(
    z.object({
      slug: z.string(),
      nameBn: z.string(),
      nameEn: z.string(),
      iconKey: z.string().nullable(),
    }),
  ),
  emergencyNumbers: z.array(
    z.object({
      serviceType: z.string(),
      nameBn: z.string(),
      nameEn: z.string().nullable(),
      phones: z.array(z.string()),
      is24h: z.boolean(),
    }),
  ),
  support: z.object({
    phoneE164: z.string().nullable(),
    email: z.string().nullable(),
    whatsappE164: z.string().nullable(),
  }),
});
export type TenantConfig = z.infer<typeof tenantConfigSchema>;
export class TenantConfigDto extends createZodDto(tenantConfigSchema) {}

/**
 * Always an object, with `tenantId: null` for a host that maps to nothing —
 * an unknown host is a normal answer, and a bare `null` body is awkward to
 * describe in OpenAPI and to branch on in a client.
 */
export const resolvedHostSchema = z.object({ tenantId: z.string().nullable() });
export type ResolvedHost = z.infer<typeof resolvedHostSchema>;
export class ResolvedHostDto extends createZodDto(resolvedHostSchema) {}
