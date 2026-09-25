import { InvalidFieldSchemaException } from './field-schema.exceptions';
import { optionCodes, type CategoryFieldDefinition } from './field-schema.flatten';
import { parseFieldSchema, parseUiSchema } from './field-schema.parser';
import {
  RESERVED_FIELD_TYPES,
  type FieldProperty,
  type FieldSchema,
  type UiSchema,
} from './field-schema.types';
import { MONEY_PATTERN, toPoisha } from './money';

/**
 * Everything checked before a `category_field_schemas` row may become
 * `published` (categories.md §3.2–3.4, schema.md §3.4, §4.2). The row is
 * immutable once published, so this is the last chance to catch a mistake.
 * Returns the parsed definition so callers store exactly what was checked.
 */

export interface FieldSchemaDraft {
  jsonSchema: unknown;
  uiSchema: unknown;
  filterableFields: readonly string[];
  searchableFields: readonly string[];
  analyticsFields: readonly string[];
}

const SEARCHABLE_TYPES = new Set<FieldProperty['x-field-type']>([
  'text',
  'textarea',
  'select',
  'multiselect',
]);
const CONTROLLER_TYPES = new Set<FieldProperty['x-field-type']>(['select', 'multiselect', 'bool']);

function propertyViolations(key: string, property: FieldProperty): string[] {
  const violations: string[] = [];
  const reserved = RESERVED_FIELD_TYPES[key];
  if (reserved !== undefined) {
    const actual = property['x-field-type'] === 'money' ? 'money' : property.type;
    if (actual !== reserved) violations.push(`${key}: reserved key must be ${reserved}`);
  }

  switch (property['x-field-type']) {
    case 'select':
    case 'multiselect': {
      const codes = property['x-field-type'] === 'select' ? property.enum : property.items.enum;
      if (new Set(codes).size !== codes.length) violations.push(`${key}: duplicate option codes`);
      if (codes.some((code) => !/^[a-z0-9][a-z0-9_]*$/.test(code))) {
        violations.push(`${key}: option codes must be snake_case`);
      }
      break;
    }
    case 'number':
      if (
        property.minimum !== undefined &&
        property.maximum !== undefined &&
        property.minimum > property.maximum
      ) {
        violations.push(`${key}: minimum is above maximum`);
      }
      break;
    case 'money': {
      const min = property['x-money-min'];
      const max = property['x-money-max'];
      for (const bound of [min, max]) {
        if (bound !== undefined && !MONEY_PATTERN.test(bound)) {
          violations.push(`${key}: money bound ${bound} is not a two-decimal amount`);
        }
      }
      if (
        min !== undefined &&
        max !== undefined &&
        MONEY_PATTERN.test(min) &&
        MONEY_PATTERN.test(max) &&
        toPoisha(min) > toPoisha(max)
      ) {
        violations.push(`${key}: x-money-min is above x-money-max`);
      }
      break;
    }
    case 'text':
      if (property.pattern !== undefined) {
        try {
          new RegExp(property.pattern);
        } catch {
          violations.push(`${key}: pattern is not a valid regular expression`);
        }
      }
      break;
    default:
      break;
  }
  return violations;
}

function referenceViolations(schema: FieldSchema): string[] {
  const keys = new Set(Object.keys(schema.properties));
  const violations: string[] = [];
  const mustExist = (key: string, where: string) => {
    if (!keys.has(key)) violations.push(`${where}: unknown field ${key}`);
  };

  schema.required.forEach((key) => mustExist(key, 'required'));
  for (const [index, rule] of (schema.allOf ?? []).entries()) {
    const where = `allOf.${index}`;
    rule.if.required.forEach((key) => mustExist(key, where));
    rule.then.required.forEach((key) => mustExist(key, where));
    for (const [key, condition] of Object.entries(rule.if.properties ?? {})) {
      mustExist(key, where);
      const offered = optionCodes(schema.properties[key]);
      if (keys.has(key) && offered.size === 0) violations.push(`${where}: ${key} is not a select`);
      for (const code of condition.enum) {
        if (offered.size > 0 && !offered.has(code))
          violations.push(`${where}: ${key} has no option ${code}`);
      }
    }
  }
  for (const [key, property] of Object.entries(schema.properties)) {
    if (property['x-field-type'] !== 'number' && property['x-field-type'] !== 'money') continue;
    const other = property['x-gte-field'];
    if (other === undefined) continue;
    const target = schema.properties[other];
    if (target === undefined || target['x-field-type'] !== property['x-field-type']) {
      violations.push(`${key}: x-gte-field ${other} must be a ${property['x-field-type']} field`);
    }
  }
  return violations;
}

/** `x-show-when` must point at a select/multiselect/bool field, use its values, and never loop. */
function visibilityViolations(schema: FieldSchema): string[] {
  const violations: string[] = [];
  for (const [key, property] of Object.entries(schema.properties)) {
    const rule = property['x-show-when'];
    if (rule === undefined) continue;
    const where = `${key}.x-show-when`;
    const controller = schema.properties[rule.field];
    if (rule.field === key || controller === undefined) {
      violations.push(`${where}: unknown or self-referencing field ${rule.field}`);
      continue;
    }
    if (!CONTROLLER_TYPES.has(controller['x-field-type'])) {
      violations.push(`${where}: ${rule.field} must be a select, multiselect or bool field`);
      continue;
    }
    const offered: (string | boolean)[] =
      controller['x-field-type'] === 'bool' ? [true, false] : [...optionCodes(controller)];
    for (const value of rule.in) {
      if (!offered.includes(value))
        violations.push(`${where}: ${rule.field} has no value ${String(value)}`);
    }
  }

  // A chain may be as long as the schema, but it must end.
  for (const start of Object.keys(schema.properties)) {
    const seen = new Set<string>();
    for (let key: string | undefined = start; key !== undefined;) {
      if (seen.has(key)) {
        violations.push(`${start}.x-show-when: visibility rules form a cycle`);
        break;
      }
      seen.add(key);
      key = schema.properties[key]?.['x-show-when']?.field;
    }
  }
  return violations;
}

function fieldListViolations(schema: FieldSchema, draft: FieldSchemaDraft): string[] {
  const violations: string[] = [];
  const check = (
    list: readonly string[],
    name: string,
    allowed: (property: FieldProperty) => boolean,
  ) => {
    if (new Set(list).size !== list.length) violations.push(`${name}: duplicate entries`);
    for (const key of list) {
      const property = schema.properties[key];
      if (property === undefined) violations.push(`${name}: unknown field ${key}`);
      else if (!allowed(property)) violations.push(`${name}: ${key} is not allowed here`);
    }
  };

  check(
    draft.filterableFields,
    'filterable_fields',
    (p) => p['x-field-type'] !== 'phone' && p['x-field-type'] !== 'textarea',
  );
  check(draft.searchableFields, 'searchable_fields', (p) =>
    SEARCHABLE_TYPES.has(p['x-field-type']),
  );
  // Scrub whitelist (§13.31): nothing identifying survives a privacy scrub.
  check(draft.analyticsFields, 'analytics_fields', (p) => {
    if (p['x-field-type'] === 'phone' || p['x-field-type'] === 'textarea') return false;
    if (p['x-field-type'] === 'text')
      return p['x-analytics-safe'] === true && p.format === undefined;
    return true;
  });
  return violations;
}

function uiViolations(schema: FieldSchema, ui: UiSchema): string[] {
  const keys = Object.keys(schema.properties);
  const violations: string[] = [];

  const ordered = new Set(ui.order);
  if (ordered.size !== ui.order.length) violations.push('ui_schema.order: duplicate entries');
  for (const key of keys) if (!ordered.has(key)) violations.push(`ui_schema.order: missing ${key}`);
  for (const key of ui.order)
    if (!(key in schema.properties)) violations.push(`ui_schema.order: unknown ${key}`);

  for (const key of [...ui.card, ...(ui.hidden ?? [])]) {
    if (!(key in schema.properties)) violations.push(`ui_schema: unknown field ${key}`);
  }
  for (const key of ui.hidden ?? []) {
    if (schema.required.includes(key)) violations.push(`ui_schema.hidden: ${key} is required`);
  }

  for (const key of keys) {
    if (ui.labels[key] === undefined) violations.push(`ui_schema.labels: missing ${key}`);
    for (const code of optionCodes(schema.properties[key])) {
      if (ui.options?.[key]?.[code] === undefined) {
        violations.push(`ui_schema.options: missing ${key}.${code}`);
      }
    }
  }
  return violations;
}

export function checkPublishable(draft: FieldSchemaDraft): CategoryFieldDefinition {
  const jsonSchema = parseFieldSchema(draft.jsonSchema);
  const uiSchema = parseUiSchema(draft.uiSchema);

  const violations = [
    ...Object.entries(jsonSchema.properties).flatMap(([key, property]) =>
      propertyViolations(key, property),
    ),
    ...referenceViolations(jsonSchema),
    ...visibilityViolations(jsonSchema),
    ...fieldListViolations(jsonSchema, draft),
    ...uiViolations(jsonSchema, uiSchema),
  ];
  if (violations.length > 0) throw new InvalidFieldSchemaException(violations);
  return {
    jsonSchema,
    uiSchema,
    filterableFields: [...draft.filterableFields],
    searchableFields: [...draft.searchableFields],
    analyticsFields: [...draft.analyticsFields],
  };
}
