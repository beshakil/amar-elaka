import { geohash } from './geohash';

describe('geohash', () => {
  it('matches published reference values', () => {
    // Niemeyer's examples / any geohash tool.
    expect(geohash(57.64911, 10.40744, 11)).toBe('u4pruydqqvj');
    expect(geohash(42.6, -5.6, 5)).toBe('ezs42');
  });

  it('gives nearby pins in one block the same 7-character cell, and the next block another', () => {
    const crescentLake = geohash(23.7629, 90.3787, 7);
    expect(geohash(23.76295, 90.37875, 7)).toBe(crescentLake); // ~7 m away
    expect(geohash(23.7655, 90.3787, 7)).not.toBe(crescentLake); // ~290 m north
    expect(crescentLake).toHaveLength(7);
  });

  it('is a prefix of the same point at a higher precision', () => {
    expect(geohash(23.8069, 90.3687, 9).startsWith(geohash(23.8069, 90.3687, 6))).toBe(true);
  });
});
