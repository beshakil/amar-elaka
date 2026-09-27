import { geohashCenter, geohashEncode } from './geohash';

describe('geohash', () => {
  it('encodes the reference point from the geohash paper', () => {
    // 57.64911, 10.40744 → u4pruydqqvj (Wikipedia's worked example).
    expect(geohashEncode(57.64911, 10.40744, 11)).toBe('u4pruydqqvj');
  });

  it('encodes Dhaka', () => {
    expect(geohashEncode(23.8103, 90.4125, 5)).toBe('wh0r3');
  });

  it('decodes to a centre that encodes back to the same cell', () => {
    for (const [lat, lng] of [
      [23.8103, 90.4125],
      [24.05, 90.06],
      [-33.9, 151.2],
    ] as const) {
      const cell = geohashEncode(lat, lng, 7);
      const centre = geohashCenter(cell);
      expect(geohashEncode(centre.lat, centre.lng, 7)).toBe(cell);
      expect(Math.abs(centre.lat - lat)).toBeLessThan(0.001);
      expect(Math.abs(centre.lng - lng)).toBeLessThan(0.001);
    }
  });

  it('puts nearby viewers in the same cell', () => {
    expect(geohashEncode(24.05, 90.0601, 6)).toBe(geohashEncode(24.0501, 90.0602, 6));
  });

  it('rejects a character outside the alphabet', () => {
    expect(() => geohashCenter('wh0a')).toThrow(RangeError);
  });
});
