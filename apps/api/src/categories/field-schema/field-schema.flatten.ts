import { InvalidFieldSchemaException } from './field-schema.exceptions';
import type { FieldProperty, FieldSchema, UiSchema } from './field-schema.types';
import { MONEY_PATTERN, toPoisha } from './money';

/**
 * Parent fields are merged into a child when the child's schema is published,
 * so nothing resolves inheritance at request time (schema.md §13.13).
 *
 * A child may redefine an inherited field only to narrow it (categories.md
 * §3.5, change C5): a subset of options, tighter bounds, or required instead
 * of optional. Anything looser would let a child accept a value its parent
 * category's filters and analytics don't expect.
 */

/**
 * Everything a category field-schema version consists of. As authored, it
 * holds the category's own fields; resolved (flattened), it also holds every
 * inherited field and is what `category_field_schemas` stores for posts.
 */
export interface CategoryFieldDefinition {
  jsonSchema: FieldSchema;
  uiSchema: UiSchema;
  filterableFields: string[];
  searchableFields: string[];
  analyticsFields: string[];
}

function isSubset(child: readonly string[], parent: readonly string[]): boolean {
  const allowed = new Set(parent);
  return child.every((value) => allowed.has(value));
}

/** A child bound is at least as tight as the parent's; a parent bound can't be dropped. */
function tighterLowerBound<T>(
  parent: T | undefined,
  child: T | undefined,
  gte: (a: T, b: T) => boolean,
) {
  return parent === undefined || (child !== undefined && gte(child, parent));
}

function tighterUpperBound<T>(
  parent: T | undefined,
  child: T | undefined,
  lte: (a: T, b: T) => boolean,
) {
  return parent === undefined || (child !== undefined && lte(child, parent));
}

export function optionCodes(property: FieldProperty | undefined): Set<string> {
  if (property?.['x-field-type'] === 'select') return new Set(property.enum);
  if (property?.['x-field-type'] === 'multiselect') return new Set(property.items.enum);
  return new Set();
}

const numberGte = (a: number, b: number) => a >= b;
const numberLte = (a: number, b: number) => a <= b;
// A malformed bound never counts as tighter; the publish check reports it.
const wellFormed = (a: string, b: string) => MONEY_PATTERN.test(a) && MONEY_PATTERN.test(b);
const moneyGte = (a: string, b: string) => wellFormed(a, b) && toPoisha(a) >= toPoisha(b);
const moneyLte = (a: string, b: string) => wellFormed(a, b) && toPoisha(a) <= toPoisha(b);

export function narrowingViolations(
  key: string,
  parent: FieldProperty,
  child: FieldProperty,
): string[] {
  if (parent['x-field-type'] !== child['x-field-type'] || parent.type !== child.type) {
    return [`${key}: a child may not change an inherited field's type`];
  }
  // Visibility changes when a field is required, so it is inherited exactly.
  if (JSON.stringify(parent['x-show-when']) !== JSON.stringify(child['x-show-when'])) {
    return [`${key}: a child may not change an inherited field's x-show-when`];
  }
  const loosened = (what: string) => [`${key}: a child may not loosen the inherited ${what}`];

  switch (parent['x-field-type']) {
    case 'select':
      return child['x-field-type'] === 'select' && !isSubset(child.enum, parent.enum)
        ? loosened('options')
        : [];
    case 'multiselect':
      if (child['x-field-type'] !== 'multiselect') return [];
      if (!isSubset(child.items.enum, parent.items.enum)) return loosened('options');
      return tighterLowerBound(parent.minItems, child.minItems, numberGte)
        ? []
        : loosened('minItems');
    case 'number': {
      if (child['x-field-type'] !== 'number') return [];
      const violations: string[] = [];
      if (!tighterLowerBound(parent.minimum, child.minimum, numberGte))
        violations.push(...loosened('minimum'));
      if (!tighterLowerBound(parent.exclusiveMinimum, child.exclusiveMinimum, numberGte)) {
        violations.push(...loosened('exclusiveMinimum'));
      }
      if (!tighterUpperBound(parent.maximum, child.maximum, numberLte))
        violations.push(...loosened('maximum'));
      const parentOffset = parent['x-max-current-year-offset'];
      const childOffset = child['x-max-current-year-offset'];
      if (!tighterUpperBound(parentOffset, childOffset, numberLte))
        violations.push(...loosened('year bound'));
      if (parent['x-gte-field'] !== undefined && child['x-gte-field'] !== parent['x-gte-field']) {
        violations.push(...loosened('field comparison'));
      }
      return violations;
    }
    case 'money': {
      if (child['x-field-type'] !== 'money') return [];
      const violations: string[] = [];
      if (!tighterLowerBound(parent['x-money-min'], child['x-money-min'], moneyGte)) {
        violations.push(...loosened('minimum'));
      }
      if (!tighterUpperBound(parent['x-money-max'], child['x-money-max'], moneyLte)) {
        violations.push(...loosened('maximum'));
      }
      if (parent['x-gte-field'] !== undefined && child['x-gte-field'] !== parent['x-gte-field']) {
        violations.push(...loosened('field comparison'));
      }
      return violations;
    }
    case 'text': {
      if (child['x-field-type'] !== 'text') return [];
      const violations: string[] = [];
      if (child.maxLength > parent.maxLength) violations.push(...loosened('maxLength'));
      // Regex subsets can't be decided in general, so an inherited pattern or format must be kept as is.
      if (parent.pattern !== undefined && child.pattern !== parent.pattern)
        violations.push(...loosened('pattern'));
      if (parent.format !== undefined && child.format !== parent.format)
        violations.push(...loosened('format'));
      return violations;
    }
    case 'textarea':
      return child['x-field-type'] === 'textarea' && child.maxLength > parent.maxLength
        ? loosened('maxLength')
        : [];
    case 'date':
      return child['x-field-type'] === 'date' &&
        parent['x-not-before-today'] === true &&
        child['x-not-before-today'] !== true
        ? loosened('date rule')
        : [];
    case 'bool':
    case 'phone':
      return [];
  }
}

/**
 * Returns the child's fully resolved definition: parent fields first, child
 * redefinitions narrowed in place, then the child's own fields. Throws if the
 * child loosens anything it inherits.
 */
export function flattenFieldDefinition(
  parent: CategoryFieldDefinition,
  child: CategoryFieldDefinition,
): CategoryFieldDefinition {
  const violations: string[] = [];
  const properties: Record<string, FieldProperty> = {};

  for (const [key, parentProperty] of Object.entries(parent.jsonSchema.properties)) {
    const childProperty = child.jsonSchema.properties[key];
    if (childProperty === undefined) {
      properties[key] = parentProperty;
    } else {
      violations.push(...narrowingViolations(key, parentProperty, childProperty));
      properties[key] = childProperty;
    }
  }
  for (const [key, childProperty] of Object.entries(child.jsonSchema.properties)) {
    if (!(key in properties)) properties[key] = childProperty;
  }
  if (violations.length > 0) throw new InvalidFieldSchemaException(violations);

  const allOf = [...(parent.jsonSchema.allOf ?? []), ...(child.jsonSchema.allOf ?? [])];
  const jsonSchema: FieldSchema = {
    type: 'object',
    additionalProperties: false,
    properties,
    required: [...new Set([...parent.jsonSchema.required, ...child.jsonSchema.required])],
    ...(allOf.length > 0 ? { allOf } : {}),
  };

  const order = [
    ...parent.uiSchema.order,
    ...child.uiSchema.order.filter((key) => !parent.uiSchema.order.includes(key)),
  ];
  // A narrowed select keeps labels only for the options it still offers.
  const options: NonNullable<UiSchema['options']> = {};
  for (const [key, labels] of Object.entries({
    ...parent.uiSchema.options,
    ...child.uiSchema.options,
  })) {
    const offered = optionCodes(properties[key]);
    options[key] = Object.fromEntries(Object.entries(labels).filter(([code]) => offered.has(code)));
  }
  const hidden = child.uiSchema.hidden ?? [];
  const visible = (keys: string[]) => [...new Set(keys)].filter((key) => !hidden.includes(key));
  const uiSchema: UiSchema = {
    order,
    card: visible(child.uiSchema.card.length > 0 ? child.uiSchema.card : parent.uiSchema.card),
    labels: { ...parent.uiSchema.labels, ...child.uiSchema.labels },
    options,
    ...(hidden.length > 0 ? { hidden } : {}),
  };

  return {
    jsonSchema,
    uiSchema,
    filterableFields: visible([...parent.filterableFields, ...child.filterableFields]),
    searchableFields: visible([...parent.searchableFields, ...child.searchableFields]),
    analyticsFields: visible([...parent.analyticsFields, ...child.analyticsFields]),
  };
}

/** The definition posts validate against: authored as is, or flattened into its parent's. */
export function resolveFieldDefinition(
  authored: CategoryFieldDefinition,
  parentResolved: CategoryFieldDefinition | undefined,
): CategoryFieldDefinition {
  return parentResolved === undefined ? authored : flattenFieldDefinition(parentResolved, authored);
}
