import {
  CategoryNotFoundException,
  CategoryNotPostableException,
  FieldSchemaNotFoundException,
  FieldValidationException,
  type FieldIssue,
} from './categories.exceptions';
import {
  FakeCategoriesRepository,
  fakeTenantDb,
  fixedTenantContext,
} from './categories.test-helper';
import { FIELD_ISSUES } from './field-schema';
import { FieldValidationService } from './field-validation.service';

const TENANT = '0191e3a0-6666-7000-8000-000000000001';
const OTHER_TENANT = '0191e3a0-6666-7000-8000-000000000002';
// 2026-09-24 10:00 in Dhaka.
const NOW = Date.parse('2026-09-24T04:00:00Z');

const toLetSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    property_type: { 'x-field-type': 'select', type: 'string', enum: ['flat', 'shop'] },
    bedrooms: { 'x-field-type': 'number', type: 'integer', minimum: 0, maximum: 20 },
    price: {
      'x-field-type': 'money',
      type: 'string',
      'x-money-min': '100.00',
      'x-money-max': '10000000.00',
    },
    available_from: {
      'x-field-type': 'date',
      type: 'string',
      format: 'date',
      'x-not-before-today': true,
    },
  },
  required: ['property_type', 'price', 'available_from'],
};

function setup() {
  const repo = new FakeCategoriesRepository();
  const context = fixedTenantContext({ tenantId: TENANT, role: 'member' });
  const service = new FieldValidationService(fakeTenantDb(repo), repo.asRepository(), context, {
    now: () => NOW,
  });
  const toLet = repo.addCategory({ slug: 'to-let', kind: 'rental' });
  repo.enable(TENANT, toLet.id);
  const schemaId = publish(repo, toLet.id, 1, toLetSchema);
  return { repo, service, toLet, schemaId };
}

function publish(
  repo: FakeCategoriesRepository,
  categoryId: string,
  version: number,
  jsonSchema: Record<string, unknown>,
): string {
  const id = `${categoryId}-v${version}`;
  for (const s of repo.state.schemas) {
    if (s.categoryId === categoryId && s.status === 'published') s.status = 'retired';
  }
  repo.state.schemas.push({
    id,
    categoryId,
    version,
    status: 'published',
    jsonSchema,
    uiSchema: {},
    filterableFields: [],
    searchableFields: [],
    analyticsFields: [],
    authoredDefinition: {},
    publishedAt: new Date(NOW),
  });
  return id;
}

async function issuesOf(promise: Promise<unknown>): Promise<FieldIssue[]> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof FieldValidationException)) {
    throw new Error(`expected FieldValidationException, got ${String(error)}`);
  }
  return error.issues;
}

const valid = {
  property_type: 'flat',
  bedrooms: 2,
  price: '15000.00',
  available_from: '2026-10-01',
};

describe('FieldValidationService', () => {
  it('returns normalised values and the version the post must pin', async () => {
    const { service, toLet, schemaId } = setup();
    await expect(service.validate(toLet.id, valid)).resolves.toEqual({
      categoryId: toLet.id,
      fieldSchemaId: schemaId,
      fieldSchemaVersion: 1,
      values: valid,
    });
  });

  it('reports a missing required field', async () => {
    const { service, toLet } = setup();
    const { price: _omitted, ...withoutPrice } = valid;
    expect(await issuesOf(service.validate(toLet.id, withoutPrice))).toEqual([
      { field: 'price', code: FIELD_ISSUES.required },
    ]);
  });

  it('reports a wrong type', async () => {
    const { service, toLet } = setup();
    expect(await issuesOf(service.validate(toLet.id, { ...valid, bedrooms: 'two' }))).toEqual([
      { field: 'bedrooms', code: FIELD_ISSUES.invalid },
    ]);
    // Money is never a JSON number.
    expect(await issuesOf(service.validate(toLet.id, { ...valid, price: 15000 }))).toEqual([
      { field: 'price', code: FIELD_ISSUES.invalid },
    ]);
  });

  it('reports an out-of-range number and amount', async () => {
    const { service, toLet } = setup();
    expect(
      await issuesOf(service.validate(toLet.id, { ...valid, bedrooms: 21, price: '99.99' })),
    ).toEqual([
      { field: 'bedrooms', code: FIELD_ISSUES.outOfRange },
      { field: 'price', code: FIELD_ISSUES.outOfRange },
    ]);
  });

  it('reports an invalid select option', async () => {
    const { service, toLet } = setup();
    expect(
      await issuesOf(service.validate(toLet.id, { ...valid, property_type: 'castle' })),
    ).toEqual([{ field: 'property_type', code: FIELD_ISSUES.notAnOption }]);
  });

  it('reports every unknown key, and a payload that is not an object', async () => {
    const { service, toLet } = setup();
    expect(await issuesOf(service.validate(toLet.id, { ...valid, lift: true, gym: true }))).toEqual(
      [
        { field: 'lift', code: FIELD_ISSUES.notInSchema },
        { field: 'gym', code: FIELD_ISSUES.notInSchema },
      ],
    );
    expect(await issuesOf(service.validate(toLet.id, ['flat']))).toEqual([
      { field: '', code: FIELD_ISSUES.invalid },
    ]);
  });

  it("uses the tenant's calendar day for date rules", async () => {
    const { service, toLet } = setup();
    expect(
      await issuesOf(service.validate(toLet.id, { ...valid, available_from: '2026-09-23' })),
    ).toEqual([{ field: 'available_from', code: FIELD_ISSUES.beforeToday }]);
    await expect(
      service.validate(toLet.id, { ...valid, available_from: '2026-09-24' }),
    ).resolves.toBeDefined();
  });

  describe('which categories accept posts', () => {
    it('rejects an unknown category', async () => {
      const { service } = setup();
      await expect(service.validate('0191e3a0-6666-7000-8000-00000000dead', valid)).rejects.toThrow(
        CategoryNotFoundException,
      );
    });

    it('rejects a category disabled in this tenant, an inactive one, a place and a module', async () => {
      const { repo, service } = setup();
      const elsewhere = repo.addCategory({ slug: 'elsewhere' });
      repo.enable(OTHER_TENANT, elsewhere.id);
      const inactive = repo.addCategory({ slug: 'inactive', isActive: false });
      const place = repo.addCategory({ slug: 'shops', kind: 'place' });
      const tile = repo.addCategory({ slug: 'emergency', kind: 'module', moduleCode: 'emergency' });
      for (const category of [elsewhere, inactive, place, tile]) {
        if (category !== elsewhere) repo.enable(TENANT, category.id);
        publish(repo, category.id, 1, toLetSchema);
        await expect(service.validate(category.id, valid)).rejects.toThrow(
          CategoryNotPostableException,
        );
      }
    });

    it('rejects a category with no published schema', async () => {
      const { repo, service } = setup();
      const bare = repo.addCategory({ slug: 'bare' });
      repo.enable(TENANT, bare.id);
      await expect(service.validate(bare.id, {})).rejects.toThrow(CategoryNotPostableException);
    });
  });

  describe('versioning', () => {
    const v2Schema = {
      ...toLetSchema,
      properties: {
        property_type: toLetSchema.properties.property_type,
        price: toLetSchema.properties.price,
        available_from: toLetSchema.properties.available_from,
        // v2 removes bedrooms and adds a required gas_supply.
        gas_supply: { 'x-field-type': 'select', type: 'string', enum: ['pipeline', 'none'] },
      },
      required: [...toLetSchema.required, 'gas_supply'],
    };

    it('keeps a v1 post valid against v1 after the category moves to v2', async () => {
      const { repo, service, toLet, schemaId: v1 } = setup();
      const v1Post = await service.validate(toLet.id, valid);
      const v2 = publish(repo, toLet.id, 2, v2Schema);

      // The stored v1 post still validates against the version it pinned…
      await expect(service.validateAgainstVersion(v1, v1Post.values)).resolves.toEqual(valid);
      // …while new posts must satisfy v2 and pin it.
      expect(await issuesOf(service.validate(toLet.id, valid))).toEqual([
        { field: 'gas_supply', code: FIELD_ISSUES.required },
        { field: 'bedrooms', code: FIELD_ISSUES.notInSchema },
      ]);
      const { bedrooms: _removed, ...withoutBedrooms } = valid;
      await expect(
        service.validate(toLet.id, { ...withoutBedrooms, gas_supply: 'pipeline' }),
      ).resolves.toMatchObject({ fieldSchemaId: v2, fieldSchemaVersion: 2 });
    });

    it('never validates against a draft', async () => {
      const { repo, service, toLet } = setup();
      repo.state.schemas.push({ ...repo.schemasOf(toLet.id)[0]!, id: 'draft', status: 'draft' });
      await expect(service.validateAgainstVersion('draft', valid)).rejects.toThrow(
        FieldSchemaNotFoundException,
      );
    });
  });
});
