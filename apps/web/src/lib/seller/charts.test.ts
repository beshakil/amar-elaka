import { describe, expect, it } from 'vitest';
import { areaPath, labelIndexes, linePath, niceMax, trendPercent, xAt, yAt } from './charts';

describe('seller charts', () => {
  it('rounds the axis top up to 1·2·5×10ⁿ', () => {
    expect([0, 1, 3, 7, 10, 11, 240, 1240].map(niceMax)).toEqual([1, 1, 5, 10, 10, 20, 500, 2000]);
    expect(niceMax(Number.NaN)).toBe(1);
  });

  it('places points across the width, values up from the baseline', () => {
    const plot = { width: 100, height: 50, top: 10 };
    expect([0, 1, 2].map((i) => xAt(i, 3, plot))).toEqual([0, 50, 100]);
    expect(xAt(0, 1, plot)).toBe(50);
    expect(yAt(0, plot)).toBe(50);
    expect(yAt(10, plot)).toBe(0);
    expect(yAt(-3, plot)).toBe(50);
    expect(linePath([0, 5, 10], plot)).toBe('M0,50 L50,25 L100,0');
    expect(areaPath([0, 10], plot)).toBe('M0,50 L100,0 L100,50 L0,50 Z');
    expect(areaPath([], plot)).toBe('');
  });

  it('labels about as many days as fit, always the last one', () => {
    expect(labelIndexes(5, 7)).toEqual([0, 1, 2, 3, 4]);
    const thirty = labelIndexes(30, 6);
    expect(thirty.at(-1)).toBe(29);
    expect(thirty.length).toBeLessThanOrEqual(6);
  });

  it('rounds the API’s percent change to a whole percent', () => {
    expect(trendPercent(23.6)).toBe(24);
    expect(trendPercent(-66.7)).toBe(-67);
    expect(trendPercent(null)).toBeNull();
  });
});
