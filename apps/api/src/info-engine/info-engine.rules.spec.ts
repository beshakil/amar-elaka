import {
  decodeCursor,
  encodeCursor,
  isStale,
  latest,
  normalizeMoney,
  outagePhase,
} from './info-engine.rules';

describe('info engine rules', () => {
  const now = new Date('2026-10-15T12:00:00Z');

  it('is stale from the stale window on, and when never confirmed', () => {
    expect(isStale('2026-10-05T12:00:00Z', 10, now)).toBe(true);
    expect(isStale('2026-10-05T12:00:01Z', 10, now)).toBe(false);
    expect(isStale(null, 10, now)).toBe(true);
  });

  it('takes the latest confirmation', () => {
    expect(latest(null, '2026-01-01T00:00:00Z', new Date('2026-02-01T00:00:00Z'))).toEqual(
      new Date('2026-02-01T00:00:00Z'),
    );
    expect(latest(null, undefined)).toBeNull();
  });

  it('tells ongoing, upcoming and ended outages apart', () => {
    const h = (n: number) => new Date(now.getTime() + n * 3_600_000);
    expect(outagePhase(h(-1), h(1), now)).toBe('ongoing');
    expect(outagePhase(h(1), h(2), now)).toBe('upcoming');
    expect(outagePhase(h(-2), h(-1), now)).toBe('ended');
  });

  it('stores money with exactly two decimals', () => {
    expect(normalizeMoney('100')).toBe('100.00');
    expect(normalizeMoney('7.5')).toBe('7.50');
    expect(normalizeMoney('007.05')).toBe('7.05');
  });

  it('round-trips the keyset cursor', () => {
    const id = '0191e3a0-b00b-7000-8000-000000000061';
    expect(decodeCursor(encodeCursor(1234.5, id))).toEqual({ distance: 1234.5, id });
  });
});
