import { describe, expect, it } from 'vitest';
import { sparklineSegments, toPoisha } from './bazar';

describe('bazar board drawing', () => {
  it('reads money in poisha', () => {
    expect(toPoisha('45')).toBe(4500);
    expect(toPoisha('45.5')).toBe(4550);
    expect(toPoisha('0.05')).toBe(5);
  });

  it('draws nothing with fewer than two prices', () => {
    expect(sparklineSegments([null, { date: 'd', min: '1', max: '2' }], 60, 20)).toEqual([]);
  });

  it('breaks the line on a missing day, lowest price at the bottom', () => {
    const day = (min: string) => ({ date: 'd', min, max: min });
    const segments = sparklineSegments([day('10'), day('20'), null, day('15'), day('10')], 40, 20);
    expect(segments).toEqual(['0.0,20.0 10.0,0.0', '30.0,10.0 40.0,20.0']);
  });
});
