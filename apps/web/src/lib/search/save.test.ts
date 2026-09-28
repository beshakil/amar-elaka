import { describe, expect, it } from 'vitest';
import type { CategoryFieldSchema } from '@amar-elaka/dynamic-form';
import type { TenantConfig } from '../api/schemas';
import { queryOf, safeSearchReturn, savedSearchBody } from './save';

const tenant = { mapCenter: { lat: 23.8, lng: 90.36 }, radiusKm: 5 } as TenantConfig;

const schema = {
  jsonSchema: {
    type: 'object',
    properties: { condition: { 'x-field-type': 'select', type: 'string', enum: ['new', 'used'] } },
    required: [],
  },
  uiSchema: { order: ['condition'], card: [], labels: {} },
  filterableFields: ['condition'],
  searchableFields: [],
} as unknown as CategoryFieldSchema;

const form = (entries: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(entries)) data.set(k, v);
  return data;
};

describe('saving a search from the web', () => {
  it('returns only to this site’s own search', () => {
    expect(safeSearchReturn('/search?q=basa')).toBe('/search?q=basa');
    for (const bad of ['https://evil.test/search', '//evil.test', '/login', '/search#x', null, 7]) {
      expect(safeSearchReturn(bad)).toBe('/search');
    }
  });

  it('keeps repeated parameters when reading the return path', () => {
    expect(queryOf('/search?f.a.in=x&f.a.in=y&q=z')).toEqual({ 'f.a.in': ['x', 'y'], q: 'z' });
  });

  it('saves exactly the search the page showed', () => {
    const body = savedSearchBody(
      form({ name: ' basa vara ', frequency: 'instant', radius_km: '10' }),
      '/search?q=basa+vara&category=to-let&f.condition.in=used&price_min=10000&price_max=20000',
      tenant,
      schema,
    );
    expect(body).toEqual({
      name: 'basa vara',
      q: 'basa vara',
      filters: {
        category: 'to-let',
        // The shared filter parser's own form: one option is an equality (as the page sends it).
        fields: { condition: { eq: 'used' } },
        price_min: '10000',
        price_max: '20000',
      },
      center: { lat: 23.8, lng: 90.36 },
      radius_km: 10,
      frequency: 'instant',
    });
  });

  it('falls back to the area radius; refuses an empty name or a bad frequency', () => {
    expect(savedSearchBody(form({ name: 'x' }), '/search?q=x', tenant, null)).toMatchObject({
      radius_km: 5,
      frequency: 'daily',
    });
    expect(savedSearchBody(form({ name: '  ' }), '/search?q=x', tenant, null)).toBeNull();
    expect(
      savedSearchBody(form({ name: 'x', frequency: 'hourly' }), '/search?q=x', tenant, null),
    ).toBeNull();
  });
});
