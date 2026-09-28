import { priceBuckets } from './price-buckets';

const taka = (n: number) => n * 100;

describe('priceBuckets', () => {
  it('covers the range with nice boundaries, the last one open', () => {
    expect(priceBuckets(taka(15_000), taka(40_000), 5)).toEqual([
      { min: taka(10_000), max: taka(20_000) },
      { min: taka(20_000), max: taka(30_000) },
      { min: taka(30_000), max: taka(40_000) },
      { min: taka(40_000), max: null },
    ]);
  });

  it('adapts to the scale: vegetables get tens of taka, cars get lakhs', () => {
    expect(priceBuckets(taka(30), taka(95), 4).map((b) => b.min)).toEqual([
      taka(20),
      taka(40),
      taka(60),
      taka(80),
    ]);
    const cars = priceBuckets(taka(450_000), taka(2_300_000), 5);
    expect(cars.map((b) => b.min)).toEqual([
      0,
      taka(500_000),
      taka(1_000_000),
      taka(1_500_000),
      taka(2_000_000),
    ]);
  });

  it('never returns more than asked, and always contains min and max', () => {
    for (const [min, max, count] of [
      [1, 999_999_999, 5],
      [12_345, 12_346, 3],
      [0, taka(100), 1],
      [taka(7), taka(7_000_000), 12],
    ] as const) {
      const buckets = priceBuckets(min, max, count);
      expect(buckets.length).toBeGreaterThan(0);
      expect(buckets.length).toBeLessThanOrEqual(count);
      expect(buckets[0]!.min).toBeLessThanOrEqual(min);
      expect(buckets.at(-1)!.max).toBeNull();
      expect(buckets.at(-1)!.min).toBeLessThanOrEqual(max);
      // Contiguous, whole taka.
      buckets.slice(0, -1).forEach((b, i) => expect(b.max).toBe(buckets[i + 1]!.min));
      buckets.forEach((b) => expect(b.min % 100).toBe(0));
    }
  });

  it('one open range when every price is the same; none when switched off or unusable', () => {
    expect(priceBuckets(taka(500), taka(500), 5)).toEqual([{ min: taka(500), max: null }]);
    expect(priceBuckets(0, taka(100), 0)).toEqual([]);
    expect(priceBuckets(taka(100), 0, 5)).toEqual([]);
    expect(priceBuckets(0.5, 10, 5)).toEqual([]);
  });
});
