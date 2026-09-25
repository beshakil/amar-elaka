import { z } from 'zod';
import type {
  ConditionalRule,
  DateProperty,
  FieldProperty,
  FieldSchema,
  MoneyProperty,
  MultiselectProperty,
  NumberProperty,
  SelectProperty,
  TextareaProperty,
  TextProperty,
} from './field-schema.types';
import { MONEY_PATTERN, toPoisha } from './money';

/**
 * JSON Schema (the supported subset) -> zod, for the mandatory server-side
 * validation of `posts.fields` / `places.fields` against the pinned schema
 * version (schema.md §4.2, §13.13).
 *
 * Issue messages are stable codes, not sentences (CLAUDE.md rule 6): clients
 * translate them, and the offending field is the issue path.
 */

export const FIELD_ISSUES = {
  required: 'field.required',
  invalid: 'field.invalid',
  tooLong: 'field.too_long',
  outOfRange: 'field.out_of_range',
  notAnOption: 'field.not_an_option',
  duplicate: 'field.duplicate_option',
  beforeToday: 'field.before_today',
  lessThanField: 'field.less_than_field',
  notInSchema: 'field.not_in_schema',
  notApplicable: 'field.not_applicable',
} as const;

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** E.164 Bangladesh, landlines included (categories.md §3.2). */
const BD_PHONE_PATTERN = /^\+880\d{7,10}$/;

export type FieldValue = string | number | boolean | string[];
export type FieldValues = Record<string, FieldValue>;

export interface FieldsValidationContext {
  /** Today as a Dhaka calendar day, `YYYY-MM-DD` (§13.15). */
  today: string;
  /** The current year in Asia/Dhaka. */
  currentYear: number;
}

/** The calendar day and year at `now` in the tenant's timezone (`tenants.timezone`). */
export function validationContextAt(now: Date, timeZone: string): FieldsValidationContext {
  // en-CA formats as YYYY-MM-DD.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
  const year = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric' }).format(now);
  return { today, currentYear: Number(year) };
}

const typeErrors = {
  required_error: FIELD_ISSUES.required,
  invalid_type_error: FIELD_ISSUES.invalid,
};

function textValidator(property: TextProperty): z.ZodTypeAny {
  let schema = z
    .string(typeErrors)
    .trim()
    .min(1, FIELD_ISSUES.required)
    .max(property.maxLength, FIELD_ISSUES.tooLong);
  if (property.pattern) schema = schema.regex(new RegExp(property.pattern), FIELD_ISSUES.invalid);
  if (property.format === 'uri') {
    schema = schema.url(FIELD_ISSUES.invalid).startsWith('https://', FIELD_ISSUES.invalid);
  }
  return schema;
}

function textareaValidator(property: TextareaProperty): z.ZodTypeAny {
  return z
    .string(typeErrors)
    .trim()
    .min(1, FIELD_ISSUES.required)
    .max(property.maxLength, FIELD_ISSUES.tooLong);
}

function numberValidator(property: NumberProperty, context: FieldsValidationContext): z.ZodTypeAny {
  let schema = z.number(typeErrors).finite(FIELD_ISSUES.invalid);
  if (property.type === 'integer') schema = schema.int(FIELD_ISSUES.invalid);
  if (property.minimum !== undefined)
    schema = schema.gte(property.minimum, FIELD_ISSUES.outOfRange);
  if (property.exclusiveMinimum !== undefined) {
    schema = schema.gt(property.exclusiveMinimum, FIELD_ISSUES.outOfRange);
  }
  if (property.maximum !== undefined)
    schema = schema.lte(property.maximum, FIELD_ISSUES.outOfRange);
  const yearOffset = property['x-max-current-year-offset'];
  if (yearOffset !== undefined) {
    schema = schema.lte(context.currentYear + yearOffset, FIELD_ISSUES.outOfRange);
  }
  return schema;
}

/**
 * Zod keeps running refinements after a failed check, so each validator below
 * that parses its input (money, dates) does all its checks in one pass and
 * stops at the first failure.
 */
function moneyValidator(property: MoneyProperty): z.ZodTypeAny {
  const min = property['x-money-min'];
  const max = property['x-money-max'];
  return z.string(typeErrors).superRefine((value, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (!MONEY_PATTERN.test(value)) return fail(FIELD_ISSUES.invalid);
    const poisha = toPoisha(value);
    if (
      (min !== undefined && poisha < toPoisha(min)) ||
      (max !== undefined && poisha > toPoisha(max))
    ) {
      fail(FIELD_ISSUES.outOfRange);
    }
  });
}

function selectValidator(property: SelectProperty): z.ZodTypeAny {
  const options = new Set(property.enum);
  return z.string(typeErrors).refine((value) => options.has(value), FIELD_ISSUES.notAnOption);
}

function multiselectValidator(property: MultiselectProperty): z.ZodTypeAny {
  const options = new Set(property.items.enum);
  return z
    .array(
      z.string(typeErrors).refine((value) => options.has(value), FIELD_ISSUES.notAnOption),
      typeErrors,
    )
    .min(property.minItems ?? 0, FIELD_ISSUES.required)
    .refine((values) => new Set(values).size === values.length, FIELD_ISSUES.duplicate);
}

export function isCalendarDay(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  // Rejects 2026-02-30, which Date would silently roll over into March.
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

function dateValidator(property: DateProperty, context: FieldsValidationContext): z.ZodTypeAny {
  return z.string(typeErrors).superRefine((value, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (!DATE_PATTERN.test(value) || !isCalendarDay(value)) return fail(FIELD_ISSUES.invalid);
    // ISO calendar days compare correctly as strings.
    if (property['x-not-before-today'] && value < context.today) fail(FIELD_ISSUES.beforeToday);
  });
}

function propertyValidator(
  property: FieldProperty,
  context: FieldsValidationContext,
): z.ZodTypeAny {
  switch (property['x-field-type']) {
    case 'text':
      return textValidator(property);
    case 'textarea':
      return textareaValidator(property);
    case 'number':
      return numberValidator(property, context);
    case 'money':
      return moneyValidator(property);
    case 'bool':
      return z.boolean(typeErrors);
    case 'select':
      return selectValidator(property);
    case 'multiselect':
      return multiselectValidator(property);
    case 'date':
      return dateValidator(property, context);
    case 'phone':
      return z.string(typeErrors).regex(BD_PHONE_PATTERN, FIELD_ISSUES.invalid);
  }
}

/**
 * The fields visible for these values (`x-show-when`, field-schema.types.ts).
 * A field is visible when it has no rule, or when its controller is itself
 * visible and holds one of the listed values. Cycles are rejected at publish
 * time; the `visiting` guard only keeps a bad schema from recursing forever.
 */
export function visibleFields(
  schema: FieldSchema,
  values: Readonly<Record<string, unknown>>,
): Set<string> {
  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();
  const isVisible = (key: string): boolean => {
    const known = memo.get(key);
    if (known !== undefined) return known;
    const rule = schema.properties[key]?.['x-show-when'];
    let visible = true;
    if (rule !== undefined) {
      if (visiting.has(key)) return false;
      visiting.add(key);
      const value = values[rule.field];
      const matches = Array.isArray(value)
        ? value.some((item) => rule.in.includes(item as string))
        : (typeof value === 'string' || typeof value === 'boolean') && rule.in.includes(value);
      visible = matches && isVisible(rule.field);
      visiting.delete(key);
    }
    memo.set(key, visible);
    return visible;
  };
  return new Set(Object.keys(schema.properties).filter(isVisible));
}

function ruleApplies(rule: ConditionalRule, values: FieldValues): boolean {
  const present = rule.if.required.every((key) => values[key] !== undefined);
  const matches = Object.entries(rule.if.properties ?? {}).every(([key, condition]) => {
    const value = values[key];
    return typeof value === 'string' && condition.enum.includes(value);
  });
  return present && matches;
}

function compare(property: FieldProperty, left: FieldValue, right: FieldValue): number | undefined {
  if (property['x-field-type'] === 'money') {
    // A malformed amount already has its own issue; don't compare it.
    if (typeof left !== 'string' || typeof right !== 'string') return undefined;
    if (!MONEY_PATTERN.test(left) || !MONEY_PATTERN.test(right)) return undefined;
    const difference = toPoisha(left) - toPoisha(right);
    return difference === BigInt(0) ? 0 : difference > BigInt(0) ? 1 : -1;
  }
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return undefined;
}

/**
 * Builds the validator for one schema version. Unknown keys are rejected
 * (`additionalProperties: false`); optional fields may be omitted but never
 * sent as null.
 */
export function compileFieldsValidator(
  schema: FieldSchema,
  context: FieldsValidationContext,
): z.ZodType<FieldValues> {
  const required = new Set(schema.required);
  const conditional = Object.keys(schema.properties).filter(
    (key) => schema.properties[key]!['x-show-when'] !== undefined,
  );
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, property] of Object.entries(schema.properties)) {
    const validator = propertyValidator(property, context);
    // A conditional field's "required" only applies while it is visible (checked below).
    const alwaysRequired = required.has(key) && property['x-show-when'] === undefined;
    shape[key] = alwaysRequired ? validator : validator.optional();
  }

  return z
    .object(shape)
    .strict(FIELD_ISSUES.notInSchema)
    .superRefine((parsed, ctx) => {
      const values: FieldValues = parsed;
      const issue = (key: string, message: string) =>
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message });

      if (conditional.length > 0) {
        const visible = visibleFields(schema, values);
        for (const key of conditional) {
          const present = values[key] !== undefined;
          if (!visible.has(key) && present) issue(key, FIELD_ISSUES.notApplicable);
          if (visible.has(key) && !present && required.has(key)) issue(key, FIELD_ISSUES.required);
        }
      }

      for (const rule of schema.allOf ?? []) {
        if (!ruleApplies(rule, values)) continue;
        for (const key of rule.then.required) {
          if (values[key] === undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key],
              message: FIELD_ISSUES.required,
            });
          }
        }
      }

      for (const [key, property] of Object.entries(schema.properties)) {
        if (property['x-field-type'] !== 'number' && property['x-field-type'] !== 'money') continue;
        const other = property['x-gte-field'];
        const value = values[key];
        const otherValue = other === undefined ? undefined : values[other];
        if (value === undefined || otherValue === undefined) continue;
        const order = compare(property, value, otherValue);
        if (order !== undefined && order < 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: FIELD_ISSUES.lessThanField,
          });
        }
      }
    });
}

export interface FieldIssueCode {
  /** The field key, `key.index` inside a multiselect, or '' for the payload itself. */
  field: string;
  code: string;
}

/** Flattens zod issues to `{ field, code }`, one entry per unknown key. */
export function fieldIssuesOf(error: z.ZodError): FieldIssueCode[] {
  return error.issues.flatMap((issue) =>
    issue.code === z.ZodIssueCode.unrecognized_keys
      ? issue.keys.map((key) => ({ field: key, code: FIELD_ISSUES.notInSchema }))
      : [{ field: issue.path.join('.'), code: issue.message }],
  );
}
