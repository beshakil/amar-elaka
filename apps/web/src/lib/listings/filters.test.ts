import { describe, expect, it } from 'vitest';
import type { CategoryFieldSchema } from '@amar-elaka/dynamic-form';
import { filtersFromQuery } from './filters';

const schema = {
  id: '0191e3a0-0000-7000-8000-00000000f001',
  version: 1,
  jsonSchema: {
    type: 'object',
    properties: {
      condition: { 'x-field-type': 'select', type: 'string', enum: ['new', 'used'] },
      price: { 'x-field-type': 'money', type: 'string' },
    },
  },
  uiSchema: { order: ['condition', 'price'] },
  filterableFields: ['condition', 'price'],
  searchableFields: [],
} as unknown as CategoryFieldSchema;

describe('filtersFromQuery', () => {
  it('is no filters without f.* parameters', () => {
    expect(filtersFromQuery(schema, { page: '2' }).json).toBeNull();
  });

  it('groups the parameters into the API JSON', () => {
    const { json } = filtersFromQuery(schema, { 'f.condition.eq': 'used' });
    expect(JSON.parse(json ?? 'null')).toEqual({ condition: { eq: 'used' } });
  });

  it('ignores unknown fields and blank values', () => {
    expect(
      filtersFromQuery(schema, { 'f.colour.eq': 'red', 'f.condition.eq': ' ' }).json,
    ).toBeNull();
  });
});
