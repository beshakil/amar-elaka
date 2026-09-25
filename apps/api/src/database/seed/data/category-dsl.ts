import {
  resolveFieldDefinition,
  type CategoryFieldDefinition,
  type ConditionalRule,
  type FieldProperty,
  type LocalizedText,
  type UiSchema,
} from '../../../categories/field-schema';

/**
 * A compact way to write docs/specs/categories.md §5 as data: one `field()`
 * per table row, with the F/S/C/A flags copied from the spec. `definitionOf`
 * turns a category into the exact rows the seed stores in
 * `category_field_schemas`, parent fields already merged (§13.13).
 */

export type CategoryKind = 'marketplace' | 'rental' | 'job' | 'service' | 'place' | 'module';
export type ModuleCode = 'emergency' | 'blood' | 'bazar';

/** Informational only, not a DB column (categories.md §3.6). */
export type MonetizationMode = 'subscription' | 'boost' | 'per_listing' | 'lead_fee' | 'free';

export type Option = readonly [code: string, bn: string, en: string];

interface BuiltProperty {
  property: FieldProperty;
  options?: readonly Option[];
}

export interface FieldSpec extends BuiltProperty {
  key: string;
  label: LocalizedText;
  required: boolean;
  /** Any of F (filterable), S (searchable), C (list card), A (analytics). */
  flags: string;
}

export interface CategoryDef {
  slug: string;
  kind: CategoryKind;
  moduleCode?: ModuleCode;
  parent?: string;
  nameBn: string;
  nameEn: string;
  icon: string;
  costCredits: number;
  moderationMode: 'pre' | null;
  monetizationMode: MonetizationMode;
  /** NULL for places and modules; they never expire. */
  expiryDays: number | null;
  phase1: boolean;
  fields: FieldSpec[];
  conditions?: ConditionalRule[];
  /** Inherited fields the child hides from its form. */
  hidden?: string[];
  /** List-card fields when they include inherited ones; default = own C flags. */
  card?: string[];
  /**
   * Conditional fields (`x-show-when`): key -> the controlling field and the
   * values that show it. `required: true` makes the field required while shown.
   */
  visibility?: Record<string, { field: string; in: (string | boolean)[]; required?: boolean }>;
}

export type SeedFieldDefinition = CategoryFieldDefinition;

// ---- property builders ------------------------------------------------------

export const text = (
  maxLength: number,
  extra: { pattern?: string; format?: 'uri' } = {},
): BuiltProperty => ({
  property: { 'x-field-type': 'text', type: 'string', maxLength, ...extra },
});

/** Multi-line free text; never filterable or analytics-safe. */
export const textarea = (maxLength: number): BuiltProperty => ({
  property: { 'x-field-type': 'textarea', type: 'string', maxLength },
});

interface NumberExtra {
  exclusiveMinimum?: number;
  yearOffset?: number;
  gte?: string;
}

function numeric(
  type: 'integer' | 'number',
  minimum?: number,
  maximum?: number,
  extra: NumberExtra = {},
) {
  return {
    property: {
      'x-field-type': 'number',
      type,
      ...(minimum !== undefined ? { minimum } : {}),
      ...(maximum !== undefined ? { maximum } : {}),
      ...(extra.exclusiveMinimum !== undefined ? { exclusiveMinimum: extra.exclusiveMinimum } : {}),
      ...(extra.yearOffset !== undefined ? { 'x-max-current-year-offset': extra.yearOffset } : {}),
      ...(extra.gte !== undefined ? { 'x-gte-field': extra.gte } : {}),
    },
  } satisfies BuiltProperty;
}

export const int = (minimum?: number, maximum?: number, extra: NumberExtra = {}): BuiltProperty =>
  numeric('integer', minimum, maximum, extra);

export const num = (minimum?: number, maximum?: number, extra: NumberExtra = {}): BuiltProperty =>
  numeric('number', minimum, maximum, extra);

export const money = (min: string, max: string, extra: { gte?: string } = {}): BuiltProperty => ({
  property: {
    'x-field-type': 'money',
    type: 'string',
    'x-money-min': min,
    'x-money-max': max,
    ...(extra.gte !== undefined ? { 'x-gte-field': extra.gte } : {}),
  },
});

export const bool = (): BuiltProperty => ({
  property: { 'x-field-type': 'bool', type: 'boolean' },
});

export const select = (options: readonly Option[]): BuiltProperty => ({
  property: { 'x-field-type': 'select', type: 'string', enum: options.map(([code]) => code) },
  options,
});

export const multi = (options: readonly Option[], minItems?: number): BuiltProperty => ({
  property: {
    'x-field-type': 'multiselect',
    type: 'array',
    items: { type: 'string', enum: options.map(([code]) => code) },
    uniqueItems: true,
    ...(minItems !== undefined ? { minItems } : {}),
  },
  options,
});

export const date = (notBeforeToday = false): BuiltProperty => ({
  property: {
    'x-field-type': 'date',
    type: 'string',
    format: 'date',
    ...(notBeforeToday ? { 'x-not-before-today': true } : {}),
  },
});

export const phone = (): BuiltProperty => ({
  property: { 'x-field-type': 'phone', type: 'string' },
});

export const REQ = true;

export function field(
  key: string,
  [bn, en]: readonly [string, string],
  built: BuiltProperty,
  flags = '',
  required = false,
): FieldSpec {
  // A text field in the scrub whitelist is declared safe to keep (§13.31).
  const property: FieldProperty =
    built.property['x-field-type'] === 'text' && flags.includes('A')
      ? { ...built.property, 'x-analytics-safe': true }
      : built.property;
  return {
    key,
    label: { bn, en },
    property,
    ...(built.options ? { options: built.options } : {}),
    required,
    flags,
  };
}

/** `then` fields are required when `key` has one of `values`. */
export const when = (key: string, values: string[], then: string[]): ConditionalRule => ({
  if: { properties: { [key]: { enum: values } }, required: [key] },
  then: { required: then },
});

/** `then` fields are required once all `present` fields are filled in. */
export const whenPresent = (present: string[], then: string[]): ConditionalRule => ({
  if: { required: present },
  then: { required: then },
});

// ---- definitions ------------------------------------------------------------

function flagged(fields: FieldSpec[], flag: string): string[] {
  return fields.filter((f) => f.flags.includes(flag)).map((f) => f.key);
}

/** What an admin would author for this category: its own fields only. */
export function authoredDefinitionOf(def: CategoryDef): SeedFieldDefinition {
  const uiSchema: UiSchema = {
    order: def.fields.map((f) => f.key),
    card: def.card ?? flagged(def.fields, 'C'),
    labels: Object.fromEntries(def.fields.map((f) => [f.key, f.label])),
    options: Object.fromEntries(
      def.fields
        .filter((f) => f.options)
        .map((f) => [
          f.key,
          Object.fromEntries(f.options!.map(([code, bn, en]) => [code, { bn, en }])),
        ]),
    ),
    ...(def.hidden ? { hidden: def.hidden } : {}),
  };
  const visibility = def.visibility ?? {};
  for (const key of Object.keys(visibility)) {
    if (!def.fields.some((f) => f.key === key)) {
      throw new Error(`category ${def.slug}: visibility for unknown field ${key}`);
    }
  }
  const propertyOf = (f: FieldSpec): FieldProperty => {
    const rule = visibility[f.key];
    return rule ? { ...f.property, 'x-show-when': { field: rule.field, in: rule.in } } : f.property;
  };
  return {
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(def.fields.map((f) => [f.key, propertyOf(f)])),
      required: def.fields
        .filter((f) => f.required || visibility[f.key]?.required === true)
        .map((f) => f.key),
      ...(def.conditions ? { allOf: def.conditions } : {}),
    },
    uiSchema,
    filterableFields: flagged(def.fields, 'F'),
    searchableFields: flagged(def.fields, 'S'),
    analyticsFields: flagged(def.fields, 'A'),
  };
}

/** The published definition: own fields, or parent + child flattened (same code path as the API). */
export function definitionOf(def: CategoryDef, all: readonly CategoryDef[]): SeedFieldDefinition {
  const parentDef = def.parent === undefined ? undefined : all.find((c) => c.slug === def.parent);
  if (def.parent !== undefined && !parentDef) {
    throw new Error(`category ${def.slug}: unknown parent ${def.parent}`);
  }
  return resolveFieldDefinition(
    authoredDefinitionOf(def),
    parentDef ? definitionOf(parentDef, all) : undefined,
  );
}
