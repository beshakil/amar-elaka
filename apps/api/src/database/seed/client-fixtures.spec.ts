import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildClientFixtures } from './client-fixtures';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');

describe('client form fixtures', () => {
  it.each(Object.entries(buildClientFixtures()))(
    '%s is up to date (run `pnpm --filter @amar-elaka/api fixtures:export`)',
    (path, expected) => {
      expect(readFileSync(join(REPO_ROOT, path), 'utf8')).toBe(expected);
    },
  );

  it('covers every issue code the clients must translate', () => {
    const cases = JSON.parse(
      buildClientFixtures()['packages/dynamic-form/fixtures/validation-cases.json']!,
    ) as {
      cases: { issues: { code: string }[] }[];
    };
    const codes = new Set(cases.cases.flatMap((c) => c.issues.map((i) => i.code)));
    expect([...codes].sort()).toEqual([
      'field.before_today',
      'field.duplicate_option',
      'field.invalid',
      'field.less_than_field',
      'field.not_an_option',
      'field.not_applicable',
      'field.not_in_schema',
      'field.out_of_range',
      'field.required',
      'field.too_long',
    ]);
  });
});
