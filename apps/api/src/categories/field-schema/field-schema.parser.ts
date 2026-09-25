import { z } from 'zod';
import { InvalidFieldSchemaException } from './field-schema.exceptions';
import type { CategoryFieldDefinition } from './field-schema.flatten';
import type { FieldSchema, UiSchema } from './field-schema.types';

/**
 * Structural parsing of the stored `json_schema` / `ui_schema` (jsonb, so
 * `unknown` until checked). Anything outside the supported subset fails
 * here; semantic rules (reserved keys, cross-references) are in
 * field-schema.publish-check.ts.
 */

const nonEmptyText = z.string().trim().min(1);
const codes = z.array(nonEmptyText).min(1);

const showWhen = z
  .object({
    field: nonEmptyText,
    in: z.array(z.union([nonEmptyText, z.boolean()])).min(1),
  })
  .strict();
/** Every property may carry a visibility rule. */
const visibility = { 'x-show-when': showWhen.optional() };

const text = z
  .object({
    ...visibility,
    'x-field-type': z.literal('text'),
    type: z.literal('string'),
    maxLength: z.number().int().positive(),
    pattern: z.string().optional(),
    format: z.literal('uri').optional(),
    'x-analytics-safe': z.boolean().optional(),
  })
  .strict();

const number = z
  .object({
    ...visibility,
    'x-field-type': z.literal('number'),
    type: z.enum(['integer', 'number']),
    minimum: z.number().finite().optional(),
    exclusiveMinimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
    'x-max-current-year-offset': z.number().int().optional(),
    'x-gte-field': nonEmptyText.optional(),
  })
  .strict();

const money = z
  .object({
    ...visibility,
    'x-field-type': z.literal('money'),
    type: z.literal('string'),
    'x-money-min': z.string().optional(),
    'x-money-max': z.string().optional(),
    'x-gte-field': nonEmptyText.optional(),
  })
  .strict();

const bool = z
  .object({ ...visibility, 'x-field-type': z.literal('bool'), type: z.literal('boolean') })
  .strict();

const select = z
  .object({
    ...visibility,
    'x-field-type': z.literal('select'),
    type: z.literal('string'),
    enum: codes,
  })
  .strict();

const multiselect = z
  .object({
    ...visibility,
    'x-field-type': z.literal('multiselect'),
    type: z.literal('array'),
    items: z.object({ type: z.literal('string'), enum: codes }).strict(),
    uniqueItems: z.literal(true),
    minItems: z.number().int().nonnegative().optional(),
  })
  .strict();

const date = z
  .object({
    ...visibility,
    'x-field-type': z.literal('date'),
    type: z.literal('string'),
    format: z.literal('date'),
    'x-not-before-today': z.boolean().optional(),
  })
  .strict();

const phone = z
  .object({ ...visibility, 'x-field-type': z.literal('phone'), type: z.literal('string') })
  .strict();

const textarea = z
  .object({
    ...visibility,
    'x-field-type': z.literal('textarea'),
    type: z.literal('string'),
    maxLength: z.number().int().positive(),
  })
  .strict();

const property = z.discriminatedUnion('x-field-type', [
  text,
  textarea,
  number,
  money,
  bool,
  select,
  multiselect,
  date,
  phone,
]);

const conditionalRule = z
  .object({
    if: z
      .object({
        properties: z.record(z.object({ enum: codes }).strict()).optional(),
        required: z.array(nonEmptyText),
      })
      .strict(),
    then: z.object({ required: z.array(nonEmptyText).min(1) }).strict(),
  })
  .strict();

const fieldSchema = z
  .object({
    type: z.literal('object'),
    additionalProperties: z.literal(false),
    properties: z.record(property),
    required: z.array(nonEmptyText),
    allOf: z.array(conditionalRule).optional(),
  })
  .strict();

const localizedText = z.object({ bn: nonEmptyText, en: nonEmptyText }).strict();

const uiSchema = z
  .object({
    order: z.array(nonEmptyText),
    card: z.array(nonEmptyText),
    hidden: z.array(nonEmptyText).optional(),
    labels: z.record(localizedText),
    options: z.record(z.record(localizedText)).optional(),
  })
  .strict();

function describe(error: z.ZodError, root: string): string[] {
  return error.issues.map((issue) => `${[root, ...issue.path].join('.')}: ${issue.message}`);
}

export function parseFieldSchema(value: unknown): FieldSchema {
  const result = fieldSchema.safeParse(value);
  if (!result.success) throw new InvalidFieldSchemaException(describe(result.error, 'json_schema'));
  return result.data;
}

export function parseUiSchema(value: unknown): UiSchema {
  const result = uiSchema.safeParse(value);
  if (!result.success) throw new InvalidFieldSchemaException(describe(result.error, 'ui_schema'));
  return result.data;
}

const fieldList = z.array(nonEmptyText);

const definitionEnvelope = z
  .object({
    jsonSchema: z.unknown(),
    uiSchema: z.unknown(),
    filterableFields: fieldList,
    searchableFields: fieldList,
    analyticsFields: fieldList,
  })
  .strict();

/** A whole definition, as authored by an admin or stored in `authored_definition`. */
export function parseFieldDefinition(value: unknown): CategoryFieldDefinition {
  const result = definitionEnvelope.safeParse(value);
  if (!result.success) throw new InvalidFieldSchemaException(describe(result.error, 'definition'));
  return {
    jsonSchema: parseFieldSchema(result.data.jsonSchema),
    uiSchema: parseUiSchema(result.data.uiSchema),
    filterableFields: result.data.filterableFields,
    searchableFields: result.data.searchableFields,
    analyticsFields: result.data.analyticsFields,
  };
}
