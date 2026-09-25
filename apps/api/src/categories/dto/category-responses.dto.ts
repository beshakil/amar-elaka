import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';
import { CATEGORY_KINDS, MODULE_CODES, MONETIZATION_MODES } from './category-requests.dto';

/**
 * Response shapes, defined once (same pattern as tenants/dto): services
 * return the inferred types, and the DTO classes carry the schemas into
 * OpenAPI for the generated clients. The JSON Schema / UI schema bodies are
 * documented as open objects; their shape is the engine's
 * (categories/field-schema/field-schema.types.ts).
 */

const localized = z.object({ bn: z.string(), en: z.string() });
const jsonObject = z.record(z.unknown());

export const fieldSchemaVersionSchema = z.object({
  id: z.string(),
  categoryId: z.string(),
  version: z.number(),
  status: z.enum(['draft', 'published', 'retired']),
  jsonSchema: jsonObject,
  uiSchema: jsonObject,
  filterableFields: z.array(z.string()),
  searchableFields: z.array(z.string()),
  publishedAt: z.string().nullable(),
});
export type FieldSchemaVersion = z.infer<typeof fieldSchemaVersionSchema>;
export class FieldSchemaVersionDto extends createZodDto(fieldSchemaVersionSchema) {}

export const fieldSchemaVersionSummarySchema = fieldSchemaVersionSchema.pick({
  id: true,
  version: true,
  status: true,
  publishedAt: true,
});
export type FieldSchemaVersionSummary = z.infer<typeof fieldSchemaVersionSummarySchema>;
export class FieldSchemaVersionSummaryDto extends createZodDto(fieldSchemaVersionSummarySchema) {}

export const platformCategorySchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  kind: z.enum(CATEGORY_KINDS),
  moduleCode: z.enum(MODULE_CODES).nullable(),
  slug: z.string(),
  nameBn: z.string(),
  nameEn: z.string(),
  descriptionBn: z.string().nullable(),
  descriptionEn: z.string().nullable(),
  iconKey: z.string().nullable(),
  depth: z.number(),
  sortOrder: z.number(),
  monetizationMode: z.enum(MONETIZATION_MODES),
  postCostCredits: z.number(),
  postExpiryDays: z.number().nullable(),
  requiresApproval: z.boolean(),
  isActive: z.boolean(),
  publishedSchemaVersion: z.number().nullable(),
  hasDraft: z.boolean(),
});
export type PlatformCategory = z.infer<typeof platformCategorySchema>;
export class PlatformCategoryDto extends createZodDto(platformCategorySchema) {}

export const tenantCategorySettingSchema = z.object({
  categoryId: z.string(),
  parentId: z.string().nullable(),
  slug: z.string(),
  kind: z.enum(CATEGORY_KINDS),
  nameBn: z.string(),
  nameEn: z.string(),
  isEnabled: z.boolean(),
  sortOrder: z.number().nullable(),
  /** Tenant overrides; NULL = the category default shown next to it. */
  postCostCredits: z.number().nullable(),
  postExpiryDays: z.number().nullable(),
  requiresApproval: z.boolean().nullable(),
  defaults: z.object({
    postCostCredits: z.number(),
    postExpiryDays: z.number().nullable(),
    requiresApproval: z.boolean(),
  }),
});
export type TenantCategorySetting = z.infer<typeof tenantCategorySettingSchema>;
export class TenantCategorySettingDto extends createZodDto(tenantCategorySettingSchema) {}

/** GET /categories: one enabled category, with everything a client needs to render and post. */
export const catalogCategorySchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  slug: z.string(),
  kind: z.enum(CATEGORY_KINDS),
  moduleCode: z.enum(MODULE_CODES).nullable(),
  name: localized,
  description: z.object({ bn: z.string().nullable(), en: z.string().nullable() }),
  iconKey: z.string().nullable(),
  /** Effective for this tenant (override, else category default, else setting). */
  postCostCredits: z.number(),
  postExpiryDays: z.number().nullable(),
  requiresApproval: z.boolean(),
  /** The current version; NULL for module tiles. Posts pin `fieldSchema.id`. */
  fieldSchema: fieldSchemaVersionSchema.omit({ categoryId: true, status: true }).nullable(),
});
export type CatalogCategory = z.infer<typeof catalogCategorySchema>;
export class CatalogCategoryDto extends createZodDto(catalogCategorySchema) {}
