import { Injectable } from '@nestjs/common';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import {
  CategoryHasChildrenException,
  CategoryNotFoundException,
  CategoryRuleViolationException,
} from './categories.exceptions';
import { CategoriesRepository, type CategoryRow } from './categories.repository';
import { categoryShapeIssues, mapCategoryWriteError } from './category-rules';
import type { CreateCategoryInput, UpdateCategoryInput } from './dto/category-requests.dto';
import type { PlatformCategory } from './dto/category-responses.dto';
import { FieldSchemaVersionsService } from './field-schema-versions.service';

/**
 * Platform-admin CRUD over the global taxonomy (categories.md, schema.md §3.3).
 * Kind, module and slug are fixed at creation; everything else is editable.
 * Deleting is a soft delete: posts and places keep their category and
 * pinned schema version.
 */
@Injectable()
export class PlatformCategoriesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly repo: CategoriesRepository,
    private readonly versions: FieldSchemaVersionsService,
    private readonly tenantContext: TenantContext,
  ) {}

  list(): Promise<PlatformCategory[]> {
    return this.tenantDb.transaction(
      async (tx) => {
        const [rows, schemaState] = [
          await this.repo.listAll(tx),
          await this.repo.schemaStateByCategory(tx),
        ];
        return rows.map((row) => toPlatformCategory(row, schemaState.get(row.id)));
      },
      { accessMode: 'read only' },
    );
  }

  get(categoryId: string): Promise<PlatformCategory> {
    return this.tenantDb.transaction(async (tx) => this.load(tx, categoryId), {
      accessMode: 'read only',
    });
  }

  async create(input: CreateCategoryInput): Promise<PlatformCategory> {
    try {
      return await this.tenantDb.transaction(async (tx) => {
        const parent = input.parentId ? await this.repo.findById(tx, input.parentId) : undefined;
        const issues = categoryShapeIssues(input, parent, []);
        if (issues.length > 0) throw new CategoryRuleViolationException(issues);

        const id = await this.repo.insert(tx, {
          ...input,
          moderationModeCode: input.requiresApproval ? 'pre' : null,
        });
        return this.load(tx, id);
      });
    } catch (error) {
      throw mapCategoryWriteError(error);
    }
  }

  async update(categoryId: string, changes: UpdateCategoryInput): Promise<PlatformCategory> {
    const userId = this.tenantContext.require().userId!;
    try {
      return await this.tenantDb.transaction(async (tx) => {
        const current = await this.repo.findById(tx, categoryId, { lock: true });
        if (!current) throw new CategoryNotFoundException();

        const next = {
          id: current.id,
          kind: current.kind,
          moduleCode: current.moduleCode,
          parentId: changes.parentId !== undefined ? changes.parentId : current.parentId,
          postCostCredits: changes.postCostCredits ?? current.postCostCredits,
          postExpiryDays:
            changes.postExpiryDays !== undefined ? changes.postExpiryDays : current.postExpiryDays,
        };
        const parent = next.parentId ? await this.repo.findById(tx, next.parentId) : undefined;
        const ancestors = parent ? await this.ancestorIds(tx, parent) : [];
        const issues = categoryShapeIssues(next, parent, ancestors);
        if (issues.length > 0) throw new CategoryRuleViolationException(issues);

        const { requiresApproval, ...rest } = changes;
        await this.repo.update(tx, categoryId, {
          ...rest,
          ...(requiresApproval !== undefined
            ? { moderationModeCode: requiresApproval ? 'pre' : null }
            : {}),
        });

        // A moved category inherits different fields: re-resolve its schema (and its children's).
        if (next.parentId !== current.parentId)
          await this.versions.republish(tx, categoryId, userId);
        return this.load(tx, categoryId);
      });
    } catch (error) {
      throw mapCategoryWriteError(error);
    }
  }

  remove(categoryId: string): Promise<void> {
    return this.tenantDb.transaction(async (tx) => {
      const current = await this.repo.findById(tx, categoryId, { lock: true });
      if (!current) throw new CategoryNotFoundException();
      if ((await this.repo.childIds(tx, categoryId)).length > 0) {
        throw new CategoryHasChildrenException();
      }
      await this.repo.softDelete(tx, categoryId);
    });
  }

  private async load(tx: DatabaseTransaction, categoryId: string): Promise<PlatformCategory> {
    const row = await this.repo.findById(tx, categoryId);
    if (!row) throw new CategoryNotFoundException();
    const state = (await this.repo.schemaStateByCategory(tx)).get(categoryId);
    return toPlatformCategory(row, state);
  }

  /** The parent chain, nearest first; categories are at most a few levels deep (depth ≤ 3). */
  private async ancestorIds(tx: DatabaseTransaction, start: CategoryRow): Promise<string[]> {
    const ids = [start.id];
    for (let row: CategoryRow | undefined = start; row?.parentId;) {
      if (ids.includes(row.parentId)) break;
      ids.push(row.parentId);
      row = await this.repo.findById(tx, row.parentId);
    }
    return ids;
  }
}

function toPlatformCategory(
  row: CategoryRow,
  state: { publishedVersion: number | null; hasDraft: boolean } | undefined,
): PlatformCategory {
  return {
    id: row.id,
    parentId: row.parentId,
    kind: row.kind,
    moduleCode: row.moduleCode,
    slug: row.slug,
    nameBn: row.nameBn,
    nameEn: row.nameEn,
    descriptionBn: row.descriptionBn,
    descriptionEn: row.descriptionEn,
    iconKey: row.iconKey,
    depth: row.depth,
    sortOrder: row.sortOrder,
    monetizationMode: row.monetizationMode,
    postCostCredits: row.postCostCredits,
    postExpiryDays: row.postExpiryDays,
    requiresApproval: row.moderationModeCode === 'pre',
    isActive: row.isActive,
    publishedSchemaVersion: state?.publishedVersion ?? null,
    hasDraft: state?.hasDraft ?? false,
  };
}
