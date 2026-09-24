import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  auditColumns,
  geographyMultiPolygon,
  geographyPoint,
  id,
  softDeleteColumns,
  timestamptz,
} from './columns';
import { categoryKinds, geoAreaLevels, moderationModes, schemaStatuses } from './enums';
import { users } from './identity';
import { tenants } from './tenancy';

/**
 * §3.1 Bangladesh administrative boundaries (HDX COD-AB, ADR 003).
 * `ancestorIds`, `depth`-equivalents (adm_level) and the published/immutable
 * behaviours described per-column below are all trigger-maintained in SQL.
 */
export const geoAreas = pgTable('geo_areas', {
  id: id(),
  parentId: uuid('parent_id').references((): AnyPgColumn => geoAreas.id, {
    onDelete: 'restrict',
  }),
  admLevel: smallint('adm_level').notNull(),
  levelCode: text('level_code')
    .notNull()
    .references(() => geoAreaLevels.code, { onDelete: 'restrict' }),
  bbsCodeGeocode11: text('bbs_code_geocode11'),
  bbsCodeGeocode15: text('bbs_code_geocode15'),
  nameEn: text('name_en').notNull(),
  nameBn: text('name_bn'),
  // Materialised path, root first. Maintained by trigger.
  ancestorIds: uuid('ancestor_ids')
    .array()
    .notNull()
    .default(sql`'{}'::uuid[]`),
  centroid: geographyPoint('centroid'),
  boundary: geographyMultiPolygon('boundary'),
  boundarySimplified: geographyMultiPolygon('boundary_simplified'),
  needsManualReview: boolean('needs_manual_review').notNull().default(false),
  manuallyVerifiedAt: timestamptz('manually_verified_at'),
  manuallyVerifiedByUserId: uuid('manually_verified_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  sourceRelease: text('source_release').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns(),
});

/** §3.2 Informal named places (para, mohalla, bazar), curated per tenant. */
export const localities = pgTable('localities', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  geoAreaId: uuid('geo_area_id').references(() => geoAreas.id, { onDelete: 'restrict' }),
  nameBn: text('name_bn').notNull(),
  nameEn: text('name_en'),
  aliases: text('aliases')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  center: geographyPoint('center'),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  ...softDeleteColumns(),
});

/** §3.3 Global master taxonomy for posts and places. */
export const categories = pgTable('categories', {
  id: id(),
  parentId: uuid('parent_id').references((): AnyPgColumn => categories.id, {
    onDelete: 'restrict',
  }),
  kindCode: text('kind_code')
    .notNull()
    .references(() => categoryKinds.code, { onDelete: 'restrict' }),
  slug: text('slug').notNull(),
  nameBn: text('name_bn').notNull(),
  nameEn: text('name_en').notNull(),
  descriptionBn: text('description_bn'),
  descriptionEn: text('description_en'),
  iconKey: text('icon_key'),
  // Maintained by trigger from parentId.
  depth: smallint('depth').notNull().default(0),
  defaultSortOrder: integer('default_sort_order').notNull().default(0),
  defaultPostCostCredits: integer('default_post_cost_credits').notNull().default(0),
  defaultModerationModeCode: text('default_moderation_mode_code').references(
    () => moderationModes.code,
    { onDelete: 'restrict' },
  ),
  isActive: boolean('is_active').notNull().default(true),
  ...softDeleteColumns(),
});

/** §3.4 Versioned JSON Schema defining a category's custom fields. */
export const categoryFieldSchemas = pgTable('category_field_schemas', {
  id: id(),
  categoryId: uuid('category_id')
    .notNull()
    .references(() => categories.id, { onDelete: 'restrict' }),
  version: integer('version').notNull(),
  jsonSchema: jsonb('json_schema').$type<Record<string, unknown>>().notNull(),
  uiSchema: jsonb('ui_schema')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  filterableFields: text('filterable_fields')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  analyticsFields: text('analytics_fields')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  statusCode: text('status_code')
    .notNull()
    .default('draft')
    .references(() => schemaStatuses.code, { onDelete: 'restrict' }),
  publishedAt: timestamptz('published_at'),
  publishedByUserId: uuid('published_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  ...auditColumns(),
});

/** §3.5 A tenant enabling, ordering and pricing a global category. */
export const tenantCategories = pgTable('tenant_categories', {
  id: id(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  categoryId: uuid('category_id')
    .notNull()
    .references(() => categories.id, { onDelete: 'restrict' }),
  isEnabled: boolean('is_enabled').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  postCostCredits: integer('post_cost_credits'),
  moderationModeCode: text('moderation_mode_code').references(() => moderationModes.code, {
    onDelete: 'restrict',
  }),
  ...auditColumns(),
});
