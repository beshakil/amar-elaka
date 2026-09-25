import { Injectable } from '@nestjs/common';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import {
  CategoryHasNoFieldSchemaException,
  CategoryNotFoundException,
  FieldSchemaDraftNotFoundException,
  FieldSchemaNotFoundException,
  ParentSchemaNotPublishedException,
} from './categories.exceptions';
import {
  CategoriesRepository,
  type CategoryRow,
  type FieldSchemaContent,
  type FieldSchemaRow,
} from './categories.repository';
import { KINDS_WITH_FIELDS } from './categories.types';
import type { FieldSchemaVersion, FieldSchemaVersionSummary } from './dto/category-responses.dto';
import {
  checkPublishable,
  parseFieldDefinition,
  resolveFieldDefinition,
  type CategoryFieldDefinition,
} from './field-schema';

/**
 * Field-schema versioning (categories.md §3.5–3.6, schema.md §13.13).
 *
 *   - Admins edit one draft per category: the category's *own* fields
 *     (`authored_definition`). The stored json_schema/ui_schema are the
 *     resolved form: parent fields merged in, exactly what posts validate
 *     against.
 *   - Publishing is one transaction under a lock on the category row: the
 *     draft is re-resolved against the parent's current version, checked,
 *     the old version is retired (0018 allows only that change), and the
 *     draft becomes the published version.
 *   - Posts pin `field_schema_id`, and published/retired rows never change,
 *     so a post written under v1 keeps validating and rendering against v1
 *     after v2 adds or removes fields.
 *   - A child's resolved schema embeds its parent's fields, so publishing a
 *     parent republishes every descendant from its own authored definition,
 *     in the same transaction. If a child's narrowing no longer fits, the
 *     whole publish fails and nothing changes.
 */

export function toVersion(row: FieldSchemaRow): FieldSchemaVersion {
  return {
    id: row.id,
    categoryId: row.categoryId,
    version: row.version,
    status: row.status,
    jsonSchema: row.jsonSchema,
    uiSchema: row.uiSchema,
    filterableFields: row.filterableFields,
    searchableFields: row.searchableFields,
    publishedAt: row.publishedAt?.toISOString() ?? null,
  };
}

function toContent(
  authored: CategoryFieldDefinition,
  resolved: CategoryFieldDefinition,
): FieldSchemaContent {
  return {
    jsonSchema: { ...resolved.jsonSchema },
    uiSchema: { ...resolved.uiSchema },
    filterableFields: resolved.filterableFields,
    searchableFields: resolved.searchableFields,
    analyticsFields: resolved.analyticsFields,
    authoredDefinition: { ...authored },
  };
}

@Injectable()
export class FieldSchemaVersionsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly repo: CategoriesRepository,
    private readonly tenantContext: TenantContext,
  ) {}

  listVersions(categoryId: string): Promise<FieldSchemaVersionSummary[]> {
    return this.tenantDb.transaction(
      async (tx) => {
        await this.requireCategory(tx, categoryId);
        const rows = await this.repo.listVersions(tx, categoryId);
        return rows.map(({ id, version, status, publishedAt }) => ({
          id,
          version,
          status,
          publishedAt: publishedAt?.toISOString() ?? null,
        }));
      },
      { accessMode: 'read only' },
    );
  }

  /** Any version, drafts included, for the platform admin UI. */
  getVersion(schemaId: string): Promise<FieldSchemaVersion> {
    return this.tenantDb.transaction(
      async (tx) => {
        const row = await this.repo.findSchemaById(tx, schemaId);
        if (!row) throw new FieldSchemaNotFoundException();
        return toVersion(row);
      },
      { accessMode: 'read only' },
    );
  }

  /** Creates the draft, or replaces the open draft's content. */
  saveDraft(categoryId: string, authoredInput: unknown): Promise<FieldSchemaVersion> {
    return this.tenantDb.transaction(async (tx) => {
      const category = await this.requireCategoryWithFields(tx, categoryId, { lock: true });
      const authored = parseFieldDefinition(authoredInput);
      // Resolving now gives the admin every problem before publish time.
      const resolved = await this.resolve(tx, category, authored);
      const content = toContent(authored, resolved);

      const draft = await this.repo.findSchema(tx, categoryId, 'draft');
      if (draft) {
        await this.repo.updateDraft(tx, draft.id, content);
        return toVersion({ ...draft, ...content });
      }
      const version = await this.repo.nextVersion(tx, categoryId);
      const id = await this.repo.insertSchema(tx, categoryId, version, content, null);
      return toVersion((await this.repo.findSchemaById(tx, id))!);
    });
  }

  discardDraft(categoryId: string): Promise<void> {
    return this.tenantDb.transaction(async (tx) => {
      await this.requireCategoryWithFields(tx, categoryId, { lock: true });
      const draft = await this.repo.findSchema(tx, categoryId, 'draft');
      if (!draft) throw new FieldSchemaDraftNotFoundException();
      await this.repo.deleteDraft(tx, draft.id);
    });
  }

  publishDraft(categoryId: string): Promise<FieldSchemaVersion> {
    const userId = this.tenantContext.require().userId!;
    return this.tenantDb.transaction(async (tx) => {
      const category = await this.requireCategoryWithFields(tx, categoryId, { lock: true });
      const draft = await this.repo.findSchema(tx, categoryId, 'draft');
      if (!draft) throw new FieldSchemaDraftNotFoundException();

      // The parent may have published since the draft was saved.
      const authored = parseFieldDefinition(draft.authoredDefinition);
      const resolved = await this.resolve(tx, category, authored);

      const current = await this.repo.findSchema(tx, categoryId, 'published');
      if (current) await this.repo.retire(tx, current.id);
      await this.repo.publishDraft(
        tx,
        draft.id,
        await this.repo.nextVersion(tx, categoryId, { excludeDrafts: true }),
        toContent(authored, resolved),
        userId,
      );
      await this.republishDescendants(tx, categoryId, userId);
      return toVersion((await this.repo.findSchemaById(tx, draft.id))!);
    });
  }

  /**
   * Re-resolves and republishes a category (and its descendants) after its
   * parent changed: a new parent schema version, or a move to another parent.
   * A category without a published schema has nothing to republish.
   */
  async republish(tx: DatabaseTransaction, categoryId: string, userId: string): Promise<void> {
    const category = await this.repo.findById(tx, categoryId, { lock: true });
    if (!category || !KINDS_WITH_FIELDS.has(category.kind)) return;
    const current = await this.repo.findSchema(tx, categoryId, 'published');
    if (!current) return;

    const authored = parseFieldDefinition(current.authoredDefinition);
    const resolved = await this.resolve(tx, category, authored);
    await this.repo.retire(tx, current.id);
    const version = await this.repo.nextVersion(tx, categoryId);
    await this.repo.insertSchema(tx, categoryId, version, toContent(authored, resolved), userId);
    await this.republishDescendants(tx, categoryId, userId);
  }

  private async republishDescendants(
    tx: DatabaseTransaction,
    parentId: string,
    userId: string,
  ): Promise<void> {
    for (const childId of await this.repo.childIds(tx, parentId)) {
      await this.republish(tx, childId, userId);
    }
  }

  /** The definition as posts will see it: authored, flattened into the parent's current version. */
  private async resolve(
    tx: DatabaseTransaction,
    category: CategoryRow,
    authored: CategoryFieldDefinition,
  ): Promise<CategoryFieldDefinition> {
    let parentResolved: CategoryFieldDefinition | undefined;
    if (category.parentId !== null) {
      const parentSchema = await this.repo.findSchema(tx, category.parentId, 'published');
      if (!parentSchema) throw new ParentSchemaNotPublishedException();
      parentResolved = parseFieldDefinition({
        jsonSchema: parentSchema.jsonSchema,
        uiSchema: parentSchema.uiSchema,
        filterableFields: parentSchema.filterableFields,
        searchableFields: parentSchema.searchableFields,
        analyticsFields: parentSchema.analyticsFields,
      });
    }
    return checkPublishable(resolveFieldDefinition(authored, parentResolved));
  }

  private async requireCategory(tx: DatabaseTransaction, categoryId: string): Promise<CategoryRow> {
    const category = await this.repo.findById(tx, categoryId);
    if (!category) throw new CategoryNotFoundException();
    return category;
  }

  private async requireCategoryWithFields(
    tx: DatabaseTransaction,
    categoryId: string,
    options: { lock: boolean },
  ): Promise<CategoryRow> {
    const category = await this.repo.findById(tx, categoryId, options);
    if (!category) throw new CategoryNotFoundException();
    if (!KINDS_WITH_FIELDS.has(category.kind)) throw new CategoryHasNoFieldSchemaException();
    return category;
  }
}
