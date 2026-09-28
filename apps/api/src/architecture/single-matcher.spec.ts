import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import 'reflect-metadata';
import { SavedSearchMatcherService } from '../saved-searches/matching/saved-search-matcher.service';
import { SearchCriteriaService } from '../search/query/search-criteria.service';
import { SearchMatcher } from '../search/query/search-matcher';
import { SearchService } from '../search/query/search.service';

/**
 * ADR 041: there is exactly one implementation of "does this post match
 * these filters" for search and saved searches — SearchMatcher, over the
 * criteria SearchCriteriaService builds. This fails if a second one appears:
 *
 *  - the engine filter is compiled (buildSearchFilter) only in SearchMatcher;
 *  - saved-search code never compiles filters, parses field filters, calls
 *    the engine, or uses the SQL field-filter evaluators itself;
 *  - both SearchService and the saved-search matcher depend on SearchMatcher
 *    and SearchCriteriaService.
 */

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

const rel = (path: string) => relative(SRC, path).split(sep).join('/');

describe('One matcher for search and saved searches (ADR 041)', () => {
  const files = sourceFiles(SRC).map((path) => ({
    file: rel(path),
    text: readFileSync(path, 'utf8'),
  }));

  it('compiles engine filters only in SearchMatcher', () => {
    const callers = files
      .filter(({ text }) => /\bbuildSearchFilter\(/.test(text))
      .map(({ file }) => file)
      .filter((file) => file !== 'search/query/filter-builder.ts');
    expect(callers).toEqual(['search/query/search-matcher.ts']);
  });

  it('keeps every filter evaluator out of saved-search code', () => {
    const forbidden = [
      /filter-builder/,
      /post-field-filters/,
      /post_field_filter_matches/,
      /\bparseFieldFilters\b/,
      /\bfieldFilterExpression\b/,
      /\bSEARCH_ENGINE\b/,
      /\.multiSearch\(|engine\.search\(/,
    ];
    const offenders = files
      .filter(({ file }) => file.startsWith('saved-searches/'))
      .flatMap(({ file, text }) =>
        forbidden.filter((pattern) => pattern.test(text)).map((pattern) => `${file}: ${pattern}`),
      );
    expect(offenders).toEqual([]);
  });

  it('wires the same SearchMatcher and SearchCriteriaService into both', () => {
    const depsOf = (type: object) =>
      (Reflect.getMetadata('design:paramtypes', type) as unknown[] | undefined) ?? [];
    for (const consumer of [SearchService, SavedSearchMatcherService]) {
      expect(depsOf(consumer)).toEqual(
        expect.arrayContaining([SearchMatcher, SearchCriteriaService]),
      );
    }
  });
});
