import { geoAutocompleteQuerySchema, geoReverseQuerySchema, geoRouteBodySchema } from './geo.dto';

describe('geo endpoint parameters', () => {
  it('autocomplete needs a query, and lat with lng', () => {
    expect(geoAutocompleteQuerySchema.safeParse({ q: '  ' }).success).toBe(false);
    expect(geoAutocompleteQuerySchema.safeParse({ q: 'mirpur', lat: '23.8' }).success).toBe(false);
    expect(
      geoAutocompleteQuerySchema.parse({ q: ' মিরপুর ১০ ', lat: '23.8', lng: '90.36' }),
    ).toEqual({ q: 'মিরপুর ১০', lat: 23.8, lng: 90.36 });
  });

  it('reverse takes a known purpose, defaulting to area (no provider call)', () => {
    expect(geoReverseQuerySchema.parse({ lat: '23.8', lng: '90.4' })).toEqual({
      lat: 23.8,
      lng: 90.4,
      purpose: 'area',
    });
    expect(
      geoReverseQuerySchema.parse({ lat: '23.8', lng: '90.4', purpose: 'store_setup' }).purpose,
    ).toBe('store_setup');
    expect(
      geoReverseQuerySchema.safeParse({ lat: 23.8, lng: 90.4, purpose: 'district' }).success,
    ).toBe(false);
  });

  it('route takes from and to, car by default', () => {
    expect(
      geoRouteBodySchema.parse({
        from: { lat: 23.75, lng: 90.37 },
        to: { lat: 23.76, lng: 90.38 },
      }),
    ).toEqual({ from: { lat: 23.75, lng: 90.37 }, to: { lat: 23.76, lng: 90.38 }, mode: 'car' });
    expect(
      geoRouteBodySchema.safeParse({ from: { lat: 95, lng: 90 }, to: { lat: 1, lng: 1 } }).success,
    ).toBe(false);
    expect(
      geoRouteBodySchema.safeParse({
        from: { lat: 1, lng: 1 },
        to: { lat: 1, lng: 1 },
        mode: 'plane',
      }).success,
    ).toBe(false);
  });
});
