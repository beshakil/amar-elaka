import { InvalidFieldSchemaException } from './field-schema.exceptions';
import { flattenFieldDefinition, type CategoryFieldDefinition } from './field-schema.flatten';
import type { FieldProperty } from './field-schema.types';

const condition: FieldProperty = {
  'x-field-type': 'select',
  type: 'string',
  enum: ['new', 'used', 'for_parts'],
};
const price: FieldProperty = {
  'x-field-type': 'money',
  type: 'string',
  'x-money-min': '0.00',
  'x-money-max': '99999999.99',
};

const parent: CategoryFieldDefinition = {
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { price, condition },
    required: ['price', 'condition'],
  },
  uiSchema: {
    order: ['price', 'condition'],
    card: ['condition'],
    labels: {
      price: { bn: 'দাম', en: 'Price' },
      condition: { bn: 'অবস্থা', en: 'Condition' },
    },
    options: {
      condition: {
        new: { bn: 'নতুন', en: 'New' },
        used: { bn: 'ব্যবহৃত', en: 'Used' },
        for_parts: { bn: 'পার্টস', en: 'For parts' },
      },
    },
  },
  filterableFields: ['price', 'condition'],
  searchableFields: [],
  analyticsFields: ['price', 'condition'],
};

function child(
  properties: Record<string, FieldProperty>,
  extra: Partial<CategoryFieldDefinition['uiSchema']> = {},
): CategoryFieldDefinition {
  const keys = Object.keys(properties);
  return {
    jsonSchema: { type: 'object', additionalProperties: false, properties, required: [] },
    uiSchema: {
      order: keys,
      card: [],
      labels: Object.fromEntries(keys.map((k) => [k, { bn: k, en: k }])),
      ...extra,
    },
    filterableFields: [],
    searchableFields: [],
    analyticsFields: [],
  };
}

function violationsOf(definition: CategoryFieldDefinition): string[] {
  try {
    flattenFieldDefinition(parent, definition);
    return [];
  } catch (error) {
    if (error instanceof InvalidFieldSchemaException) return error.violations;
    throw error;
  }
}

describe('flattenFieldDefinition', () => {
  it('puts parent fields first, keeps parent required fields and the parent card by default', () => {
    const brand: FieldProperty = { 'x-field-type': 'text', type: 'string', maxLength: 40 };
    const flat = flattenFieldDefinition(parent, child({ brand }));

    expect(Object.keys(flat.jsonSchema.properties)).toEqual(['price', 'condition', 'brand']);
    expect(flat.jsonSchema.required).toEqual(['price', 'condition']);
    expect(flat.uiSchema.order).toEqual(['price', 'condition', 'brand']);
    expect(flat.uiSchema.card).toEqual(['condition']);
  });

  it('lets a child narrow an inherited select and drops labels for removed options', () => {
    const narrowed: FieldProperty = { ...condition, enum: ['used', 'for_parts'] };
    const flat = flattenFieldDefinition(parent, child({ condition: narrowed }));

    expect(flat.jsonSchema.properties.condition).toEqual(narrowed);
    expect(Object.keys(flat.uiSchema.options?.condition ?? {})).toEqual(['used', 'for_parts']);
  });

  it('lets a child tighten money bounds', () => {
    const tighter: FieldProperty = { ...price, 'x-money-min': '100.00' };
    expect(violationsOf(child({ price: tighter }))).toEqual([]);
  });

  it.each<[string, FieldProperty]>([
    ['adds an option', { ...condition, enum: ['new', 'used', 'refurbished'] }],
    ['raises the money maximum', { ...price, 'x-money-max': '999999999.99' }],
    ['drops a money bound', { 'x-field-type': 'money', type: 'string', 'x-money-min': '0.00' }],
    ['changes the type', { 'x-field-type': 'text', type: 'string', maxLength: 10 }],
  ])('rejects a child that %s', (_, property) => {
    const key = property['x-field-type'] === 'select' ? 'condition' : 'price';
    expect(violationsOf(child({ [key]: property }))).toHaveLength(1);
  });

  it('merges field lists and drops hidden inherited fields from them and from the card', () => {
    const flat = flattenFieldDefinition(parent, {
      ...child({ condition }, { hidden: ['price'], card: ['price', 'condition'] }),
      filterableFields: ['condition'],
    });
    expect(flat.filterableFields).toEqual(['condition']);
    expect(flat.analyticsFields).toEqual(['condition']);
    expect(flat.uiSchema.card).toEqual(['condition']);
  });

  it('never lets a child make an inherited required field optional', () => {
    const flat = flattenFieldDefinition(parent, child({ condition }));
    expect(flat.jsonSchema.required).toContain('condition');
  });
});
