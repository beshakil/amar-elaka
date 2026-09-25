/**
 * The JSON Schema subset stored in `category_field_schemas.json_schema`
 * (docs/specs/categories.md §3.2, docs/specs/schema.md §3.4).
 *
 * Every property names its spec type in `x-field-type`, so the converter
 * never has to guess from the JSON Schema keywords. Money is a string with
 * two decimals (§0.2); its bounds are strings too, in `x-money-min` /
 * `x-money-max`, because `minimum` only applies to JSON numbers.
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

/**
 * Conditional visibility: the field exists only while `field` holds one of
 * `in` (for a multiselect controller, any of them). A hidden field must be
 * absent from the payload, and a field listed in `required` is required
 * only while it is visible. The controller must be a select, multiselect or
 * bool field; chains are allowed (a hidden controller hides its dependants).
 */
export interface ShowWhen {
  field: string;
  in: (string | boolean)[];
}

interface BaseProperty {
  'x-field-type': FieldType;
  'x-show-when'?: ShowWhen | undefined;
}

export interface TextProperty extends BaseProperty {
  'x-field-type': 'text';
  type: 'string';
  maxLength: number;
  pattern?: string | undefined;
  format?: 'uri' | undefined;
  /** Short, non-identifying text (brand, model) that may be kept after a scrub. */
  'x-analytics-safe'?: boolean | undefined;
}

/** Multi-line free text (descriptions, menus). Same rules as text; never analytics-safe. */
export interface TextareaProperty extends BaseProperty {
  'x-field-type': 'textarea';
  type: 'string';
  maxLength: number;
}

export interface NumberProperty extends BaseProperty {
  'x-field-type': 'number';
  type: 'integer' | 'number';
  minimum?: number | undefined;
  /** Strictly greater than, for "> 0" quantities. */
  exclusiveMinimum?: number | undefined;
  maximum?: number | undefined;
  /** Upper bound = the current year + this offset (model years). */
  'x-max-current-year-offset'?: number | undefined;
  /** Must be ≥ the value of this sibling field when both are present. */
  'x-gte-field'?: string | undefined;
}

export interface MoneyProperty extends BaseProperty {
  'x-field-type': 'money';
  type: 'string';
  'x-money-min'?: string | undefined;
  'x-money-max'?: string | undefined;
  'x-gte-field'?: string | undefined;
}

export interface BoolProperty extends BaseProperty {
  'x-field-type': 'bool';
  type: 'boolean';
}

export interface SelectProperty extends BaseProperty {
  'x-field-type': 'select';
  type: 'string';
  enum: string[];
}

export interface MultiselectProperty extends BaseProperty {
  'x-field-type': 'multiselect';
  type: 'array';
  items: { type: 'string'; enum: string[] };
  uniqueItems: true;
  minItems?: number | undefined;
}

export interface DateProperty extends BaseProperty {
  'x-field-type': 'date';
  type: 'string';
  format: 'date';
  /** Rejects a Dhaka calendar day before today. */
  'x-not-before-today'?: boolean | undefined;
}

export interface PhoneProperty extends BaseProperty {
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

/**
 * Conditional required fields: when `if` matches, `then.required` applies.
 * `if` either restricts one field to some values, or requires fields to be
 * present ("req if salary set").
 */
export interface ConditionalRule {
  if: {
    properties?: Record<string, { enum: string[] }> | undefined;
    required: string[];
  };
  then: { required: string[] };
}

export interface FieldSchema {
  type: 'object';
  additionalProperties: false;
  properties: Record<string, FieldProperty>;
  required: string[];
  allOf?: ConditionalRule[] | undefined;
}

/** Per-locale literal text. Category schemas are DB content (schema.md §13.12). */
export interface LocalizedText {
  bn: string;
  en: string;
}

/** `category_field_schemas.ui_schema`: presentation only, never validation. */
export interface UiSchema {
  order: string[];
  /** Fields shown on the list card, in order (categories.md §3.3 "C"). */
  card: string[];
  /** Inherited fields a child hides from its form. */
  hidden?: string[] | undefined;
  labels: Record<string, LocalizedText>;
  options?: Record<string, Record<string, LocalizedText>> | undefined;
}

/** Keys the posts table turns into generated columns (schema.md §4.2). */
export const RESERVED_FIELD_TYPES: Readonly<Record<string, FieldProperty['type'] | 'money'>> = {
  price: 'money',
  bedrooms: 'integer',
  seats: 'integer',
  area: 'number',
};
