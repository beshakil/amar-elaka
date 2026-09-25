import {
  CategoryHasNoFieldSchemaException,
  FieldSchemaDraftNotFoundException,
  ParentSchemaNotPublishedException,
} from './categories.exceptions';
import {
  FakeCategoriesRepository,
  fakeTenantDb,
  fixedTenantContext,
} from './categories.test-helper';
import {
  InvalidFieldSchemaException,
  parseFieldSchema,
  parseUiSchema,
  renderFields,
  type CategoryFieldDefinition,
  type FieldProperty,
} from './field-schema';
import { FieldSchemaVersionsService } from './field-schema-versions.service';

const ADMIN = '0191e3a0-6666-7000-8000-0000000000a1';

type Fields = Record<
  string,
  { property: FieldProperty; bn: string; en: string; options?: string[] }
>;

/** A small authored definition: every field labelled, every select option labelled. */
function authored(fields: Fields, required: string[] = []): CategoryFieldDefinition {
  const keys = Object.keys(fields);
  return {
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(keys.map((k) => [k, fields[k]!.property])),
      required,
    },
    uiSchema: {
      order: keys,
      card: [],
      labels: Object.fromEntries(keys.map((k) => [k, { bn: fields[k]!.bn, en: fields[k]!.en }])),
      options: Object.fromEntries(
        keys
          .filter((k) => fields[k]!.options)
          .map((k) => [
            k,
            Object.fromEntries(fields[k]!.options!.map((o) => [o, { bn: o, en: o }])),
          ]),
      ),
    },
    filterableFields: [],
    searchableFields: [],
    analyticsFields: [],
  };
}

const select = (options: string[]): FieldProperty => ({
  'x-field-type': 'select',
  type: 'string',
  enum: options,
});
const bedrooms = {
  property: { 'x-field-type': 'number', type: 'integer', minimum: 0 },
  bn: 'শোবার ঘর',
  en: 'Bedrooms',
} as const;
const rent = {
  property: { 'x-field-type': 'money', type: 'string' },
  bn: 'ভাড়া',
  en: 'Rent',
} as const;
const condition = {
  property: select(['new', 'used']),
  bn: 'অবস্থা',
  en: 'Condition',
  options: ['new', 'used'],
};

function setup() {
  const repo = new FakeCategoriesRepository();
  const service = new FieldSchemaVersionsService(
    fakeTenantDb(repo),
    repo.asRepository(),
    fixedTenantContext({ userId: ADMIN, role: 'platform_admin' }),
  );
  return { repo, service };
}

describe('FieldSchemaVersionsService', () => {
  describe('adding and removing fields', () => {
    it('publishes v2 beside a retired, unchanged v1 that old posts still render with', async () => {
      const { repo, service } = setup();
      const toLet = repo.addCategory({ slug: 'to-let', kind: 'rental' });

      await service.saveDraft(toLet.id, authored({ bedrooms, price: rent }, ['price']));
      const v1 = await service.publishDraft(toLet.id);
      const v1Before = structuredClone(repo.schemasOf(toLet.id)[0]);

      // v2 removes bedrooms and adds a required gas field.
      const gas = {
        property: select(['pipeline', 'none']),
        bn: 'গ্যাস',
        en: 'Gas',
        options: ['pipeline', 'none'],
      };
      await service.saveDraft(toLet.id, authored({ price: rent, gas }, ['price', 'gas']));
      const v2 = await service.publishDraft(toLet.id);

      expect([v1.version, v2.version]).toEqual([1, 2]);
      const [storedV1, storedV2] = repo.schemasOf(toLet.id);
      expect(storedV1).toEqual({ ...v1Before, status: 'retired' });
      expect(storedV2!.status).toBe('published');

      // A post written under v1 renders against v1: the removed field keeps its label.
      const v1Post = { bedrooms: 3, price: '12000.00' };
      const { jsonSchema, uiSchema } = await service.getVersion(v1.id);
      expect(
        renderFields(
          { jsonSchema: parseFieldSchema(jsonSchema), uiSchema: parseUiSchema(uiSchema) },
          v1Post,
        ),
      ).toEqual([
        { key: 'bedrooms', type: 'number', label: { bn: 'শোবার ঘর', en: 'Bedrooms' }, value: 3 },
        { key: 'price', type: 'money', label: { bn: 'ভাড়া', en: 'Rent' }, value: '12000.00' },
      ]);
    });

    it('rejects an invalid draft with the engine violations and stores nothing', async () => {
      const { repo, service } = setup();
      const toLet = repo.addCategory({ slug: 'to-let', kind: 'rental' });
      const broken = authored({ price: rent });
      broken.uiSchema.labels = {};
      await expect(service.saveDraft(toLet.id, broken)).rejects.toThrow(
        InvalidFieldSchemaException,
      );
      expect(repo.schemasOf(toLet.id)).toEqual([]);
    });

    it('keeps one draft per category and can discard it', async () => {
      const { repo, service } = setup();
      const toLet = repo.addCategory({ slug: 'to-let', kind: 'rental' });
      const first = await service.saveDraft(toLet.id, authored({ bedrooms }));
      const second = await service.saveDraft(toLet.id, authored({ bedrooms, price: rent }));
      expect(second.id).toBe(first.id);
      expect(repo.schemasOf(toLet.id)).toHaveLength(1);

      await service.discardDraft(toLet.id);
      expect(repo.schemasOf(toLet.id)).toEqual([]);
      await expect(service.publishDraft(toLet.id)).rejects.toThrow(
        FieldSchemaDraftNotFoundException,
      );
    });

    it('refuses field schemas for module tiles', async () => {
      const { repo, service } = setup();
      const tile = repo.addCategory({ slug: 'blood', kind: 'module', moduleCode: 'blood' });
      await expect(service.saveDraft(tile.id, authored({ bedrooms }))).rejects.toThrow(
        CategoryHasNoFieldSchemaException,
      );
    });
  });

  describe('parents and children', () => {
    function family() {
      const { repo, service } = setup();
      const buySell = repo.addCategory({ slug: 'buy-sell' });
      const vehicles = repo.addCategory({ slug: 'vehicles', parentId: buySell.id });
      return { repo, service, buySell, vehicles };
    }

    it("needs the parent's schema published before a child's draft", async () => {
      const { service, vehicles } = family();
      await expect(service.saveDraft(vehicles.id, authored({ bedrooms }))).rejects.toThrow(
        ParentSchemaNotPublishedException,
      );
    });

    it('republishes children, re-flattened, when the parent publishes a new version', async () => {
      const { repo, service, buySell, vehicles } = family();
      await service.saveDraft(buySell.id, authored({ condition }, ['condition']));
      await service.publishDraft(buySell.id);
      const usedOnly = { ...condition, property: select(['used']), options: ['used'] };
      await service.saveDraft(vehicles.id, authored({ condition: usedOnly }));
      await service.publishDraft(vehicles.id);

      // Parent v2 adds a price everyone inherits.
      await service.saveDraft(buySell.id, authored({ condition, price: rent }, ['condition']));
      await service.publishDraft(buySell.id);

      const versions = repo.schemasOf(vehicles.id);
      expect(versions.map((v) => [v.version, v.status])).toEqual([
        [1, 'retired'],
        [2, 'published'],
      ]);
      const current = versions[1]!.jsonSchema as { properties: Record<string, FieldProperty> };
      expect(Object.keys(current.properties)).toEqual(['condition', 'price']);
      // The child's narrowing survives the republish.
      expect(current.properties.condition).toEqual(select(['used']));
    });

    it('fails the whole publish, changing nothing, when a child no longer narrows its parent', async () => {
      const { repo, service, buySell, vehicles } = family();
      await service.saveDraft(buySell.id, authored({ condition }, ['condition']));
      await service.publishDraft(buySell.id);
      await service.saveDraft(vehicles.id, authored({ condition }));
      await service.publishDraft(vehicles.id);
      const before = repo.snapshot();

      // Parent v2 drops "used", which the child still offers.
      const newOnly = { ...condition, property: select(['new']), options: ['new'] };
      await service.saveDraft(buySell.id, authored({ condition: newOnly }, ['condition']));
      const draftState = repo.snapshot();
      await expect(service.publishDraft(buySell.id)).rejects.toThrow(InvalidFieldSchemaException);

      expect(repo.state).toEqual(draftState);
      expect(repo.state.schemas.filter((s) => s.status !== 'draft')).toEqual(
        before.schemas.filter((s) => s.status !== 'draft'),
      );
    });

    it('keeps versions in publish order when a parent republishes a child that has an open draft', async () => {
      const { repo, service, buySell, vehicles } = family();
      await service.saveDraft(buySell.id, authored({ condition }, ['condition']));
      await service.publishDraft(buySell.id);
      await service.saveDraft(vehicles.id, authored({ bedrooms }));
      await service.publishDraft(vehicles.id); // v1
      await service.saveDraft(vehicles.id, authored({ bedrooms, price: rent })); // draft v2

      await service.saveDraft(buySell.id, authored({ condition, price: rent }, ['condition']));
      await service.publishDraft(buySell.id); // republishes vehicles as v3
      const published = await service.publishDraft(vehicles.id);

      expect(published.version).toBe(4);
      expect(repo.schemasOf(vehicles.id).map((v) => [v.version, v.status])).toEqual([
        [1, 'retired'],
        [3, 'retired'],
        [4, 'published'],
      ]);
    });
  });
});
