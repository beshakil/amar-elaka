import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { describeIssue } from './messages';
import type { CategoryFieldSchema } from './schema';
import { FIELD_ISSUES, type FieldIssue, type ValidationContext } from './validation';

const read = <T>(path: string): T =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as T;
const bn = read<{ dynamicForm: Record<string, Record<string, string>> }>('../messages/bn.json');
const en = read<{ dynamicForm: Record<string, Record<string, string>> }>('../messages/en.json');
const toLet = read<{ fieldSchema: CategoryFieldSchema }>('../fixtures/to-let.json').fieldSchema;
const rentACar = read<{ fieldSchema: CategoryFieldSchema }>(
  '../fixtures/rent-a-car.json',
).fieldSchema;
const { cases } = read<{ cases: { category: string; issues: FieldIssue[] }[] }>(
  '../fixtures/validation-cases.json',
);
const context: ValidationContext = { today: '2026-09-24', currentYear: 2026 };

const lookup = (catalog: typeof bn, id: string) => {
  const [group, key] = id.split('.') as [string, string];
  return catalog.dynamicForm[group]?.[key];
};

describe('error messages', () => {
  it('has Bengali and English text for every issue the server can report', () => {
    for (const c of cases) {
      const schema = c.category === 'to-let' ? toLet : rentACar;
      for (const issue of c.issues) {
        const { id } = describeIssue(schema, issue.field, issue.code, 'bn', context);
        expect(lookup(bn, id), `${issue.field} ${issue.code} -> ${id}`).toBeDefined();
        expect(lookup(en, id), `${issue.field} ${issue.code} -> ${id}`).toBeDefined();
      }
    }
  });

  it('bn and en define the same messages', () => {
    const keys = (catalog: typeof bn) =>
      Object.entries(catalog.dynamicForm).flatMap(([group, entries]) =>
        Object.keys(entries).map((key) => `${group}.${key}`),
      );
    expect(keys(en).sort()).toEqual(keys(bn).sort());
  });

  it('fills ranges with Bengali digits and grouped money', () => {
    expect(describeIssue(toLet, 'bedrooms', FIELD_ISSUES.outOfRange, 'bn', context)).toEqual({
      id: 'errors.rangeBetween',
      values: { min: '০', max: '২০' },
    });
    expect(describeIssue(toLet, 'price', FIELD_ISSUES.outOfRange, 'bn', context)).toEqual({
      id: 'errors.rangeBetween',
      values: { min: '৳১০০', max: '৳১,০০,০০,০০০' },
    });
    // Model year: at most next year.
    expect(describeIssue(rentACar, 'model_year', FIELD_ISSUES.outOfRange, 'bn', context)).toEqual({
      id: 'errors.rangeBetween',
      values: { min: '১৯৭০', max: '২০২৭' },
    });
    expect(describeIssue(toLet, 'total_floors', FIELD_ISSUES.lessThanField, 'bn', context)).toEqual(
      {
        id: 'errors.lessThanField',
        values: { other: 'তলা' },
      },
    );
    expect(
      describeIssue(rentACar, 'trip_types.0', FIELD_ISSUES.notAnOption, 'bn', context).id,
    ).toBe('errors.notAnOption');
  });
});
