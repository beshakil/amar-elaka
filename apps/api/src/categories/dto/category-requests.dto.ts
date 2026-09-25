import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';

/** Mirrors categories_kind_code_fk values (0004, 0017). */
export const CATEGORY_KINDS = [
  'marketplace',
  'service',
  'job',
  'rental',
  'place',
  'module',
] as const;
/** Mirrors category_modules (0017). */
export const MODULE_CODES = ['emergency', 'blood', 'bazar'] as const;
/** Mirrors monetization_modes (0018). */
export const MONETIZATION_MODES = [
  'per_listing',
  'boost',
  'subscription',
  'lead_fee',
  'free',
] as const;

// settings-exempt: generic input-length caps, not business thresholds.
const name = z.string().trim().min(1).max(120);
// settings-exempt: generic input-length caps, not business thresholds.
const description = z.string().trim().min(1).max(2000);
const slug = z
  .string()
  // settings-exempt: generic input-length caps, not business thresholds.
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lower-case words joined by hyphens');
// settings-exempt: generic input-length caps, not business thresholds.
const iconKey = z.string().trim().min(1).max(60);

const editableFields = {
  parentId: z.string().uuid().nullable(),
  nameBn: name,
  nameEn: name,
  descriptionBn: description.nullable(),
  descriptionEn: description.nullable(),
  iconKey: iconKey.nullable(),
  sortOrder: z.number().int().nonnegative(),
  monetizationMode: z.enum(MONETIZATION_MODES),
  postCostCredits: z.number().int().nonnegative(),
  /** NULL = the post_expiry_days_default setting. Must be NULL for place/module. */
  postExpiryDays: z.number().int().positive().nullable(),
  /** true = pre-moderation (`default_moderation_mode_code = 'pre'`). */
  requiresApproval: z.boolean(),
  isActive: z.boolean(),
};

export const createCategorySchema = z
  .object({
    slug,
    kind: z.enum(CATEGORY_KINDS),
    moduleCode: z.enum(MODULE_CODES).nullable().default(null),
    ...editableFields,
    parentId: editableFields.parentId.default(null),
    descriptionBn: editableFields.descriptionBn.default(null),
    descriptionEn: editableFields.descriptionEn.default(null),
    iconKey: editableFields.iconKey.default(null),
    sortOrder: editableFields.sortOrder.default(0),
    monetizationMode: editableFields.monetizationMode.default('free'),
    postCostCredits: editableFields.postCostCredits.default(0),
    postExpiryDays: editableFields.postExpiryDays.default(null),
    requiresApproval: editableFields.requiresApproval.default(false),
    isActive: editableFields.isActive.default(true),
  })
  .strict();
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export class CreateCategoryDto extends createZodDto(createCategorySchema) {}

/** Kind, module and slug are fixed once created: posts and URLs depend on them. */
export const updateCategorySchema = z
  .object(editableFields)
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Provide at least one field.' });
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export class UpdateCategoryDto extends createZodDto(updateCategorySchema) {}

/** `:id`, the name AuditLogInterceptor records as the entity id. */
export const categoryIdParamSchema = z.object({ id: z.string().uuid() });
export class CategoryIdParamDto extends createZodDto(categoryIdParamSchema) {}

export const fieldSchemaIdParamSchema = z.object({ schemaId: z.string().uuid() });
export class FieldSchemaIdParamDto extends createZodDto(fieldSchemaIdParamSchema) {}

/**
 * The category's own fields, authored in the engine's JSON Schema subset
 * (categories.md §3.2). Checked structurally and semantically by the engine,
 * so it is only shaped here.
 */
export const saveFieldSchemaDraftSchema = z
  .object({
    jsonSchema: z.record(z.unknown()),
    uiSchema: z.record(z.unknown()),
    filterableFields: z.array(z.string()),
    searchableFields: z.array(z.string()),
    analyticsFields: z.array(z.string()),
  })
  .strict();
export class SaveFieldSchemaDraftDto extends createZodDto(saveFieldSchemaDraftSchema) {}

export const updateTenantCategorySchema = z
  .object({
    isEnabled: z.boolean(),
    /** NULL = the category default. */
    postCostCredits: z.number().int().nonnegative().nullable(),
    postExpiryDays: z.number().int().positive().nullable(),
    /** NULL = the category default; can only make moderation stricter (0004 trigger). */
    requiresApproval: z.boolean().nullable(),
  })
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Provide at least one field.' });
export type UpdateTenantCategoryInput = z.infer<typeof updateTenantCategorySchema>;
export class UpdateTenantCategoryDto extends createZodDto(updateTenantCategorySchema) {}

export const reorderTenantCategoriesSchema = z
  .object({
    /** The tenant's categories in display order; unlisted ones keep their place after these. */
    categoryIds: z
      .array(z.string().uuid())
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'Duplicate category ids.' }),
  })
  .strict();
export class ReorderTenantCategoriesDto extends createZodDto(reorderTenantCategoriesSchema) {}
