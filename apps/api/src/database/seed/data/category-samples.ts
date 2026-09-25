import {
  visibleFields,
  type FieldProperty,
  type FieldSchema,
  type FieldValue,
  type FieldValues,
  type FieldsValidationContext,
} from '../../../categories/field-schema';
import { intBetween, pick } from '../ids';

/**
 * Fabricated `fields` for dev posts and places: every property filled with a
 * value its schema accepts, so conditional rules are always satisfied. The
 * seed validates the result with the real validator before inserting it.
 */

const SAMPLE_SPAN = 50;
const MONEY_SAMPLE_CAP = 500000;
const SAMPLE_PHONE = '+8801711000000';

function sampleNumber(
  property: Extract<FieldProperty, { 'x-field-type': 'number' }>,
  context: FieldsValidationContext,
  rand: () => number,
): number {
  const low =
    property.minimum ??
    (property.exclusiveMinimum !== undefined ? property.exclusiveMinimum + 1 : 0);
  let high = property.maximum ?? low + SAMPLE_SPAN;
  const yearOffset = property['x-max-current-year-offset'];
  if (yearOffset !== undefined) high = Math.min(high, context.currentYear + yearOffset);
  return intBetween(Math.ceil(low), Math.floor(Math.max(low, high)), rand);
}

function sampleMoney(
  property: Extract<FieldProperty, { 'x-field-type': 'money' }>,
  rand: () => number,
): string {
  const min = Math.ceil(Number(property['x-money-min'] ?? '0'));
  const max = Math.floor(
    Math.min(Number(property['x-money-max'] ?? `${MONEY_SAMPLE_CAP}`), min + MONEY_SAMPLE_CAP),
  );
  return `${intBetween(min, Math.max(min, max), rand)}.00`;
}

function sampleDate(context: FieldsValidationContext, rand: () => number): string {
  const day = new Date(`${context.today}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + intBetween(1, 30, rand));
  return day.toISOString().slice(0, 10);
}

function sampleValue(
  key: string,
  property: FieldProperty,
  context: FieldsValidationContext,
  rand: () => number,
  label: string,
): FieldValue | undefined {
  switch (property['x-field-type']) {
    case 'text':
      // Pattern- and URL-constrained text is left out unless required.
      if (property.pattern !== undefined || property.format !== undefined) return undefined;
      return `${label} ${key}`.slice(0, property.maxLength);
    case 'textarea':
      return `${label} ${key}`.slice(0, property.maxLength);
    case 'number':
      return sampleNumber(property, context, rand);
    case 'money':
      return sampleMoney(property, rand);
    case 'bool':
      return rand() > 0.5;
    case 'select':
      return pick(property.enum, rand);
    case 'multiselect': {
      const first = pick(property.items.enum, rand);
      const second = pick(property.items.enum, rand);
      return first === second ? [first] : [first, second];
    }
    case 'date':
      return sampleDate(context, rand);
    case 'phone':
      return SAMPLE_PHONE;
  }
}

export function sampleFields(
  schema: FieldSchema,
  context: FieldsValidationContext,
  rand: () => number,
  label: string,
): FieldValues {
  const values: FieldValues = {};
  for (const [key, property] of Object.entries(schema.properties)) {
    const value = sampleValue(key, property, context, rand, label);
    if (value !== undefined) values[key] = value;
  }
  // Hidden conditional fields must be absent (x-show-when).
  const visible = visibleFields(schema, values);
  for (const key of Object.keys(values)) if (!visible.has(key)) delete values[key];

  // Satisfy "≥ other field" rules by lifting the dependent value.
  for (const [key, property] of Object.entries(schema.properties)) {
    if (property['x-field-type'] !== 'number' && property['x-field-type'] !== 'money') continue;
    const other = property['x-gte-field'];
    const value = values[key];
    const otherValue = other === undefined ? undefined : values[other];
    if (typeof value === 'number' && typeof otherValue === 'number' && value < otherValue) {
      values[key] = otherValue;
    }
    if (
      typeof value === 'string' &&
      typeof otherValue === 'string' &&
      Number(value) < Number(otherValue)
    ) {
      values[key] = otherValue;
    }
  }
  return values;
}
