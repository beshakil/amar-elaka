/**
 * The category field-schema format, as GET /categories and
 * GET /categories/schemas/:id serve it. It mirrors the API engine's types
 * (apps/api/src/categories/field-schema/field-schema.types.ts); the parity
 * test against fixtures/validation-cases.json keeps the two honest.
 */

export const FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'money',
  'bool',
  'select',
  'multiselect',
  'date',
  'phone',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Show the field only while `field` holds one of `in` (see visibility.ts). */
export interface ShowWhen {
  field: string;
  in: (string | boolean)[];
}

interface Base {
  'x-show-when'?: ShowWhen | undefined;
}

export interface TextProperty extends Base {
  'x-field-type': 'text';
  type: 'string';
  maxLength: number;
  pattern?: string | undefined;
  format?: 'uri' | undefined;
}
export interface TextareaProperty extends Base {
  'x-field-type': 'textarea';
  type: 'string';
  maxLength: number;
}
export interface NumberProperty extends Base {
  'x-field-type': 'number';
  type: 'integer' | 'number';
  minimum?: number | undefined;
  exclusiveMinimum?: number | undefined;
  maximum?: number | undefined;
  'x-max-current-year-offset'?: number | undefined;
  'x-gte-field'?: string | undefined;
}
export interface MoneyProperty extends Base {
  'x-field-type': 'money';
  type: 'string';
  'x-money-min'?: string | undefined;
  'x-money-max'?: string | undefined;
  'x-gte-field'?: string | undefined;
}
export interface BoolProperty extends Base {
  'x-field-type': 'bool';
  type: 'boolean';
}
export interface SelectProperty extends Base {
  'x-field-type': 'select';
  type: 'string';
  enum: string[];
}
export interface MultiselectProperty extends Base {
  'x-field-type': 'multiselect';
  type: 'array';
  items: { type: 'string'; enum: string[] };
  uniqueItems: true;
  minItems?: number | undefined;
}
export interface DateProperty extends Base {
  'x-field-type': 'date';
  type: 'string';
  format: 'date';
  'x-not-before-today'?: boolean | undefined;
}
export interface PhoneProperty extends Base {
  'x-field-type': 'phone';
  type: 'string';
}

export type FieldProperty =
  | TextProperty
  | TextareaProperty
  | NumberProperty
  | MoneyProperty
  | BoolProperty
  | SelectProperty
  | MultiselectProperty
  | DateProperty
  | PhoneProperty;

export interface ConditionalRule {
  if: { properties?: Record<string, { enum: string[] }> | undefined; required: string[] };
  then: { required: string[] };
}

export interface FieldJsonSchema {
  type: 'object';
  additionalProperties: false;
  properties: Record<string, FieldProperty>;
  required: string[];
  allOf?: ConditionalRule[] | undefined;
}

export interface LocalizedText {
  bn: string;
  en: string;
}

export interface UiSchema {
  order: string[];
  card: string[];
  hidden?: string[] | undefined;
  labels: Record<string, LocalizedText>;
  options?: Record<string, Record<string, LocalizedText>> | undefined;
}

/** One version of a category's fields (`fieldSchema` in GET /categories). */
export interface CategoryFieldSchema {
  jsonSchema: FieldJsonSchema;
  uiSchema: UiSchema;
  filterableFields: string[];
  searchableFields: string[];
}

export type Locale = 'bn' | 'en';

export type FieldValue = string | number | boolean | string[];
export type FieldValues = Record<string, FieldValue>;

/** The option codes of a select or multiselect, in schema order. */
export function optionCodes(property: FieldProperty): string[] {
  if (property['x-field-type'] === 'select') return property.enum;
  if (property['x-field-type'] === 'multiselect') return property.items.enum;
  return [];
}

/** Fields a form shows, in display order: ui order, minus ones the category hides. */
export function formFieldKeys(schema: CategoryFieldSchema): string[] {
  const hidden = new Set(schema.uiSchema.hidden ?? []);
  return schema.uiSchema.order.filter(
    (key) => schema.jsonSchema.properties[key] !== undefined && !hidden.has(key),
  );
}

export function labelOf(schema: CategoryFieldSchema, key: string, locale: Locale): string {
  return schema.uiSchema.labels[key]?.[locale] ?? key;
}

export function optionLabel(
  schema: CategoryFieldSchema,
  key: string,
  code: string,
  locale: Locale,
): string {
  return schema.uiSchema.options?.[key]?.[code]?.[locale] ?? code;
}

/** Required unconditionally, or while visible for an `x-show-when` field. */
export function isRequired(schema: CategoryFieldSchema, key: string): boolean {
  return schema.jsonSchema.required.includes(key);
}
