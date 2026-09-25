import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '../database/database.client';
import { TenantContext, type TenantContextStore } from '../database/tenant-context';
import type { TenantDb } from '../database/tenant-db';
import type {
  CategoriesRepository,
  CategoryChanges,
  CategoryRow,
  FieldSchemaContent,
  FieldSchemaRow,
  NewCategory,
  TenantCategoryRow,
} from './categories.repository';

/**
 * In-memory stand-ins for unit tests: a repository with the same contract as
 * CategoriesRepository, and a TenantDb whose "transaction" rolls the fake
 * back on error, like Postgres would. The database rules themselves (RLS,
 * triggers) are covered by test/category-engine*.db-spec.ts.
 */

interface State {
  categories: CategoryRow[];
  schemas: FieldSchemaRow[];
  tenantRows: Map<string, TenantCategoryRow[]>;
}

export class FakeCategoriesRepository {
  state: State = { categories: [], schemas: [], tenantRows: new Map() };
  timeZone = 'Asia/Dhaka';
  moderationMode = 'post';

  snapshot(): State {
    return structuredClone(this.state);
  }

  restore(state: State): void {
    this.state = state;
  }

  // ---- fixtures ----------------------------------------------------------------

  addCategory(overrides: Partial<CategoryRow> & Pick<CategoryRow, 'slug'>): CategoryRow {
    const parent = this.state.categories.find((c) => c.id === overrides.parentId);
    const row: CategoryRow = {
      id: randomUUID(),
      parentId: null,
      kind: 'marketplace',
      moduleCode: null,
      nameBn: overrides.slug,
      nameEn: overrides.slug,
      descriptionBn: null,
      descriptionEn: null,
      iconKey: null,
      depth: parent ? parent.depth + 1 : 0,
      sortOrder: 0,
      monetizationMode: 'free',
      postCostCredits: 0,
      postExpiryDays: null,
      moderationModeCode: null,
      isActive: true,
      ...overrides,
    };
    this.state.categories.push(row);
    return row;
  }

  enable(tenantId: string, categoryId: string, extra: Partial<TenantCategoryRow> = {}): void {
    const rows = this.state.tenantRows.get(tenantId) ?? [];
    rows.push({
      categoryId,
      isEnabled: true,
      sortOrder: rows.length + 1,
      postCostCredits: null,
      postExpiryDays: null,
      moderationModeCode: null,
      ...extra,
    });
    this.state.tenantRows.set(tenantId, rows);
  }

  schemasOf(categoryId: string): FieldSchemaRow[] {
    return this.state.schemas
      .filter((s) => s.categoryId === categoryId)
      .sort((a, b) => a.version - b.version);
  }

  // ---- CategoriesRepository contract -----------------------------------------
  // Synchronous work wrapped in promises: same contract as the real repository,
  // including a rejected promise (never a throw) when a database rule would fail.

  listAll(): Promise<CategoryRow[]> {
    return Promise.resolve(this.state.categories);
  }

  findById(_tx: unknown, id: string): Promise<CategoryRow | undefined> {
    return Promise.resolve(this.state.categories.find((c) => c.id === id));
  }

  insert(_tx: unknown, category: NewCategory): Promise<string> {
    return Promise.resolve(this.addCategory(category).id);
  }

  update(_tx: unknown, id: string, changes: CategoryChanges): Promise<void> {
    const row = this.state.categories.find((c) => c.id === id)!;
    for (const [key, value] of Object.entries(changes)) {
      if (value !== undefined) Object.assign(row, { [key]: value });
    }
    return Promise.resolve();
  }

  softDelete(_tx: unknown, id: string): Promise<void> {
    this.state.categories = this.state.categories.filter((c) => c.id !== id);
    return Promise.resolve();
  }

  childIds(_tx: unknown, parentId: string): Promise<string[]> {
    return Promise.resolve(
      this.state.categories.filter((c) => c.parentId === parentId).map((c) => c.id),
    );
  }

  findSchema(
    _tx: unknown,
    categoryId: string,
    status: 'draft' | 'published',
  ): Promise<FieldSchemaRow | undefined> {
    return Promise.resolve(
      this.state.schemas.find((s) => s.categoryId === categoryId && s.status === status),
    );
  }

  publishedSchemas(_tx: unknown, ids: readonly string[]): Promise<Map<string, FieldSchemaRow>> {
    return Promise.resolve(
      new Map(
        this.state.schemas
          .filter((s) => ids.includes(s.categoryId) && s.status === 'published')
          .map((s) => [s.categoryId, s]),
      ),
    );
  }

  findSchemaById(_tx: unknown, id: string): Promise<FieldSchemaRow | undefined> {
    return Promise.resolve(this.state.schemas.find((s) => s.id === id));
  }

  listVersions(_tx: unknown, categoryId: string): Promise<FieldSchemaRow[]> {
    return Promise.resolve(this.schemasOf(categoryId).reverse());
  }

  schemaStateByCategory(): Promise<
    Map<string, { publishedVersion: number | null; hasDraft: boolean }>
  > {
    const state = new Map<string, { publishedVersion: number | null; hasDraft: boolean }>();
    for (const s of this.state.schemas) {
      const entry = state.get(s.categoryId) ?? { publishedVersion: null, hasDraft: false };
      if (s.status === 'published') entry.publishedVersion = s.version;
      if (s.status === 'draft') entry.hasDraft = true;
      state.set(s.categoryId, entry);
    }
    return Promise.resolve(state);
  }

  nextVersion(
    _tx: unknown,
    categoryId: string,
    options: { excludeDrafts?: boolean } = {},
  ): Promise<number> {
    const versions = this.schemasOf(categoryId)
      .filter((s) => !options.excludeDrafts || s.status !== 'draft')
      .map((s) => s.version);
    return Promise.resolve(Math.max(0, ...versions) + 1);
  }

  insertSchema(
    _tx: unknown,
    categoryId: string,
    version: number,
    content: FieldSchemaContent,
    publishedByUserId: string | null,
  ): Promise<string> {
    const published = publishedByUserId !== null;
    if (published && this.hasPublished(categoryId)) return Promise.reject(twoPublished());
    const id = randomUUID();
    this.state.schemas.push({
      id,
      categoryId,
      version,
      status: published ? 'published' : 'draft',
      ...content,
      publishedAt: published ? new Date() : null,
    });
    return Promise.resolve(id);
  }

  updateDraft(_tx: unknown, id: string, content: FieldSchemaContent): Promise<void> {
    Object.assign(
      this.state.schemas.find((s) => s.id === id && s.status === 'draft')!,
      content,
    );
    return Promise.resolve();
  }

  deleteDraft(_tx: unknown, id: string): Promise<void> {
    this.state.schemas = this.state.schemas.filter((s) => !(s.id === id && s.status === 'draft'));
    return Promise.resolve();
  }

  retire(_tx: unknown, id: string): Promise<void> {
    const row = this.state.schemas.find((s) => s.id === id)!;
    if (row.status !== 'published') {
      return Promise.reject(new Error('fake: only a published version retires'));
    }
    row.status = 'retired';
    return Promise.resolve();
  }

  publishDraft(
    _tx: unknown,
    id: string,
    version: number,
    content: FieldSchemaContent,
  ): Promise<void> {
    const row = this.state.schemas.find((s) => s.id === id && s.status === 'draft')!;
    if (this.hasPublished(row.categoryId)) return Promise.reject(twoPublished());
    Object.assign(row, content, { version, status: 'published', publishedAt: new Date() });
    return Promise.resolve();
  }

  listTenantRows(_tx: unknown, tenantId: string): Promise<TenantCategoryRow[]> {
    return Promise.resolve(
      [...(this.state.tenantRows.get(tenantId) ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    );
  }

  upsertTenantRow(
    _tx: unknown,
    tenantId: string,
    categoryId: string,
    values: Omit<TenantCategoryRow, 'categoryId'>,
  ): Promise<void> {
    const rows = (this.state.tenantRows.get(tenantId) ?? []).filter(
      (r) => r.categoryId !== categoryId,
    );
    rows.push({ categoryId, ...values });
    this.state.tenantRows.set(tenantId, rows);
    return Promise.resolve();
  }

  setTenantSortOrder(
    _tx: unknown,
    tenantId: string,
    categoryId: string,
    sortOrder: number,
  ): Promise<void> {
    this.state.tenantRows.get(tenantId)!.find((r) => r.categoryId === categoryId)!.sortOrder =
      sortOrder;
    return Promise.resolve();
  }

  tenantTimeZone(): Promise<string> {
    return Promise.resolve(this.timeZone);
  }

  tenantModerationMode(): Promise<string> {
    return Promise.resolve(this.moderationMode);
  }

  private hasPublished(categoryId: string): boolean {
    return this.state.schemas.some((s) => s.categoryId === categoryId && s.status === 'published');
  }

  asRepository(): CategoriesRepository {
    return this;
  }
}

function twoPublished(): Error {
  return new Error('fake: two published versions (category_field_schemas_published_uq)');
}

/** A TenantDb whose transactions roll the fake repository back on error. */
export function fakeTenantDb(repo: FakeCategoriesRepository): TenantDb {
  return {
    async transaction<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
      const before = repo.snapshot();
      try {
        return await work({} as DatabaseTransaction);
      } catch (error) {
        repo.restore(before);
        throw error;
      }
    },
  } as unknown as TenantDb;
}

/** A TenantContext that always returns `store`, without AsyncLocalStorage. */
export function fixedTenantContext(store: TenantContextStore): TenantContext {
  const context = new TenantContext();
  jest.spyOn(context, 'current').mockReturnValue(store);
  jest.spyOn(context, 'require').mockReturnValue(store);
  return context;
}
