import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  activeFilterCount,
  filterFieldKeys,
  filterStateFromSearchParams,
  filtersToSearchParams,
  toRawFilters,
} from './filters';
import type { CategoryFieldSchema } from './schema';

const load = (name: string) =>
  (
    JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as {
      fieldSchema: CategoryFieldSchema;
    }
  ).fieldSchema;
const toLet = load('to-let.json');
const rentACar = load('rent-a-car.json');

describe('filters', () => {
  it('offers a control for every filterable field that has one', () => {
    expect(filterFieldKeys(toLet)).toEqual(
      toLet.filterableFields.filter((k) => toLet.uiSchema.order.includes(k)),
    );
  });

  it('turns "bedrooms ≥ 2 and rent ≤ ১৫,০০০" into the API filter format', () => {
    expect(
      toRawFilters(toLet, {
        bedrooms: { min: '২' },
        price: { max: '১৫,০০০' },
        property_type: ['flat', 'house'],
        has_lift: true,
        water_24h: false,
      }),
    ).toEqual({
      filters: [
        { field: 'property_type', op: 'in', value: 'flat,house' },
        { field: 'bedrooms', op: 'gte', value: '2' },
        { field: 'price', op: 'lte', value: '15000.00' },
        { field: 'has_lift', op: 'eq', value: 'true' },
      ],
      issues: [],
    });
  });

  it('uses eq for one select option and any for multiselects', () => {
    expect(
      toRawFilters(rentACar, { vehicle_type: ['suv'], trip_types: ['airport'] }).filters,
    ).toEqual([
      { field: 'vehicle_type', op: 'eq', value: 'suv' },
      { field: 'trip_types', op: 'any', value: 'airport' },
    ]);
  });

  it('reports invalid bounds and min above max instead of sending them', () => {
    expect(
      toRawFilters(toLet, { bedrooms: { min: '৫', max: '২' }, floor: { min: 'abc' } }).issues,
    ).toEqual([
      { field: 'bedrooms', bound: 'min', id: 'errors.minAboveMax' },
      { field: 'floor', bound: 'min', id: 'errors.invalidInteger' },
    ]);
  });

  it('round-trips through the URL', () => {
    const state = { bedrooms: { min: '2' }, property_type: ['flat', 'house'], has_lift: true };
    const params = filtersToSearchParams(toRawFilters(toLet, state).filters);
    expect(params.toString()).toBe(
      'f.property_type.in=flat%2Chouse&f.bedrooms.gte=2&f.has_lift.eq=true',
    );
    expect(filterStateFromSearchParams(toLet, params)).toEqual(state);
    expect(activeFilterCount(toLet, state)).toBe(3);
  });
});
