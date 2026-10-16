import { decodeDonorCursor, encodeDonorCursor } from './blood-groups';
import { directionOf, fillTrend, previousDate, toPoisha, trendDates } from './bazar-trend';

describe('bazar board arithmetic', () => {
  it('reads money strings as whole poisha', () => {
    expect(toPoisha('45')).toBe(4500);
    expect(toPoisha('45.5')).toBe(4550);
    expect(toPoisha('45.05')).toBe(4505);
    expect(toPoisha('0.10')).toBe(10);
  });

  it('compares mid-prices without floats', () => {
    expect(directionOf({ min: '50', max: '60' }, { min: '50', max: '55' })).toBe('up');
    expect(directionOf({ min: '48', max: '52' }, { min: '50', max: '55' })).toBe('down');
    // Same midpoint from a different range: unchanged.
    expect(directionOf({ min: '45', max: '55' }, { min: '50', max: '50' })).toBe('same');
    // 0.1 + 0.2 style traps stay exact.
    expect(directionOf({ min: '0.10', max: '0.20' }, { min: '0.15', max: '0.15' })).toBe('same');
  });

  it('has no direction without both days', () => {
    expect(directionOf(null, { min: '1', max: '2' })).toBeNull();
    expect(directionOf({ min: '1', max: '2' }, null)).toBeNull();
  });

  it('lists the trend window oldest first, across a month end', () => {
    expect(trendDates('2026-11-02', 4)).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
    expect(previousDate('2026-03-01')).toBe('2026-02-28');
  });

  it('leaves a gap where a day had no price', () => {
    const dates = trendDates('2026-10-15', 3);
    expect(fillTrend(dates, [{ date: '2026-10-15', min: '40', max: '42' }])).toEqual([
      null,
      null,
      { date: '2026-10-15', min: '40', max: '42' },
    ]);
  });
});

describe('donor cursor', () => {
  it('round-trips distance and id', () => {
    const id = '0191e3a0-b00b-7000-8000-000000000061';
    expect(decodeDonorCursor(encodeDonorCursor(1500, id))).toEqual({ distance: 1500, id });
  });
});
