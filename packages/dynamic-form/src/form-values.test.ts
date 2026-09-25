import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildFormSchema,
  formStateIssues,
  formStateToValues,
  valuesToFormState,
} from './form-values';
import type { CategoryFieldSchema } from './schema';
import { fieldIssuesOf, type ValidationContext } from './validation';

const toLet = (
  JSON.parse(readFileSync(new URL('../fixtures/to-let.json', import.meta.url), 'utf8')) as {
    fieldSchema: CategoryFieldSchema;
  }
).fieldSchema;
const context: ValidationContext = { today: '2026-09-24', currentYear: 2026 };

describe('form state <-> API values', () => {
  it('parses Bengali input, drops empty fields and hidden conditional ones', () => {
    expect(
      formStateToValues(toLet.jsonSchema, {
        property_type: 'shop',
        bedrooms: '৩', // hidden for a shop
        floor: '২',
        price: '১৫,০০০',
        available_from: '2026-10-01',
        bathrooms: '',
        has_lift: true,
      }),
    ).toEqual({
      property_type: 'shop',
      floor: 2,
      price: '15000.00',
      available_from: '2026-10-01',
      has_lift: true,
    });
  });

  it('keeps unparseable input so it is reported as invalid, like the server would', () => {
    const result = buildFormSchema(toLet.jsonSchema, context).safeParse({
      property_type: 'flat',
      tenant_type: 'family',
      bedrooms: 'তিন',
      price: '15,000/-',
      available_from: '2026-10-01',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(fieldIssuesOf(result.error)).toEqual([
        { field: 'bedrooms', code: 'field.invalid' },
        { field: 'price', code: 'field.invalid' },
      ]);
    }
  });

  it('shows stored values with Bengali digits and grouped money', () => {
    expect(
      valuesToFormState(toLet, { bedrooms: 3, price: '1234567.00', property_type: 'flat' }, 'bn'),
    ).toEqual({ bedrooms: '৩', price: '১২,৩৪,৫৬৭', property_type: 'flat' });
  });

  it('shows every missing field at once, including required-while-shown ones', () => {
    // The empty required date is a type problem, so zod alone would not yet
    // report the flat's bedrooms and tenant type.
    const issues = formStateIssues(
      toLet.jsonSchema,
      { property_type: 'flat', price: '৯০০০' },
      context,
    );
    expect(issues.map((i) => `${i.field}:${i.code}`).sort()).toEqual([
      'available_from:field.required',
      'bedrooms:field.required',
      'tenant_type:field.required',
    ]);
  });
});
