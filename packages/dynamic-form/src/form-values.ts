import { z } from 'zod';
import {
  formatMoney,
  localizeDigits,
  normalizePhoneInput,
  parseMoneyInput,
  parseNumberInput,
} from './numerals';
import type { CategoryFieldSchema, FieldJsonSchema, FieldValues, Locale } from './schema';
import {
  buildFieldsSchema,
  formFieldIssues,
  visibleFields,
  type FieldIssue,
  type ValidationContext,
} from './validation';

/**
 * What a form holds is what the user typed: strings in either digit script
 * for numbers, money and phones. `formStateToValues` turns that into the
 * API's values (Latin digits, numbers, "15000.00"), leaves anything
 * unparseable as the raw string so the validator reports it as
 * `field.invalid` (exactly what the server would), and drops empty and
 * hidden fields, so a hidden field is never submitted.
 */

export type FormFieldState = string | boolean | string[] | undefined;
export type FormState = Record<string, FormFieldState>;

export function formStateToValues(schema: FieldJsonSchema, state: FormState): FieldValues {
  const values: FieldValues = {};
  for (const [key, property] of Object.entries(schema.properties)) {
    const raw = state[key];
    if (raw === undefined || raw === '' || (Array.isArray(raw) && raw.length === 0)) continue;

    switch (property['x-field-type']) {
      case 'number': {
        const parsed = typeof raw === 'string' ? parseNumberInput(raw) : Number.NaN;
        values[key] = Number.isNaN(parsed) ? String(raw) : parsed;
        break;
      }
      case 'money':
        values[key] = typeof raw === 'string' ? (parseMoneyInput(raw) ?? raw) : String(raw);
        break;
      case 'phone':
        values[key] = typeof raw === 'string' ? normalizePhoneInput(raw) : String(raw);
        break;
      default:
        values[key] = raw;
    }
  }

  const visible = visibleFields(schema, values);
  for (const key of Object.keys(values)) if (!visible.has(key)) delete values[key];
  return values;
}

/** API values -> what the form shows (Bengali digits, grouped money, local phone format). */
export function valuesToFormState(
  schema: CategoryFieldSchema,
  values: FieldValues,
  locale: Locale,
): FormState {
  const state: FormState = {};
  for (const [key, value] of Object.entries(values)) {
    const property = schema.jsonSchema.properties[key];
    if (property === undefined) continue;
    switch (property['x-field-type']) {
      case 'number':
        state[key] = localizeDigits(String(value), locale);
        break;
      case 'money':
        state[key] = typeof value === 'string' ? formatMoney(value, locale) : String(value);
        break;
      case 'phone':
        state[key] = localizeDigits(String(value).replace(/^\+88/, ''), locale);
        break;
      default:
        state[key] = typeof value === 'number' ? String(value) : value;
    }
  }
  return state;
}

/**
 * The runtime zod schema a react-hook-form resolver uses: form state in,
 * validated API values out.
 */
export function buildFormSchema(
  schema: FieldJsonSchema,
  context: ValidationContext,
): z.ZodType<FieldValues, z.ZodTypeDef, FormState> {
  return z.preprocess(
    (state) => formStateToValues(schema, (state ?? {}) as FormState),
    buildFieldsSchema(schema, context),
  ) as unknown as z.ZodType<FieldValues, z.ZodTypeDef, FormState>;
}

/** Every issue a form should show for this state (see formFieldIssues). */
export function formStateIssues(
  schema: FieldJsonSchema,
  state: FormState,
  context: ValidationContext,
): FieldIssue[] {
  return formFieldIssues(schema, formStateToValues(schema, state), context);
}
