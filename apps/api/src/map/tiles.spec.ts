import { snapToCell, tileRangeBounds, tilesCovering, worldPixel } from './tiles';

describe('tile maths', () => {
  it('finds the slippy-map tile of a point (OSM numbering)', () => {
    // Dhaka at z12: tile 3076/1768 (checked against a real Protomaps tile request).
    const range = tilesCovering({ minLng: 90.4, minLat: 23.81, maxLng: 90.41, maxLat: 23.82 }, 12);
    expect(range).toMatchObject({ minX: 3076, maxX: 3076, minY: 1768, maxY: 1768 });
  });

  it('a tile range bounds a box that contains the asked one', () => {
    const box = { minLng: 90.35, minLat: 23.74, maxLng: 90.42, maxLat: 23.8 };
    const bounds = tileRangeBounds(tilesCovering(box, 14));
    expect(bounds.minLng).toBeLessThanOrEqual(box.minLng);
    expect(bounds.minLat).toBeLessThanOrEqual(box.minLat);
    expect(bounds.maxLng).toBeGreaterThanOrEqual(box.maxLng);
    expect(bounds.maxLat).toBeGreaterThanOrEqual(box.maxLat);
  });

  it('a small pan inside the same tiles keeps the same range (one cache key)', () => {
    const a = tilesCovering({ minLng: 90.371, minLat: 23.751, maxLng: 90.379, maxLat: 23.759 }, 14);
    const b = tilesCovering(
      { minLng: 90.372, minLat: 23.752, maxLng: 90.3795, maxLat: 23.7595 },
      14,
    );
    expect(b).toEqual(a);
  });

  it('snaps a point to the centre of its cell, so nearby centres agree', () => {
    const a = snapToCell({ lat: 23.7501, lng: 90.3701 }, 10, 64);
    const b = snapToCell({ lat: 23.7502, lng: 90.3702 }, 10, 64);
    expect(b).toEqual(a);
    const pa = worldPixel(a.lat, a.lng, 10);
    expect((pa.x % 64) / 64).toBeCloseTo(0.5, 5);
  });
});
