import { InvalidFieldSchemaException } from './field-schema.exceptions';
import { checkPublishable, type FieldSchemaDraft } from './field-schema.publish-check';

function draft(overrides: Partial<FieldSchemaDraft> = {}): FieldSchemaDraft {
  return {
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        price: {
          'x-field-type': 'money',
          type: 'string',
          'x-money-min': '0.00',
          'x-money-max': '100.00',
        },
        brand: { 'x-field-type': 'text', type: 'string', maxLength: 40, 'x-analytics-safe': true },
        notes: { 'x-field-type': 'text', type: 'string', maxLength: 500 },
        kind: { 'x-field-type': 'select', type: 'string', enum: ['a', 'b'] },
        phone: { 'x-field-type': 'phone', type: 'string' },
      },
      required: ['price'],
      allOf: [
        {
          if: { properties: { kind: { enum: ['a'] } }, required: ['kind'] },
          then: { required: ['brand'] },
        },
      ],
    },
    uiSchema: {
      order: ['price', 'brand', 'notes', 'kind', 'phone'],
      card: ['kind'],
      labels: {
        price: { bn: 'দাম', en: 'Price' },
        brand: { bn: 'ব্র্যান্ড', en: 'Brand' },
        notes: { bn: 'নোট', en: 'Notes' },
        kind: { bn: 'ধরন', en: 'Kind' },
        phone: { bn: 'ফোন', en: 'Phone' },
      },
      options: { kind: { a: { bn: 'ক', en: 'A' }, b: { bn: 'খ', en: 'B' } } },
    },
    filterableFields: ['kind', 'price'],
    searchableFields: ['brand', 'notes', 'kind'],
    analyticsFields: ['price', 'brand', 'kind'],
    ...overrides,
  };
}

function violationsOf(value: FieldSchemaDraft): string[] {
  try {
    checkPublishable(value);
    return [];
  } catch (error) {
    if (error instanceof InvalidFieldSchemaException) return error.violations;
    throw error;
  }
}

/** Replaces one property of the default draft's json schema. */
function withProperty(key: string, property: unknown): FieldSchemaDraft {
  const base = draft();
  const schema = base.jsonSchema as { properties: Record<string, unknown> };
  return {
    ...base,
    jsonSchema: { ...schema, properties: { ...schema.properties, [key]: property } },
  };
}

describe('checkPublishable', () => {
  it('accepts a valid draft', () => {
    expect(violationsOf(draft())).toEqual([]);
  });

  it('rejects anything outside the supported subset', () => {
    expect(violationsOf(withProperty('kind', { type: 'string', enum: ['a', 'b'] }))).not.toEqual(
      [],
    );
    expect(
      violationsOf(withProperty('price', { 'x-field-type': 'money', type: 'number' })),
    ).not.toEqual([]);
  });

  it('enforces the reserved key types', () => {
    expect(
      violationsOf(withProperty('price', { 'x-field-type': 'number', type: 'number', minimum: 0 })),
    ).toContain('price: reserved key must be money');
  });

  it('keeps free text, phones and URLs out of the scrub whitelist', () => {
    expect(violationsOf(draft({ analyticsFields: ['notes'] }))).toEqual([
      'analytics_fields: notes is not allowed here',
    ]);
    expect(violationsOf(draft({ analyticsFields: ['phone'] }))).toEqual([
      'analytics_fields: phone is not allowed here',
    ]);
  });

  it('only allows text and selects as searchable, and never a phone as a filter', () => {
    expect(violationsOf(draft({ searchableFields: ['price'] }))).toEqual([
      'searchable_fields: price is not allowed here',
    ]);
    expect(violationsOf(draft({ filterableFields: ['phone'] }))).toEqual([
      'filterable_fields: phone is not allowed here',
    ]);
  });

  it('checks cross-references: required keys, conditions and field lists', () => {
    expect(violationsOf(draft({ filterableFields: ['nope'] }))).toEqual([
      'filterable_fields: unknown field nope',
    ]);
    const base = draft();
    const schema = base.jsonSchema as Record<string, unknown>;
    expect(
      violationsOf({
        ...base,
        jsonSchema: {
          ...schema,
          allOf: [
            {
              if: { properties: { kind: { enum: ['z'] } }, required: ['kind'] },
              then: { required: ['brand'] },
            },
          ],
        },
      }),
    ).toEqual(['allOf.0: kind has no option z']);
  });

  it('rejects inverted or malformed money bounds without throwing', () => {
    expect(
      violationsOf(
        withProperty('price', {
          'x-field-type': 'money',
          type: 'string',
          'x-money-min': '10.00',
          'x-money-max': '1.00',
        }),
      ),
    ).toEqual(['price: x-money-min is above x-money-max']);
    expect(
      violationsOf(
        withProperty('price', { 'x-field-type': 'money', type: 'string', 'x-money-min': '1e3' }),
      ),
    ).toEqual(['price: money bound 1e3 is not a two-decimal amount']);
  });

  it('checks x-show-when: known select/bool controller, valid values, no cycles', () => {
    const rule = (field: string, values: unknown[]) => ({ field, in: values });
    const withRule = (key: string, value: unknown) => {
      const base = draft();
      const schema = base.jsonSchema as { properties: Record<string, Record<string, unknown>> };
      return {
        ...base,
        jsonSchema: {
          ...schema,
          properties: {
            ...schema.properties,
            [key]: { ...schema.properties[key], 'x-show-when': value },
          },
        },
      };
    };
    expect(violationsOf(withRule('brand', rule('kind', ['a'])))).toEqual([]);
    expect(violationsOf(withRule('brand', rule('kind', ['z'])))).toEqual([
      'brand.x-show-when: kind has no value z',
    ]);
    expect(violationsOf(withRule('brand', rule('price', ['1'])))).toEqual([
      'brand.x-show-when: price must be a select, multiselect or bool field',
    ]);
    expect(violationsOf(withRule('brand', rule('nope', ['a'])))).toEqual([
      'brand.x-show-when: unknown or self-referencing field nope',
    ]);
    const cyclic = withRule('kind', rule('kind', ['a']));
    expect(violationsOf(cyclic)).toContain(
      'kind.x-show-when: unknown or self-referencing field kind',
    );
  });

  it('keeps textarea out of filters and analytics', () => {
    const base = withProperty('notes', {
      'x-field-type': 'textarea',
      type: 'string',
      maxLength: 500,
    });
    expect(violationsOf({ ...base, filterableFields: ['notes'] })).toEqual([
      'filterable_fields: notes is not allowed here',
    ]);
    expect(violationsOf({ ...base, analyticsFields: ['notes'] })).toEqual([
      'analytics_fields: notes is not allowed here',
    ]);
    expect(violationsOf({ ...base, searchableFields: ['notes'] })).toEqual([]);
  });

  it('requires a label for every field and every option', () => {
    const base = draft();
    const ui = base.uiSchema as { options: Record<string, Record<string, unknown>> };
    expect(
      violationsOf({ ...base, uiSchema: { ...ui, options: { kind: { a: ui.options.kind!.a } } } }),
    ).toEqual(['ui_schema.options: missing kind.b']);
  });
});
