import { describe, expect, it } from 'vitest';
import {
  formatMoney,
  formatNumber,
  groupSouthAsian,
  normalizePhoneInput,
  parseMoneyInput,
  parseNumberInput,
  toBengaliDigits,
  toLatinDigits,
} from './numerals';

describe('numerals', () => {
  it('converts digits both ways and leaves everything else alone', () => {
    expect(toBengaliDigits('Flat 12, floor 3')).toBe('Flat ১২, floor ৩');
    expect(toLatinDigits('১২৩abc৪৫')).toBe('123abc45');
  });

  it('groups lakh/crore style', () => {
    expect(
      ['1', '12', '123', '1234', '12345', '123456', '1234567', '1234567890'].map(groupSouthAsian),
    ).toEqual(['1', '12', '123', '1,234', '12,345', '1,23,456', '12,34,567', '1,23,45,67,890']);
  });

  it('formats stored money in Bengali, keeping paisa only when non-zero', () => {
    expect(formatMoney('1234567.00', 'bn')).toBe('১২,৩৪,৫৬৭');
    expect(formatMoney('15000.50', 'bn')).toBe('১৫,০০০.৫০');
    expect(formatMoney('1234567.00', 'en')).toBe('12,34,567');
    expect(formatMoney('0.00', 'bn')).toBe('০');
  });

  it('formats plain numbers without grouping (years, counts)', () => {
    expect(formatNumber(2019, 'bn')).toBe('২০১৯');
    expect(formatNumber(-2, 'bn')).toBe('-২');
  });

  it('parses money typed in either script, with or without separators', () => {
    expect(parseMoneyInput('১৫,০০০')).toBe('15000.00');
    expect(parseMoneyInput('৳ 1,50,000.5')).toBe('150000.50');
    expect(parseMoneyInput('০০১২')).toBe('12.00');
    expect(parseMoneyInput('15000.555')).toBeUndefined();
    expect(parseMoneyInput('-5')).toBeUndefined();
    expect(parseMoneyInput('1e5')).toBeUndefined();
  });

  it('parses numbers typed in either script', () => {
    expect(parseNumberInput('৩')).toBe(3);
    expect(parseNumberInput('-২')).toBe(-2);
    expect(parseNumberInput('1,250')).toBe(1250);
    expect(parseNumberInput('2.5')).toBe(2.5);
    expect(parseNumberInput('abc')).toBeNaN();
    expect(parseNumberInput('')).toBeNaN();
  });

  it('normalises Bangladeshi phone numbers to E.164', () => {
    expect(normalizePhoneInput('০১৭১১-০০০০০০')).toBe('+8801711000000');
    expect(normalizePhoneInput('+880 1711 000000')).toBe('+8801711000000');
    expect(normalizePhoneInput('8801711000000')).toBe('+8801711000000');
    expect(normalizePhoneInput('12345')).toBe('12345');
  });
});
