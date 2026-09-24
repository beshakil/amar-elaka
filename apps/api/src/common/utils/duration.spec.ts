import { parseDurationMs } from './duration';

describe('parseDurationMs', () => {
  it.each([
    ['500ms', 500],
    ['15s', 15_000],
    ['15m', 900_000],
    ['2h', 7_200_000],
    ['60d', 5_184_000_000],
    ['1y', 31_536_000_000],
  ])('parses %s', (input, expected) => {
    expect(parseDurationMs(input)).toBe(expected);
  });

  it('rejects an unrecognised format', () => {
    expect(() => parseDurationMs('soon')).toThrow('Invalid duration string');
  });
});
