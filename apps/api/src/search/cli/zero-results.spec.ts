import { formatReport, parseFlag } from './zero-results';

describe('search:zero-results', () => {
  it('reads --days / --limit in both spellings, and refuses nonsense', () => {
    expect(parseFlag(['--days', '14'], 'days')).toBe(14);
    expect(parseFlag(['--limit=20'], 'limit')).toBe(20);
    expect(parseFlag([], 'days')).toBeUndefined();
    expect(() => parseFlag(['--days', '0'], 'days')).toThrow();
    expect(() => parseFlag(['--days=abc'], 'days')).toThrow();
  });

  it('prints a Markdown table with the Banglish and the words the dictionary already knows', () => {
    const report = formatReport(
      [
        {
          q_normalized: 'ডাক্তার শিশু',
          searches: 9,
          searchers: 6,
          tenants: 2,
          last_searched_at: new Date('2026-09-27T10:00:00Z'),
        },
        {
          q_normalized: 'plumbr|x',
          searches: 3,
          searchers: 3,
          tenants: 1,
          last_searched_at: new Date('2026-09-27T11:00:00Z'),
        },
      ],
      { ডাক্তার: ['doctor', 'daktar'] },
      7,
    );
    expect(report.split('\n')).toEqual([
      '# Zero-result searches, last 7 days',
      '',
      '| Query | Banglish | Searchers | Searches | Tenants | Words the dictionary knows |',
      '| --- | --- | ---: | ---: | ---: | --- |',
      '| ডাক্তার শিশু | daktar shishu | 6 | 9 | 2 | ডাক্তার |',
      '| plumbr\\|x |  | 3 | 3 | 1 | — |',
    ]);
  });

  it('says so when every search found something', () => {
    expect(formatReport([], {}, 7)).toContain('None: every search found something.');
  });
});
