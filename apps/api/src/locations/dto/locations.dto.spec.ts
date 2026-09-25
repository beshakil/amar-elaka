import {
  geocodeQuerySchema,
  tenantBoundarySchema,
  toBoundaryInput,
  viewportQuerySchema,
} from './locations.dto';

describe('location request parameters', () => {
  it('parses a viewport box in map order (minLng,minLat,maxLng,maxLat)', () => {
    expect(viewportQuerySchema.parse({ bbox: '90.3, 24.5, 90.5, 24.7' })).toEqual({
      bbox: { minLng: 90.3, minLat: 24.5, maxLng: 90.5, maxLat: 24.7 },
      level: 'upazila',
    });
    for (const bbox of ['90.5,24.5,90.3,24.7', '1,2,3', 'a,b,c,d', '90,95,91,96']) {
      expect(viewportQuerySchema.safeParse({ bbox }).success).toBe(false);
    }
    expect(viewportQuerySchema.safeParse({ bbox: '90,24,91,25', level: 'union' }).success).toBe(
      false,
    );
  });

  it('accepts a polygon boundary, or a radius with centre and radius, nothing mixed', () => {
    expect(toBoundaryInput(tenantBoundarySchema.parse({ mode: 'polygon' }))).toEqual({
      mode: 'polygon',
    });
    expect(
      toBoundaryInput(
        tenantBoundarySchema.parse({
          mode: 'radius',
          center: { lat: 23.8069, lng: 90.3687 },
          radiusKm: 4,
        }),
      ),
    ).toEqual({ mode: 'radius', center: { lat: 23.8069, lng: 90.3687 }, radiusKm: 4 });
    expect(tenantBoundarySchema.safeParse({ mode: 'radius', radiusKm: 4 }).success).toBe(false);
    expect(tenantBoundarySchema.safeParse({ mode: 'polygon', radiusKm: 4 }).success).toBe(false);
    expect(
      tenantBoundarySchema.safeParse({
        mode: 'radius',
        center: { lat: 23.8, lng: 90.3 },
        radiusKm: 0,
      }).success,
    ).toBe(false);
  });

  it('needs a query, and lat with lng', () => {
    expect(geocodeQuerySchema.safeParse({ q: '  ' }).success).toBe(false);
    expect(geocodeQuerySchema.safeParse({ q: 'mirpur', lat: '23.8' }).success).toBe(false);
    expect(geocodeQuerySchema.parse({ q: ' মিরপুর ১০ ', lat: '23.8', lng: '90.36' })).toEqual({
      q: 'মিরপুর ১০',
      lat: 23.8,
      lng: 90.36,
    });
  });
});
