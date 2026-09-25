import { searchQuerySchema, suggestQuerySchema } from './search.dto';

describe('search query parameters', () => {
  it('applies defaults', () => {
    expect(searchQuerySchema.parse({})).toMatchObject({
      q: '',
      type: 'posts',
      sort: 'relevance',
      page: 1,
    });
  });

  it('parses filters JSON into raw field filters', () => {
    const parsed = searchQuerySchema.parse({
      category: 'to-let',
      filters: JSON.stringify({
        bedrooms: { gte: 2 },
        property_type: { in: ['flat', 'house'] },
        has_lift: { eq: true },
      }),
      lat: '23.8',
      lng: '90.4',
    });
    expect(parsed.filters).toEqual([
      { field: 'bedrooms', op: 'gte', value: '2' },
      { field: 'property_type', op: 'in', value: 'flat,house' },
      { field: 'has_lift', op: 'eq', value: 'true' },
    ]);
    expect(parsed).toMatchObject({ lat: 23.8, lng: 90.4 });
  });

  it('rejects bad input', () => {
    const bad = [
      { filters: '{"bedrooms":{"gte":2}}' }, // no category
      { category: 'to-let', filters: 'not json' },
      { category: 'to-let', filters: '{"Bad Name":{"eq":1}}' },
      { category: 'to-let', filters: '{"x":{"like":"a"}}' },
      { lat: '23.8' }, // lng missing
      { sort: 'nearest' }, // needs a location
      { lat: '100', lng: '90' },
      { q: 'x'.repeat(201) },
      { page: '0' },
    ];
    for (const input of bad) expect(searchQuerySchema.safeParse(input).success).toBe(false);
  });

  it('parses suggest parameters', () => {
    expect(suggestQuerySchema.parse({ q: ' ডাক ' })).toEqual({ q: 'ডাক' });
    expect(suggestQuerySchema.safeParse({ q: 'a', lng: '90' }).success).toBe(false);
  });
});
