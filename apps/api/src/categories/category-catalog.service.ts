import { Injectable } from '@nestjs/common';
import { TenantContext } from '../database/tenant-context';
import { TenantRequiredException } from '../database/tenant.exceptions';
import { TenantDb } from '../database/tenant-db';
import { SettingsService } from '../settings/settings.service';
import { FieldSchemaNotFoundException } from './categories.exceptions';
import { CategoriesRepository, type CategoryRow } from './categories.repository';
import { POSTABLE_KINDS } from './categories.types';
import type { CatalogCategory, FieldSchemaVersion } from './dto/category-responses.dto';
import { toVersion } from './field-schema-versions.service';

/**
 * What a tenant's users see (GET /categories): the categories enabled in this
 * tenant, in the tenant's order, each with the current field-schema version
 * a new post will pin. A child is listed only while its parent is too, so
 * the client can always build the tree from `parentId`.
 */
@Injectable()
export class CategoryCatalogService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly repo: CategoriesRepository,
    private readonly settings: SettingsService,
    private readonly tenantContext: TenantContext,
  ) {}

  async listForTenant(): Promise<CatalogCategory[]> {
    const tenantId = this.tenantContext.require().tenantId;
    if (!tenantId) throw new TenantRequiredException();
    const defaultExpiryDays = await this.settings.get('post_expiry_days_default', tenantId);

    return this.tenantDb.transaction(
      async (tx) => {
        const byId = new Map(
          (await this.repo.listAll(tx)).filter((c) => c.isActive).map((c) => [c.id, c]),
        );
        const rows = (await this.repo.listTenantRows(tx, tenantId)).filter(
          (row) => row.isEnabled && byId.has(row.categoryId),
        );
        const tenantMode = await this.repo.tenantModerationMode(tx, tenantId);
        const enabled = new Set(rows.map((row) => row.categoryId));
        const visible = (category: CategoryRow): boolean =>
          category.parentId === null ||
          (enabled.has(category.parentId) && visible(byId.get(category.parentId)!));

        const shown = rows.filter((row) => visible(byId.get(row.categoryId)!));
        const schemas = await this.repo.publishedSchemas(
          tx,
          shown.map((row) => row.categoryId),
        );

        const result: CatalogCategory[] = [];
        for (const row of shown) {
          const category = byId.get(row.categoryId)!;
          const schema = schemas.get(category.id);
          const postable = POSTABLE_KINDS.has(category.kind);
          // Stricter wins: a category marked pre can't be loosened (0004 trigger).
          const moderation =
            category.moderationModeCode === 'pre' ? 'pre' : (row.moderationModeCode ?? tenantMode);
          result.push({
            id: category.id,
            parentId: category.parentId,
            slug: category.slug,
            kind: category.kind,
            moduleCode: category.moduleCode,
            name: { bn: category.nameBn, en: category.nameEn },
            description: { bn: category.descriptionBn, en: category.descriptionEn },
            iconKey: category.iconKey,
            postCostCredits: postable ? (row.postCostCredits ?? category.postCostCredits) : 0,
            postExpiryDays: postable
              ? (row.postExpiryDays ?? category.postExpiryDays ?? defaultExpiryDays)
              : null,
            requiresApproval: moderation === 'pre',
            fieldSchema: schema
              ? (({ categoryId: _c, status: _s, ...rest }) => rest)(toVersion(schema))
              : null,
          });
        }
        return result;
      },
      { accessMode: 'read only' },
    );
  }

  /**
   * One version by id, current or retired: how a client renders an existing
   * post against the version it pinned. Drafts are never public.
   */
  getSchema(schemaId: string): Promise<FieldSchemaVersion> {
    return this.tenantDb.transaction(
      async (tx) => {
        const row = await this.repo.findSchemaById(tx, schemaId);
        if (!row || row.status === 'draft') throw new FieldSchemaNotFoundException();
        return toVersion(row);
      },
      { accessMode: 'read only' },
    );
  }
}
