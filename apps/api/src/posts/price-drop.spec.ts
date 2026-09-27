import { isPriceDrop } from './price-drop';

describe('isPriceDrop', () => {
  it('is a drop only when the new price is lower, by the poisha', () => {
    expect(isPriceDrop('12500.00', '12000.00')).toBe(true);
    expect(isPriceDrop('12500.00', '12499.99')).toBe(true);
    expect(isPriceDrop('12500.00', '12500.00')).toBe(false);
    expect(isPriceDrop('12500.00', '13000.00')).toBe(false);
  });

  it('compares exactly where floats would not (0.1 + 0.2 territory)', () => {
    expect(isPriceDrop('0.30', '0.29')).toBe(true);
    expect(isPriceDrop('9999999999.99', '9999999999.98')).toBe(true);
  });

  it('is never a drop when a price appears or disappears', () => {
    expect(isPriceDrop(null, '100.00')).toBe(false);
    expect(isPriceDrop('100.00', null)).toBe(false);
  });
});
