import { and } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  FILTER_ISSUES,
  InvalidFieldFilterException,
  parseFieldFilters,
  type CategoryFieldDefinition,
  type RawFieldFilter,
} from './field-schema';
import { postFieldFilterConditions } from './post-field-filters';

const definition: CategoryFieldDefinition = {
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      price: { 'x-field-type': 'money', type: 'string' },
      bedrooms: { 'x-field-type': 'number', type: 'integer' },
      floor: { 'x-field-type': 'number', type: 'integer' },
      service_charge: { 'x-field-type': 'money', type: 'string' },
      available_from: { 'x-field-type': 'date', type: 'string', format: 'date' },
      property_type: { 'x-field-type': 'select', type: 'string', enum: ['flat', 'house', 'shop'] },
      has_lift: { 'x-field-type': 'bool', type: 'boolean' },
      days: {
        'x-field-type': 'multiselect',
        type: 'array',
        items: { type: 'string', enum: ['sat', 'sun'] },
        uniqueItems: true,
      },
      brand: { 'x-field-type': 'text', type: 'string', maxLength: 40 },
      notes: { 'x-field-type': 'text', type: 'string', maxLength: 500 },
    },
    required: [],
  },
  uiSchema: { order: [], card: [], labels: {} },
  filterableFields: [
    'price',
    'bedrooms',
    'floor',
    'service_charge',
    'available_from',
    'property_type',
    'has_lift',
    'days',
    'brand',
  ],
  searchableFields: [],
  analyticsFields: [],
};

const dialect = new PgDialect();
function toSql(raw: RawFieldFilter[]): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(and(...postFieldFilterConditions(parseFieldFilters(definition, raw)))!);
}

function issuesOf(raw: RawFieldFilter[]): unknown {
  try {
    parseFieldFilters(definition, raw);
    return [];
  } catch (error) {
    if (error instanceof InvalidFieldFilterException) return error.issues;
    throw error;
  }
}

describe('parseFieldFilters', () => {
  it('types each value by its field', () => {
    expect(
      parseFieldFilters(definition, [
        { field: 'bedrooms', op: 'gte', value: '2' },
        { field: 'price', op: 'lt', value: '15000' },
        { field: 'has_lift', op: 'eq', value: 'true' },
        { field: 'property_type', op: 'in', value: 'flat, house' },
        { field: 'days', op: 'any', value: 'sat' },
      ]),
    ).toEqual([
      { kind: 'number', field: 'bedrooms', op: 'gte', value: 2 },
      { kind: 'money', field: 'price', op: 'lt', value: '15000.00' },
      { kind: 'equals', field: 'has_lift', value: true },
      { kind: 'one_of', field: 'property_type', multiselect: false, values: ['flat', 'house'] },
      { kind: 'one_of', field: 'days', multiselect: true, values: ['sat'] },
    ]);
  });

  it('collects every problem: non-filterable fields, wrong operators, bad values', () => {
    expect(
      issuesOf([
        { field: 'notes', op: 'eq', value: 'x' },
        { field: 'nope', op: 'eq', value: 'x' },
        { field: 'bedrooms', op: 'in', value: '2' },
        { field: 'bedrooms', op: 'gte', value: '2.5' },
        { field: 'price', op: 'lt', value: '15,000' },
        { field: 'available_from', op: 'gte', value: '2026-02-30' },
        { field: 'property_type', op: 'eq', value: 'castle' },
        { field: 'property_type', op: 'eq', value: 'flat,house' },
        { field: 'has_lift', op: 'eq', value: 'yes' },
      ]),
    ).toEqual([
      { field: 'notes', code: FILTER_ISSUES.notFilterable },
      { field: 'nope', code: FILTER_ISSUES.notFilterable },
      { field: 'bedrooms', code: FILTER_ISSUES.badOperator },
      { field: 'bedrooms', code: FILTER_ISSUES.badValue },
      { field: 'price', code: FILTER_ISSUES.badValue },
      { field: 'available_from', code: FILTER_ISSUES.badValue },
      { field: 'property_type', code: FILTER_ISSUES.badValue },
      { field: 'property_type', code: FILTER_ISSUES.badValue },
      { field: 'has_lift', code: FILTER_ISSUES.badValue },
    ]);
  });
});

describe('postFieldFilterConditions', () => {
  it('answers "bedrooms >= 2 AND rent < 15000" from the indexed generated columns', () => {
    const query = toSql([
      { field: 'bedrooms', op: 'gte', value: '2' },
      { field: 'price', op: 'lt', value: '15000' },
    ]);
    expect(query.sql).toBe('("posts"."bedrooms" >= $1::numeric and "posts"."price" < $2::numeric)');
    expect(query.params).toEqual(['2', '15000.00']);
  });

  it('uses containment (GIN-indexed) for selects, bools and multiselects', () => {
    const query = toSql([
      { field: 'has_lift', op: 'eq', value: 'true' },
      { field: 'property_type', op: 'in', value: 'flat,house' },
      { field: 'days', op: 'any', value: 'sat,sun' },
    ]);
    expect(query.sql).toBe(
      '("posts"."fields" @> $1::text::jsonb and ("posts"."fields" @> $2::text::jsonb or "posts"."fields" @> $3::text::jsonb)' +
        ' and ("posts"."fields" @> $4::text::jsonb or "posts"."fields" @> $5::text::jsonb))',
    );
    expect(query.params).toEqual([
      '{"has_lift":true}',
      '{"property_type":"flat"}',
      '{"property_type":"house"}',
      '{"days":["sat"]}',
      '{"days":["sun"]}',
    ]);
  });

  it('guards casts on other fields so an older version with another type never errors', () => {
    const query = toSql([
      { field: 'floor', op: 'gt', value: '3' },
      { field: 'service_charge', op: 'lte', value: '500' },
      { field: 'available_from', op: 'gte', value: '2026-10-01' },
    ]);
    expect(query.sql).toContain(`case when jsonb_typeof("posts"."fields" -> $1) = 'number'`);
    expect(query.sql).toContain(`case when ("posts"."fields" ->> $4) ~ $5`);
    expect(query.params).toEqual(
      expect.arrayContaining([
        'floor',
        '3',
        'service_charge',
        '500.00',
        'available_from',
        '2026-10-01',
      ]),
    );
  });

  it('binds field keys and values as parameters, never SQL text', () => {
    const query = toSql([{ field: 'brand', op: 'eq', value: "x'); drop table posts; --" }]);
    expect(query.sql).toBe('"posts"."fields" @> $1::text::jsonb');
    expect(query.params).toEqual([JSON.stringify({ brand: "x'); drop table posts; --" })]);
  });
});
