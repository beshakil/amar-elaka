import { buildSearchFilter, buildSort, fieldFilterExpression, quote } from './filter-builder';

describe('filter builder', () => {
  it('quotes and escapes every string value', () => {
    expect(quote('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(
      fieldFilterExpression({ kind: 'equals', field: 'brand', value: 'x" OR tenant_id != "y' }),
    ).toBe('fields.brand = "x\\" OR tenant_id != \\"y"');
  });

  it('stays in the tenant without a location, and goes by radius with one (§13.26)', () => {
    expect(
      buildSearchFilter({ tenantId: 't1', geo: null, categoryIds: null, fieldFilters: [] }),
    ).toEqual(['tenant_id = "t1"']);
    expect(
      buildSearchFilter({
        tenantId: 't1',
        geo: { lat: 23.8, lng: 90.4, radiusKm: 2.5 },
        categoryIds: ['c1', 'c2'],
        fieldFilters: [],
      }),
    ).toEqual(['_geoRadius(23.8, 90.4, 2500)', 'category_id IN ["c1", "c2"]']);
  });

  it('translates each kind of field filter', () => {
    expect(fieldFilterExpression({ kind: 'number', field: 'bedrooms', op: 'gte', value: 2 })).toBe(
      'fields.bedrooms >= 2',
    );
    expect(
      fieldFilterExpression({ kind: 'money', field: 'price', op: 'lt', value: '15000.00' }),
    ).toBe('fields.price < 1500000');
    expect(
      fieldFilterExpression({
        kind: 'date',
        field: 'available_from',
        op: 'lte',
        value: '2026-10-01',
      }),
    ).toBe('fields.available_from <= 20261001');
    expect(fieldFilterExpression({ kind: 'equals', field: 'has_lift', value: true })).toBe(
      'fields.has_lift = true',
    );
    expect(
      fieldFilterExpression({
        kind: 'one_of',
        field: 'property_type',
        multiselect: false,
        values: ['flat', 'house'],
      }),
    ).toBe('fields.property_type IN ["flat", "house"]');
  });

  it('sorts by distance at the ranking "sort" step whenever a location is given', () => {
    const geo = { lat: 23.8, lng: 90.4, radiusKm: 5 };
    expect(buildSort('relevance', null)).toEqual([]);
    expect(buildSort('relevance', geo)).toEqual(['_geoPoint(23.8, 90.4):asc']);
    expect(buildSort('newest', geo)).toEqual(['published_at:desc', '_geoPoint(23.8, 90.4):asc']);
    expect(buildSort('price_asc', null)).toEqual(['price_minor:asc']);
    expect(buildSort('rating', null)).toEqual(['rating_avg:desc']);
  });
});
