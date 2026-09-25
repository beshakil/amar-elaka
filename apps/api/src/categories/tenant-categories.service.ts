import { Injectable } from '@nestjs/common';
import { TenantContext } from '../database/tenant-context';
import { TenantRequiredException } from '../database/tenant.exceptions';
import { TenantDb } from '../database/tenant-db';
import { CategoryNotFoundException, CategoryRuleViolationException } from './categories.exceptions';
import { CategoriesRepository, type TenantCategoryRow } from './categories.repository';
import { POSTABLE_KINDS } from './categories.types';
import { CATEGORY_ISSUES, mapCategoryWriteError } from './category-rules';
import type { UpdateTenantCategoryInput } from './dto/category-requests.dto';
import type { TenantCategorySetting } from './dto/category-responses.dto';

/**
 * A tenant admin's view of the taxonomy (schema.md §3.5): enable or disable
 * a category, override its post cost / expiry / approval, and order the
 * home grid. RLS confines every row to the caller's tenant; no row means
 * "disabled here".
 */
@Injectable()
export class TenantCategoriesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly repo: CategoriesRepository,
    private readonly tenantContext: TenantContext,
  ) {}

  list(): Promise<TenantCategorySetting[]> {
    const tenantId = this.requireTenantId();
    return this.tenantDb.transaction(
      async (tx) => {
        const categories = (await this.repo.listAll(tx)).filter((c) => c.isActive);
        const rows = new Map(
          (await this.repo.listTenantRows(tx, tenantId)).map((row) => [row.categoryId, row]),
        );
        const settings = categories.map((category) => {
          const row = rows.get(category.id);
          return {
            categoryId: category.id,
            parentId: category.parentId,
            slug: category.slug,
            kind: category.kind,
            nameBn: category.nameBn,
            nameEn: category.nameEn,
            isEnabled: row?.isEnabled ?? false,
            sortOrder: row?.sortOrder ?? null,
            postCostCredits: row?.postCostCredits ?? null,
            postExpiryDays: row?.postExpiryDays ?? null,
            requiresApproval:
              row?.moderationModeCode == null ? null : row.moderationModeCode === 'pre',
            defaults: {
              postCostCredits: category.postCostCredits,
              postExpiryDays: category.postExpiryDays,
              requiresApproval: category.moderationModeCode === 'pre',
            },
          };
        });
        // The tenant's order first, then categories it hasn't placed yet.
        return settings.sort(
          (a, b) =>
            (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER),
        );
      },
      { accessMode: 'read only' },
    );
  }

  async update(categoryId: string, changes: UpdateTenantCategoryInput): Promise<void> {
    const tenantId = this.requireTenantId();
    try {
      await this.tenantDb.transaction(async (tx) => {
        const category = await this.repo.findById(tx, categoryId);
        if (!category) throw new CategoryNotFoundException();

        const rows = await this.repo.listTenantRows(tx, tenantId);
        const current = rows.find((row) => row.categoryId === categoryId);
        const next: Omit<TenantCategoryRow, 'categoryId'> = {
          isEnabled: changes.isEnabled ?? current?.isEnabled ?? true,
          // A newly placed category goes to the end of the grid.
          sortOrder: current?.sortOrder ?? Math.max(0, ...rows.map((row) => row.sortOrder)) + 1,
          postCostCredits:
            changes.postCostCredits !== undefined
              ? changes.postCostCredits
              : (current?.postCostCredits ?? null),
          postExpiryDays:
            changes.postExpiryDays !== undefined
              ? changes.postExpiryDays
              : (current?.postExpiryDays ?? null),
          moderationModeCode:
            changes.requiresApproval !== undefined
              ? changes.requiresApproval === null
                ? null
                : changes.requiresApproval
                  ? 'pre'
                  : 'post'
              : (current?.moderationModeCode ?? null),
        };

        const issues: string[] = [];
        if (next.isEnabled && !category.isActive) issues.push(CATEGORY_ISSUES.inactive);
        if (
          !POSTABLE_KINDS.has(category.kind) &&
          (next.postCostCredits !== null || next.postExpiryDays !== null)
        ) {
          issues.push(CATEGORY_ISSUES.noPostOverrides);
        }
        if (category.moderationModeCode === 'pre' && next.moderationModeCode === 'post') {
          issues.push(CATEGORY_ISSUES.moderationCannotLoosen);
        }
        if (issues.length > 0) throw new CategoryRuleViolationException(issues);

        await this.repo.upsertTenantRow(tx, tenantId, categoryId, next);
      });
    } catch (error) {
      throw mapCategoryWriteError(error);
    }
  }

  /** Listed categories take positions 1..n; the rest keep their relative order after them. */
  reorder(categoryIds: readonly string[]): Promise<void> {
    const tenantId = this.requireTenantId();
    return this.tenantDb.transaction(async (tx) => {
      const rows = await this.repo.listTenantRows(tx, tenantId);
      const known = new Set(rows.map((row) => row.categoryId));
      if (categoryIds.some((id) => !known.has(id))) throw new CategoryNotFoundException();

      const listed = new Set(categoryIds);
      const order = [
        ...categoryIds,
        ...rows.map((r) => r.categoryId).filter((id) => !listed.has(id)),
      ];
      for (const [index, categoryId] of order.entries()) {
        await this.repo.setTenantSortOrder(tx, tenantId, categoryId, index + 1);
      }
    });
  }

  private requireTenantId(): string {
    const tenantId = this.tenantContext.require().tenantId;
    if (!tenantId) throw new TenantRequiredException();
    return tenantId;
  }
}
