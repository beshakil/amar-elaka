import type { SettingsService } from '../settings/settings.service';
import {
  CategoryHasChildrenException,
  CategoryNotFoundException,
  CategoryRuleViolationException,
} from './categories.exceptions';
import {
  FakeCategoriesRepository,
  fakeTenantDb,
  fixedTenantContext,
} from './categories.test-helper';
import { CategoryCatalogService } from './category-catalog.service';
import { CATEGORY_ISSUES } from './category-rules';
import { createCategorySchema } from './dto/category-requests.dto';
import { FieldSchemaVersionsService } from './field-schema-versions.service';
import { PlatformCategoriesService } from './platform-categories.service';
import { TenantCategoriesService } from './tenant-categories.service';

const TENANT = '0191e3a0-6666-7000-8000-0000000000b1';
const ADMIN = '0191e3a0-6666-7000-8000-0000000000b2';
const DEFAULT_EXPIRY_DAYS = 30;

async function issuesOf(promise: Promise<unknown>): Promise<string[]> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof CategoryRuleViolationException)) {
    throw new Error(`expected CategoryRuleViolationException, got ${String(error)}`);
  }
  return error.issues;
}

function platform() {
  const repo = new FakeCategoriesRepository();
  const context = fixedTenantContext({ userId: ADMIN, role: 'platform_admin' });
  const db = fakeTenantDb(repo);
  const versions = new FieldSchemaVersionsService(db, repo.asRepository(), context);
  return {
    repo,
    service: new PlatformCategoriesService(db, repo.asRepository(), versions, context),
  };
}

function tenant() {
  const repo = new FakeCategoriesRepository();
  const context = fixedTenantContext({ tenantId: TENANT, role: 'tenant_admin' });
  return {
    repo,
    service: new TenantCategoriesService(fakeTenantDb(repo), repo.asRepository(), context),
  };
}

describe('PlatformCategoriesService', () => {
  const create = (input: Record<string, unknown>) => createCategorySchema.parse(input);

  it('creates a category with defaults and maps approval to pre-moderation', async () => {
    const { service } = platform();
    const created = await service.create(
      create({
        slug: 'to-let',
        kind: 'rental',
        nameBn: 'টু-লেট',
        nameEn: 'To-Let',
        iconKey: 'key-round',
        monetizationMode: 'per_listing',
        postCostCredits: 2,
        postExpiryDays: 30,
        requiresApproval: true,
      }),
    );
    expect(created).toMatchObject({
      slug: 'to-let',
      kind: 'rental',
      monetizationMode: 'per_listing',
      postCostCredits: 2,
      postExpiryDays: 30,
      requiresApproval: true,
      isActive: true,
      publishedSchemaVersion: null,
      hasDraft: false,
    });
  });

  it('rejects shapes the database would reject, with precise issue codes', async () => {
    const { repo, service } = platform();
    const place = repo.addCategory({ slug: 'shops', kind: 'place' });
    expect(
      await issuesOf(
        service.create(
          create({ slug: 'x', kind: 'module', nameBn: 'x', nameEn: 'x', postCostCredits: 1 }),
        ),
      ),
    ).toEqual([CATEGORY_ISSUES.moduleCodeMismatch, CATEGORY_ISSUES.moduleTileShape]);
    expect(
      await issuesOf(
        service.create(
          create({ slug: 'y', kind: 'place', nameBn: 'y', nameEn: 'y', postExpiryDays: 30 }),
        ),
      ),
    ).toEqual([CATEGORY_ISSUES.expiryNotAllowed]);
    expect(
      await issuesOf(
        service.create(
          create({ slug: 'z', kind: 'rental', nameBn: 'z', nameEn: 'z', parentId: place.id }),
        ),
      ),
    ).toEqual([CATEGORY_ISSUES.parentKindMismatch]);
  });

  it('refuses a parent change that would create a cycle', async () => {
    const { repo, service } = platform();
    const a = repo.addCategory({ slug: 'a' });
    const b = repo.addCategory({ slug: 'b', parentId: a.id });
    const c = repo.addCategory({ slug: 'c', parentId: b.id });
    expect(await issuesOf(service.update(a.id, { parentId: c.id }))).toEqual([
      CATEGORY_ISSUES.parentCycle,
    ]);
    expect(await issuesOf(service.update(a.id, { parentId: a.id }))).toEqual([
      CATEGORY_ISSUES.parentCycle,
    ]);
  });

  it('updates editable fields and refuses to delete a category with children', async () => {
    const { repo, service } = platform();
    const parent = repo.addCategory({ slug: 'buy-sell' });
    repo.addCategory({ slug: 'fashion', parentId: parent.id });
    await expect(
      service.update(parent.id, { iconKey: 'shopping-bag', requiresApproval: true }),
    ).resolves.toMatchObject({ iconKey: 'shopping-bag', requiresApproval: true });
    await expect(service.remove(parent.id)).rejects.toThrow(CategoryHasChildrenException);
    await expect(
      service.update('0191e3a0-6666-7000-8000-00000000dead', { nameEn: 'x' }),
    ).rejects.toThrow(CategoryNotFoundException);
  });
});

describe('TenantCategoriesService', () => {
  it('enables a category at the end of the grid and lists it with its defaults', async () => {
    const { repo, service } = tenant();
    const toLet = repo.addCategory({ slug: 'to-let', kind: 'rental', postCostCredits: 2 });
    const jobs = repo.addCategory({ slug: 'jobs', kind: 'job' });
    repo.enable(TENANT, toLet.id);

    await service.update(jobs.id, { isEnabled: true, postExpiryDays: 14 });
    const list = await service.list();
    expect(list.map((c) => [c.slug, c.isEnabled, c.sortOrder])).toEqual([
      ['to-let', true, 1],
      ['jobs', true, 2],
    ]);
    expect(list[1]).toMatchObject({ postExpiryDays: 14, defaults: { postCostCredits: 0 } });
  });

  it('never loosens a pre-moderated category, and never overrides posting on places', async () => {
    const { repo, service } = tenant();
    const phones = repo.addCategory({ slug: 'phones', moderationModeCode: 'pre' });
    const shops = repo.addCategory({ slug: 'shops', kind: 'place' });
    const hidden = repo.addCategory({ slug: 'hidden', isActive: false });

    expect(await issuesOf(service.update(phones.id, { requiresApproval: false }))).toEqual([
      CATEGORY_ISSUES.moderationCannotLoosen,
    ]);
    expect(await issuesOf(service.update(shops.id, { postCostCredits: 1 }))).toEqual([
      CATEGORY_ISSUES.noPostOverrides,
    ]);
    expect(await issuesOf(service.update(hidden.id, { isEnabled: true }))).toEqual([
      CATEGORY_ISSUES.inactive,
    ]);
    // Stricter is always allowed.
    await expect(service.update(shops.id, { requiresApproval: true })).resolves.toBeUndefined();
  });

  it('reorders: listed categories first, the rest keep their order after them', async () => {
    const { repo, service } = tenant();
    const [a, b, c] = ['a', 'b', 'c'].map((slug) => repo.addCategory({ slug }));
    for (const category of [a!, b!, c!]) repo.enable(TENANT, category.id);

    await service.reorder([c!.id]);
    expect((await service.list()).map((x) => x.slug)).toEqual(['c', 'a', 'b']);
    await expect(service.reorder(['0191e3a0-6666-7000-8000-00000000dead'])).rejects.toThrow(
      CategoryNotFoundException,
    );
  });
});

describe('CategoryCatalogService (GET /categories)', () => {
  function catalog() {
    const repo = new FakeCategoriesRepository();
    const settings = {
      get: () => Promise.resolve(DEFAULT_EXPIRY_DAYS),
    } as unknown as SettingsService;
    const service = new CategoryCatalogService(
      fakeTenantDb(repo),
      repo.asRepository(),
      settings,
      fixedTenantContext({ tenantId: TENANT, role: 'anon' }),
    );
    return { repo, service };
  }

  it("lists enabled categories in the tenant's order, with effective values", async () => {
    const { repo, service } = catalog();
    const toLet = repo.addCategory({ slug: 'to-let', kind: 'rental', postCostCredits: 2 });
    const jobs = repo.addCategory({ slug: 'jobs', kind: 'job', moderationModeCode: 'pre' });
    const shops = repo.addCategory({ slug: 'shops', kind: 'place' });
    const tile = repo.addCategory({ slug: 'emergency', kind: 'module', moduleCode: 'emergency' });
    const off = repo.addCategory({ slug: 'off' });
    repo.enable(TENANT, jobs.id);
    repo.enable(TENANT, toLet.id, { postCostCredits: 1 });
    repo.enable(TENANT, shops.id);
    repo.enable(TENANT, tile.id);
    repo.enable(TENANT, off.id, { isEnabled: false });

    const list = await service.listForTenant();
    expect(
      list.map((c) => [c.slug, c.postCostCredits, c.postExpiryDays, c.requiresApproval]),
    ).toEqual([
      ['jobs', 0, DEFAULT_EXPIRY_DAYS, true],
      ['to-let', 1, DEFAULT_EXPIRY_DAYS, false],
      ['shops', 0, null, false],
      ['emergency', 0, null, false],
    ]);
    expect(list.every((c) => c.fieldSchema === null)).toBe(true);
  });

  it('hides a child whose parent is disabled here', async () => {
    const { repo, service } = catalog();
    const buySell = repo.addCategory({ slug: 'buy-sell' });
    const fashion = repo.addCategory({ slug: 'fashion', parentId: buySell.id });
    repo.enable(TENANT, fashion.id);
    expect(await service.listForTenant()).toEqual([]);

    repo.enable(TENANT, buySell.id);
    expect((await service.listForTenant()).map((c) => c.slug)).toEqual(['fashion', 'buy-sell']);
  });
});
