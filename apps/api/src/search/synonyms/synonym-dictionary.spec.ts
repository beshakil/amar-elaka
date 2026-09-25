import { readFileSync } from 'node:fs';
import { DICTIONARY_PATH } from './export-synonyms';
import { SYNONYM_LINES } from './search-synonyms.generated';
import {
  latinEquivalents,
  parseSynonymDictionary,
  SynonymDictionaryError,
  toMeilisearchSynonyms,
} from './synonym-dictionary';

const wrap = (body: string) =>
  `intro\n<!-- dictionary:start -->\n${body}\n<!-- dictionary:end -->\n`;

describe('search synonym dictionary (docs/specs/search-synonyms.md)', () => {
  const lines = parseSynonymDictionary(readFileSync(DICTIONARY_PATH, 'utf8'));

  it('is valid, and the generated module is up to date (run `pnpm --filter @amar-elaka/api search:synonyms`)', () => {
    expect(SYNONYM_LINES).toEqual(lines);
  });

  it('puts ডাক্তার, daktar, dakter and doctor in one group', () => {
    const doctor = lines.find((l) => l.terms.includes('ডাক্তার'));
    expect(doctor?.terms).toEqual(expect.arrayContaining(['daktar', 'dakter', 'doctor']));
  });

  it('gives electrician for ইলেকট্রিশিয়ান and house for বাসা', () => {
    const equivalents = latinEquivalents(lines);
    expect(equivalents.get('ইলেকট্রিশিয়ান')).toContain('electrician');
    expect(equivalents.get('বাসা')).toEqual(expect.arrayContaining(['basa', 'house']));
  });
});

describe('parseSynonymDictionary', () => {
  it('reads groups and one-way lines, normalising terms', () => {
    expect(
      parseSynonymDictionary(
        wrap('### Heading\n- ডাক্তার, doctor\n- mistri -> plumber, electrician\ntext'),
      ),
    ).toEqual([
      { terms: ['ডাক্তার', 'doctor'], expandsTo: [] },
      { terms: ['mistri'], expandsTo: ['plumber', 'electrician'] },
    ]);
  });

  it('reports every problem at once', () => {
    const run = () =>
      parseSynonymDictionary(wrap('- Doctor, dr\n- doctor, physician\n- lonely\n- a -> \n- x, x'));
    expect(run).toThrow(SynonymDictionaryError);
    try {
      run();
    } catch (error) {
      const problems = (error as SynonymDictionaryError).problems.join('\n');
      expect(problems).toMatch(/"Doctor" must be lower-case/);
      expect(problems).toMatch(/"doctor" starts two lines/);
      expect(problems).toMatch(/needs at least two terms/);
      expect(problems).toMatch(/both sides/);
      expect(problems).toMatch(/repeated/);
    }
  });

  it('needs its markers', () => {
    expect(() => parseSynonymDictionary('- a, b')).toThrow(/markers/);
  });
});

describe('toMeilisearchSynonyms', () => {
  it('links groups both ways and one-way lines one way, merging extra groups', () => {
    const synonyms = toMeilisearchSynonyms(
      [
        { terms: ['ডাক্তার', 'doctor'], expandsTo: [] },
        { terms: ['mistri'], expandsTo: ['plumber'] },
      ],
      [['মিরপুর', 'Mirpur', 'mirpur 10']],
    );
    expect(synonyms).toEqual({
      ডাক্তার: ['doctor'],
      doctor: ['ডাক্তার'],
      mistri: ['plumber'],
      মিরপুর: ['mirpur', 'mirpur 10'],
      mirpur: ['mirpur 10', 'মিরপুর'],
      'mirpur 10': ['mirpur', 'মিরপুর'],
    });
    expect(synonyms.plumber).toBeUndefined();
  });
});
