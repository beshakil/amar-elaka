import { describe, expect, it } from 'vitest';
import {
  filteredFields,
  hasFilters,
  isChosen,
  parseSearchParams,
  searchHref,
  toggleValue,
  withoutField,
} from './params';

describe('search URL state', () => {
  it('reads a shared URL, in any script', () => {
    expect(
      parseSearchParams({
        q: '  বাসা ভাড়া ',
        category: 'to-let',
        'f.condition.in': ['used', 'new,used'],
        price_min: '10000',
        price_max: '20000.50',
        sort: 'price_asc',
        page: '3',
      }),
    ).toEqual({
      q: 'বাসা ভাড়া',
      category: 'to-let',
      filters: { 'f.condition.in': ['used', 'new'] },
      priceMin: '10000',
      priceMax: '20000.50',
      sort: 'price_asc',
      page: 3,
    });
  });

  it('drops anything malformed instead of failing', () => {
    expect(
      parseSearchParams({
        q: 'x'.repeat(250),
        category: 'Bad Slug!',
        'f.condition.in': 'used',
        'f.DROP TABLE.eq': '1',
        price_min: '-5',
        price_max: 'abc',
        sort: 'distance',
        page: '0',
      }),
    ).toEqual({
      q: 'x'.repeat(200),
      category: null,
      filters: {},
      priceMin: null,
      priceMax: null,
      sort: 'relevance',
      page: 1,
    });
    // A reversed price range means nothing.
    const reversed = parseSearchParams({ price_min: '500', price_max: '100' });
    expect([reversed.priceMin, reversed.priceMax]).toEqual([null, null]);
  });

  it('writes the same search as the same URL, and a change goes back to page 1', () => {
    const params = parseSearchParams({
      sort: 'newest',
      'f.b.in': 'x',
      q: 'flat',
      page: '4',
      'f.a.in': 'y',
      category: 'to-let',
    });
    expect(searchHref(params, { page: 4 })).toBe(
      '/search?q=flat&category=to-let&f.a.in=y&f.b.in=x&sort=newest&page=4',
    );
    expect(searchHref(params, { sort: 'price_desc' })).toBe(
      '/search?q=flat&category=to-let&f.a.in=y&f.b.in=x&sort=price_desc',
    );
    // A new category drops the old one's filters.
    expect(searchHref(params, { category: 'mobile-phones' })).toBe(
      '/search?q=flat&category=mobile-phones&sort=newest',
    );
    expect(searchHref(parseSearchParams({}))).toBe('/search');
    expect(searchHref(parseSearchParams({ q: 'বাসা' }))).toBe(
      `/search?q=${encodeURIComponent('বাসা')}`,
    );
  });

  it('toggles field values and removes a field', () => {
    let params = parseSearchParams({ category: 'to-let' });
    params = toggleValue(params, 'condition', 'used');
    params = toggleValue(params, 'condition', 'new');
    expect(isChosen(params, 'condition', 'used')).toBe(true);
    expect(filteredFields(params)).toEqual(['condition']);
    expect(searchHref(params)).toBe('/search?category=to-let&f.condition.in=used%2Cnew');
    params = toggleValue(params, 'condition', 'used');
    params = toggleValue(params, 'condition', 'new');
    expect(params.filters).toEqual({});
    const ranged = parseSearchParams({ category: 'x', 'f.rooms.gte': '2', 'f.rooms.lte': '4' });
    expect(withoutField(ranged, 'rooms').filters).toEqual({});
    expect(hasFilters(parseSearchParams({ q: 'x' }))).toBe(false);
    expect(hasFilters(parseSearchParams({ price_min: '5' }))).toBe(true);
  });
});
