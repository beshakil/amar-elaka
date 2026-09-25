import { formatMoney, formatNumber } from './numerals';
import type { CategoryFieldSchema, Locale } from './schema';
import { labelOf } from './schema';
import { FIELD_ISSUES, type ValidationContext } from './validation';

/**
 * Issue code + the field's rules -> a message id and its parameters, formatted
 * for the locale (Bengali digits, grouped money). The text itself lives in
 * messages/bn.json and messages/en.json under `dynamicForm.errors` (CLAUDE.md
 * rule 6); this only decides *which* message and fills in the numbers the
 * user needs ("২০-এর বেশি নয়", "৳১০০ থেকে ৳১,০০,০০,০০০").
 */

export interface MessageRef {
  /** Key under `dynamicForm` in messages/*.json, e.g. `errors.rangeBetween`. */
  id: string;
  values: Record<string, string>;
}

export function describeIssue(
  schema: CategoryFieldSchema,
  field: string,
  code: string,
  locale: Locale,
  context: ValidationContext,
): MessageRef {
  // `trip_types.0` -> the multiselect `trip_types`.
  const key = field.split('.')[0] ?? field;
  const property = schema.jsonSchema.properties[key];
  const ref = (id: string, values: Record<string, string> = {}): MessageRef => ({
    id: `errors.${id}`,
    values,
  });
  if (property === undefined) return ref('notInSchema');
  const type = property['x-field-type'];
  const money = (value: string) => `৳${formatMoney(value, locale)}`;
  const num = (value: number) => formatNumber(value, locale);

  switch (code) {
    case FIELD_ISSUES.required:
      if (type === 'date') return ref('requiredDate');
      return ref(
        type === 'select' || type === 'multiselect' || type === 'bool'
          ? 'requiredChoice'
          : 'required',
      );
    case FIELD_ISSUES.invalid:
      switch (type) {
        case 'number':
          return ref(property.type === 'integer' ? 'invalidInteger' : 'invalidNumber');
        case 'money':
          return ref('invalidMoney');
        case 'date':
          return ref('invalidDate');
        case 'phone':
          return ref('invalidPhone');
        case 'text':
          return ref(property.format === 'uri' ? 'invalidUrl' : 'invalidFormat');
        default:
          return ref('invalid');
      }
    case FIELD_ISSUES.tooLong:
      return ref('tooLong', {
        max: 'maxLength' in property ? num(property.maxLength) : '',
      });
    case FIELD_ISSUES.outOfRange: {
      if (type === 'money') {
        const min = property['x-money-min'];
        const max = property['x-money-max'];
        if (min !== undefined && max !== undefined) {
          return ref('rangeBetween', { min: money(min), max: money(max) });
        }
        if (min !== undefined) return ref('rangeMin', { min: money(min) });
        if (max !== undefined) return ref('rangeMax', { max: money(max) });
        return ref('invalidMoney');
      }
      if (type === 'number') {
        const yearOffset = property['x-max-current-year-offset'];
        const maxima = [
          property.maximum,
          yearOffset === undefined ? undefined : context.currentYear + yearOffset,
        ].filter((v): v is number => v !== undefined);
        const max = maxima.length > 0 ? Math.min(...maxima) : undefined;
        if (property.exclusiveMinimum !== undefined) {
          return ref('rangeAbove', { min: num(property.exclusiveMinimum) });
        }
        if (property.minimum !== undefined && max !== undefined) {
          return ref('rangeBetween', { min: num(property.minimum), max: num(max) });
        }
        if (property.minimum !== undefined) return ref('rangeMin', { min: num(property.minimum) });
        if (max !== undefined) return ref('rangeMax', { max: num(max) });
      }
      return ref('invalid');
    }
    case FIELD_ISSUES.notAnOption:
      return ref('notAnOption');
    case FIELD_ISSUES.duplicate:
      return ref('duplicateOption');
    case FIELD_ISSUES.beforeToday:
      return ref('beforeToday');
    case FIELD_ISSUES.lessThanField: {
      const other = 'x-gte-field' in property ? property['x-gte-field'] : undefined;
      return ref('lessThanField', { other: other ? labelOf(schema, other, locale) : '' });
    }
    case FIELD_ISSUES.notApplicable:
      return ref('notApplicable');
    case FIELD_ISSUES.notInSchema:
      return ref('notInSchema');
    default:
      return ref('invalid');
  }
}
