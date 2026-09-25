import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, max, ne, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.client';
import { categories, categoryFieldSchemas, tenantCategories } from '../database/schema/catalog';
import { tenants, tenantSettings } from '../database/schema/tenancy';
import type { CategoryKind, ModuleCode, MonetizationMode } from './categories.types';

/**
 * Every query of the category engine. Methods take the caller's transaction:
 * the services decide transaction boundaries (publishing retires, publishes
 * and re-flattens children atomically), and RLS applies to all of it through
 * TenantDb's per-transaction context.
 */

export interface CategoryRow {
  id: string;
  parentId: string | null;
  kind: CategoryKind;
  moduleCode: ModuleCode | null;
  slug: string;
  nameBn: string;
  nameEn: string;
  descriptionBn: string | null;
  descriptionEn: string | null;
  iconKey: string | null;
  depth: number;
  sortOrder: number;
  monetizationMode: MonetizationMode;
  postCostCredits: number;
  postExpiryDays: number | null;
  moderationModeCode: string | null;
  isActive: boolean;
}

export interface FieldSchemaRow {
  id: string;
  categoryId: string;
  version: number;
  status: 'draft' | 'published' | 'retired';
  jsonSchema: Record<string, unknown>;
  uiSchema: Record<string, unknown>;
  filterableFields: string[];
  searchableFields: string[];
  analyticsFields: string[];
  authoredDefinition: Record<string, unknown>;
  publishedAt: Date | null;
}

export interface NewCategory {
  parentId: string | null;
  kind: CategoryKind;
  moduleCode: ModuleCode | null;
  slug: string;
  nameBn: string;
  nameEn: string;
  descriptionBn: string | null;
  descriptionEn: string | null;
  iconKey: string | null;
  sortOrder: number;
  monetizationMode: MonetizationMode;
  postCostCredits: number;
  postExpiryDays: number | null;
  moderationModeCode: 'pre' | null;
  isActive: boolean;
}

export type CategoryChanges = {
  [K in keyof Omit<NewCategory, 'kind' | 'moduleCode' | 'slug'>]?: NewCategory[K] | undefined;
};

export interface FieldSchemaContent {
  jsonSchema: Record<string, unknown>;
  uiSchema: Record<string, unknown>;
  filterableFields: string[];
  searchableFields: string[];
  analyticsFields: string[];
  authoredDefinition: Record<string, unknown>;
}

export interface TenantCategoryRow {
  categoryId: string;
  isEnabled: boolean;
  sortOrder: number;
  postCostCredits: number | null;
  postExpiryDays: number | null;
  moderationModeCode: string | null;
}

const categoryColumns = {
  id: categories.id,
  parentId: categories.parentId,
  kind: sql<CategoryKind>`${categories.kindCode}`,
  moduleCode: sql<ModuleCode | null>`${categories.moduleCode}`,
  slug: categories.slug,
  nameBn: categories.nameBn,
  nameEn: categories.nameEn,
  descriptionBn: categories.descriptionBn,
  descriptionEn: categories.descriptionEn,
  iconKey: categories.iconKey,
  depth: categories.depth,
  sortOrder: categories.defaultSortOrder,
  monetizationMode: sql<MonetizationMode>`${categories.monetizationModeCode}`,
  postCostCredits: categories.defaultPostCostCredits,
  postExpiryDays: categories.defaultPostExpiryDays,
  moderationModeCode: categories.defaultModerationModeCode,
  isActive: categories.isActive,
};

const schemaColumns = {
  id: categoryFieldSchemas.id,
  categoryId: categoryFieldSchemas.categoryId,
  version: categoryFieldSchemas.version,
  status: sql<FieldSchemaRow['status']>`${categoryFieldSchemas.statusCode}`,
  jsonSchema: categoryFieldSchemas.jsonSchema,
  uiSchema: categoryFieldSchemas.uiSchema,
  filterableFields: categoryFieldSchemas.filterableFields,
  searchableFields: categoryFieldSchemas.searchableFields,
  analyticsFields: categoryFieldSchemas.analyticsFields,
  authoredDefinition: categoryFieldSchemas.authoredDefinition,
  publishedAt: categoryFieldSchemas.publishedAt,
};

const live = isNull(categories.deletedAt);

@Injectable()
export class CategoriesRepository {
  // ---- categories -------------------------------------------------------------

  listAll(tx: DatabaseTransaction): Promise<CategoryRow[]> {
    return tx
      .select(categoryColumns)
      .from(categories)
      .where(live)
      .orderBy(asc(categories.depth), asc(categories.defaultSortOrder), asc(categories.slug));
  }

  /** `lock` takes FOR UPDATE: publishing serialises on the category row. */
  async findById(
    tx: DatabaseTransaction,
    id: string,
    options: { lock?: boolean } = {},
  ): Promise<CategoryRow | undefined> {
    const query = tx
      .select(categoryColumns)
      .from(categories)
      .where(and(eq(categories.id, id), live));
    const [row] = await (options.lock ? query.for('update') : query);
    return row;
  }

  async insert(tx: DatabaseTransaction, category: NewCategory): Promise<string> {
    const [row] = await tx
      .insert(categories)
      .values({
        parentId: category.parentId,
        kindCode: category.kind,
        moduleCode: category.moduleCode,
        slug: category.slug,
        nameBn: category.nameBn,
        nameEn: category.nameEn,
        descriptionBn: category.descriptionBn,
        descriptionEn: category.descriptionEn,
        iconKey: category.iconKey,
        defaultSortOrder: category.sortOrder,
        monetizationModeCode: category.monetizationMode,
        defaultPostCostCredits: category.postCostCredits,
        defaultPostExpiryDays: category.postExpiryDays,
        defaultModerationModeCode: category.moderationModeCode,
        isActive: category.isActive,
      })
      .returning({ id: categories.id });
    return row!.id;
  }

  async update(tx: DatabaseTransaction, id: string, changes: CategoryChanges): Promise<void> {
    await tx
      .update(categories)
      .set({
        ...(changes.parentId !== undefined ? { parentId: changes.parentId } : {}),
        ...(changes.nameBn !== undefined ? { nameBn: changes.nameBn } : {}),
        ...(changes.nameEn !== undefined ? { nameEn: changes.nameEn } : {}),
        ...(changes.descriptionBn !== undefined ? { descriptionBn: changes.descriptionBn } : {}),
        ...(changes.descriptionEn !== undefined ? { descriptionEn: changes.descriptionEn } : {}),
        ...(changes.iconKey !== undefined ? { iconKey: changes.iconKey } : {}),
        ...(changes.sortOrder !== undefined ? { defaultSortOrder: changes.sortOrder } : {}),
        ...(changes.monetizationMode !== undefined
          ? { monetizationModeCode: changes.monetizationMode }
          : {}),
        ...(changes.postCostCredits !== undefined
          ? { defaultPostCostCredits: changes.postCostCredits }
          : {}),
        ...(changes.postExpiryDays !== undefined
          ? { defaultPostExpiryDays: changes.postExpiryDays }
          : {}),
        ...(changes.moderationModeCode !== undefined
          ? { defaultModerationModeCode: changes.moderationModeCode }
          : {}),
        ...(changes.isActive !== undefined ? { isActive: changes.isActive } : {}),
      })
      .where(and(eq(categories.id, id), live));
  }

  async softDelete(tx: DatabaseTransaction, id: string): Promise<void> {
    await tx
      .update(categories)
      .set({ deletedAt: sql`now()`, isActive: false })
      .where(and(eq(categories.id, id), live));
  }

  async childIds(tx: DatabaseTransaction, parentId: string): Promise<string[]> {
    const rows = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.parentId, parentId), live))
      .orderBy(asc(categories.defaultSortOrder));
    return rows.map((row) => row.id);
  }

  // ---- field schema versions ----------------------------------------------------

  async findSchema(
    tx: DatabaseTransaction,
    categoryId: string,
    status: 'draft' | 'published',
  ): Promise<FieldSchemaRow | undefined> {
    const [row] = await tx
      .select(schemaColumns)
      .from(categoryFieldSchemas)
      .where(
        and(
          eq(categoryFieldSchemas.categoryId, categoryId),
          eq(categoryFieldSchemas.statusCode, status),
        ),
      )
      .limit(1);
    return row;
  }

  /** Current versions of several categories in one query, keyed by category id. */
  async publishedSchemas(
    tx: DatabaseTransaction,
    categoryIds: readonly string[],
  ): Promise<Map<string, FieldSchemaRow>> {
    if (categoryIds.length === 0) return new Map();
    const rows = await tx
      .select(schemaColumns)
      .from(categoryFieldSchemas)
      .where(
        and(
          inArray(categoryFieldSchemas.categoryId, [...categoryIds]),
          eq(categoryFieldSchemas.statusCode, 'published'),
        ),
      );
    return new Map(rows.map((row) => [row.categoryId, row]));
  }

  async findSchemaById(tx: DatabaseTransaction, id: string): Promise<FieldSchemaRow | undefined> {
    const [row] = await tx
      .select(schemaColumns)
      .from(categoryFieldSchemas)
      .where(eq(categoryFieldSchemas.id, id))
      .limit(1);
    return row;
  }

  listVersions(tx: DatabaseTransaction, categoryId: string): Promise<FieldSchemaRow[]> {
    return tx
      .select(schemaColumns)
      .from(categoryFieldSchemas)
      .where(eq(categoryFieldSchemas.categoryId, categoryId))
      .orderBy(desc(categoryFieldSchemas.version));
  }

  /** Published version per category, for list views. */
  async schemaStateByCategory(
    tx: DatabaseTransaction,
  ): Promise<Map<string, { publishedVersion: number | null; hasDraft: boolean }>> {
    const rows = await tx
      .select({
        categoryId: categoryFieldSchemas.categoryId,
        status: categoryFieldSchemas.statusCode,
        version: categoryFieldSchemas.version,
      })
      .from(categoryFieldSchemas)
      .where(inArray(categoryFieldSchemas.statusCode, ['draft', 'published']));
    const state = new Map<string, { publishedVersion: number | null; hasDraft: boolean }>();
    for (const row of rows) {
      const entry = state.get(row.categoryId) ?? { publishedVersion: null, hasDraft: false };
      if (row.status === 'published') entry.publishedVersion = row.version;
      else entry.hasDraft = true;
      state.set(row.categoryId, entry);
    }
    return state;
  }

  /**
   * One past the highest version. `excludeDrafts` is for publishing the open
   * draft itself: it takes the number after the last *published* version, so
   * versions stay in publish order even if a parent republished this category
   * while the draft was open.
   */
  async nextVersion(
    tx: DatabaseTransaction,
    categoryId: string,
    options: { excludeDrafts?: boolean } = {},
  ): Promise<number> {
    const [row] = await tx
      .select({ latest: max(categoryFieldSchemas.version) })
      .from(categoryFieldSchemas)
      .where(
        and(
          eq(categoryFieldSchemas.categoryId, categoryId),
          options.excludeDrafts ? ne(categoryFieldSchemas.statusCode, 'draft') : undefined,
        ),
      );
    return (row?.latest ?? 0) + 1;
  }

  async insertSchema(
    tx: DatabaseTransaction,
    categoryId: string,
    version: number,
    content: FieldSchemaContent,
    publishedByUserId: string | null,
  ): Promise<string> {
    const published = publishedByUserId !== null;
    const [row] = await tx
      .insert(categoryFieldSchemas)
      .values({
        categoryId,
        version,
        ...content,
        statusCode: published ? 'published' : 'draft',
        publishedAt: published ? sql`now()` : null,
        publishedByUserId,
      })
      .returning({ id: categoryFieldSchemas.id });
    return row!.id;
  }

  async updateDraft(
    tx: DatabaseTransaction,
    id: string,
    content: FieldSchemaContent,
  ): Promise<void> {
    await tx
      .update(categoryFieldSchemas)
      .set(content)
      .where(and(eq(categoryFieldSchemas.id, id), eq(categoryFieldSchemas.statusCode, 'draft')));
  }

  async deleteDraft(tx: DatabaseTransaction, id: string): Promise<void> {
    await tx
      .delete(categoryFieldSchemas)
      .where(and(eq(categoryFieldSchemas.id, id), eq(categoryFieldSchemas.statusCode, 'draft')));
  }

  /** The only change a published row allows (0018 trigger). */
  async retire(tx: DatabaseTransaction, id: string): Promise<void> {
    await tx
      .update(categoryFieldSchemas)
      .set({ statusCode: 'retired' })
      .where(
        and(eq(categoryFieldSchemas.id, id), eq(categoryFieldSchemas.statusCode, 'published')),
      );
  }

  /** Publishes the (already re-flattened) draft content in place. */
  async publishDraft(
    tx: DatabaseTransaction,
    id: string,
    version: number,
    content: FieldSchemaContent,
    publishedByUserId: string,
  ): Promise<void> {
    await tx
      .update(categoryFieldSchemas)
      .set({
        ...content,
        version,
        statusCode: 'published',
        publishedAt: sql`now()`,
        publishedByUserId,
      })
      .where(and(eq(categoryFieldSchemas.id, id), eq(categoryFieldSchemas.statusCode, 'draft')));
  }

  // ---- tenant categories -------------------------------------------------------

  listTenantRows(tx: DatabaseTransaction, tenantId: string): Promise<TenantCategoryRow[]> {
    return tx
      .select({
        categoryId: tenantCategories.categoryId,
        isEnabled: tenantCategories.isEnabled,
        sortOrder: tenantCategories.sortOrder,
        postCostCredits: tenantCategories.postCostCredits,
        postExpiryDays: tenantCategories.postExpiryDays,
        moderationModeCode: tenantCategories.moderationModeCode,
      })
      .from(tenantCategories)
      .where(eq(tenantCategories.tenantId, tenantId))
      .orderBy(asc(tenantCategories.sortOrder));
  }

  async upsertTenantRow(
    tx: DatabaseTransaction,
    tenantId: string,
    categoryId: string,
    values: Omit<TenantCategoryRow, 'categoryId'>,
  ): Promise<void> {
    await tx
      .insert(tenantCategories)
      .values({ tenantId, categoryId, ...values })
      .onConflictDoUpdate({
        target: [tenantCategories.tenantId, tenantCategories.categoryId],
        set: values,
      });
  }

  async setTenantSortOrder(
    tx: DatabaseTransaction,
    tenantId: string,
    categoryId: string,
    sortOrder: number,
  ): Promise<void> {
    await tx
      .update(tenantCategories)
      .set({ sortOrder })
      .where(
        and(eq(tenantCategories.tenantId, tenantId), eq(tenantCategories.categoryId, categoryId)),
      );
  }

  async tenantTimeZone(tx: DatabaseTransaction, tenantId: string): Promise<string | undefined> {
    const [row] = await tx
      .select({ timezone: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    return row?.timezone;
  }

  /** The tenant-wide default (`post` unless the partner chose pre-moderation). */
  async tenantModerationMode(
    tx: DatabaseTransaction,
    tenantId: string,
  ): Promise<string | undefined> {
    const [row] = await tx
      .select({ mode: tenantSettings.postModerationModeCode })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId))
      .limit(1);
    return row?.mode;
  }
}
