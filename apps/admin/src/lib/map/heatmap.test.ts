import { describe, expect, it } from 'vitest';
import { cellsCenter, cellsToGeoJson, geohashBounds } from './heatmap';

describe('geohashBounds', () => {
  it('decodes a geohash to its cell (the reference example "ezs42")', () => {
    const [w, s, e, n] = geohashBounds('ezs42');
    expect(s).toBeCloseTo(42.583, 3);
    expect(n).toBeCloseTo(42.627, 3);
    expect(w).toBeCloseTo(-5.625, 3);
    expect(e).toBeCloseTo(-5.581, 3);
  });

  it('contains the centre PostGIS returns for it', () => {
    // st_pointfromgeohash('wh12q9') from heatmap.db-spec.
    const [w, s, e, n] = geohashBounds('wh12q9');
    expect(22.55218505859375).toBeGreaterThan(s);
    expect(22.55218505859375).toBeLessThan(n);
    expect(92.0489501953125).toBeGreaterThan(w);
    expect(92.0489501953125).toBeLessThan(e);
  });

  it('refuses what is not a geohash', () => {
    expect(() => geohashBounds('wh1a')).toThrow(/not a geohash/);
  });
});

describe('cellsToGeoJson', () => {
  it('draws each cell as a closed square, coloured by its share of the densest', () => {
    const geojson = cellsToGeoJson([
      { geohash: 'wh12q9', lat: 22.55, lng: 92.05, count: 10 },
      { geohash: 'wh12qd', lat: 22.56, lng: 92.05, count: 5 },
    ]);
    expect(geojson.features).toHaveLength(2);
    const [first, second] = geojson.features;
    expect(first!.properties).toEqual({ count: 10, intensity: 1 });
    expect(second!.properties).toEqual({ count: 5, intensity: 0.5 });
    const ring = first!.geometry.coordinates[0]!;
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
  });

  it('is empty with no cells', () => {
    expect(cellsToGeoJson([]).features).toEqual([]);
    expect(cellsCenter([])).toBeNull();
  });
});
