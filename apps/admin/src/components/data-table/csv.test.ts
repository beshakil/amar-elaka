import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';

describe('toCsv', () => {
  it('joins rows with CRLF and cells with commas', () => {
    expect(toCsv(['a', 'b'], [[1, 'x']])).toBe('a,b\r\n1,x');
  });

  it('quotes cells containing separators, quotes or newlines, doubling inner quotes', () => {
    expect(toCsv(['v'], [['a,b'], ['say "hi"'], ['two\nlines']])).toBe(
      'v\r\n"a,b"\r\n"say ""hi"""\r\n"two\nlines"',
    );
  });

  it('neutralises spreadsheet formulas (CSV injection)', () => {
    expect(toCsv(['v'], [['=HYPERLINK("x")'], ['+1'], ['-1'], ['@SUM(A1)']])).toBe(
      `v\r\n"'=HYPERLINK(""x"")"\r\n'+1\r\n'-1\r\n'@SUM(A1)`,
    );
  });

  it('writes empty cells for null/undefined and JSON for objects', () => {
    expect(toCsv(['a', 'b', 'c'], [[null, undefined, { k: 1 }]])).toBe('a,b,c\r\n,,"{""k"":1}"');
  });

  it('keeps Bengali text intact', () => {
    expect(toCsv(['নাম'], [['মিরপুর']])).toBe('নাম\r\nমিরপুর');
  });
});
