import { parseMoneyInput, parseNumberInput } from './numerals';
import type { CategoryFieldSchema, FieldProperty } from './schema';
import { isCalendarDay } from './validation';

/**
 * The filter UI's state and its translation to the API's filter format
 * (`{ field, op, value }`, the input of the server's parseFieldFilters in
 * apps/api/src/categories/field-schema/field-filter.ts): ranges become
 * gte/lte, selects `in`, multiselects `any`, a switched-on bool `eq true`.
 * Only `filterableFields` get a control, and only filters the server accepts
 * are ever produced; problems (min above max, "abc") come back as issues
 * for the UI to show instead.
 */

export type RangeState = { min?: string | undefined; max?: string | undefined };
export type FilterFieldState = RangeState | string[] | boolean | string | undefined;
export type FilterState = Record<string, FilterFieldState>;

export interface RawFieldFilter {
  field: string;
  op: 'eq' | 'gte' | 'lte' | 'in' | 'any';
  value: string;
}

export interface FilterIssue {
  field: string;
  /** `min` / `max` for one end of a range. */
  bound?: 'min' | 'max';
  /** Message id under `dynamicForm` (messages/*.json). */
  id: string;
}

export type FilterControl = 'range' | 'chips' | 'toggle' | 'text';

export function filterControlOf(property: FieldProperty): FilterControl | undefined {
  switch (property['x-field-type']) {
    case 'number':
    case 'money':
    case 'date':
      return 'range';
    case 'select':
    case 'multiselect':
      return 'chips';
    case 'bool':
      return 'toggle';
    case 'text':
      return 'text';
    default:
      return undefined;
  }
}

/** Filterable fields that have a control, in the form's display order. */
export function filterFieldKeys(schema: CategoryFieldSchema): string[] {
  const filterable = new Set(schema.filterableFields);
  return schema.uiSchema.order.filter((key) => {
    const property = schema.jsonSchema.properties[key];
    return filterable.has(key) && property !== undefined && filterControlOf(property) !== undefined;
  });
}

/** One end of a range as the API wants it; undefined if it isn't a valid value. */
function rangeValue(property: FieldProperty, raw: string): string | undefined {
  switch (property['x-field-type']) {
    case 'number': {
      const value = parseNumberInput(raw);
      if (Number.isNaN(value)) return undefined;
      if (property.type === 'integer' && !Number.isInteger(value)) return undefined;
      return String(value);
    }
    case 'money':
      return parseMoneyInput(raw);
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(raw) && isCalendarDay(raw) ? raw : undefined;
    default:
      return undefined;
  }
}

function invalidId(property: FieldProperty): string {
  switch (property['x-field-type']) {
    case 'money':
      return 'errors.invalidMoney';
    case 'date':
      return 'errors.invalidDate';
    default:
      return property['x-field-type'] === 'number' && property.type === 'integer'
        ? 'errors.invalidInteger'
        : 'errors.invalidNumber';
  }
}

export function toRawFilters(
  schema: CategoryFieldSchema,
  state: FilterState,
): { filters: RawFieldFilter[]; issues: FilterIssue[] } {
  const filters: RawFieldFilter[] = [];
  const issues: FilterIssue[] = [];

  for (const field of filterFieldKeys(schema)) {
    const property = schema.jsonSchema.properties[field]!;
    const value = state[field];
    if (value === undefined || value === '' || value === false) continue;

    switch (filterControlOf(property)) {
      case 'range': {
        const range = value as RangeState;
        const bounds: { bound: 'min' | 'max'; raw: string | undefined; op: 'gte' | 'lte' }[] = [
          { bound: 'min', raw: range.min, op: 'gte' },
          { bound: 'max', raw: range.max, op: 'lte' },
        ];
        const parsed: Partial<Record<'min' | 'max', string>> = {};
        for (const { bound, raw, op } of bounds) {
          if (raw === undefined || raw.trim() === '') continue;
          const normalized = rangeValue(property, raw.trim());
          if (normalized === undefined) {
            issues.push({ field, bound, id: invalidId(property) });
            continue;
          }
          parsed[bound] = normalized;
          filters.push({ field, op, value: normalized });
        }
        if (parsed.min !== undefined && parsed.max !== undefined) {
          const minAboveMax =
            property['x-field-type'] === 'date'
              ? parsed.min > parsed.max
              : Number(parsed.min) > Number(parsed.max);
          if (minAboveMax) issues.push({ field, bound: 'min', id: 'errors.minAboveMax' });
        }
        break;
      }
      case 'chips': {
        const codes = (value as string[]).filter((code) =>
          property['x-field-type'] === 'select'
            ? property.enum.includes(code)
            : property['x-field-type'] === 'multiselect' && property.items.enum.includes(code),
        );
        if (codes.length === 0) break;
        const op =
          property['x-field-type'] === 'multiselect' ? 'any' : codes.length === 1 ? 'eq' : 'in';
        filters.push({ field, op, value: codes.join(',') });
        break;
      }
      case 'toggle':
        if (value === true) filters.push({ field, op: 'eq', value: 'true' });
        break;
      case 'text':
        if (typeof value === 'string' && value.trim() !== '') {
          filters.push({ field, op: 'eq', value: value.trim() });
        }
        break;
      default:
        break;
    }
  }
  return { filters, issues };
}

/** How many filters are active, for the "3 filters on" badge. */
export function activeFilterCount(schema: CategoryFieldSchema, state: FilterState): number {
  return new Set(toRawFilters(schema, state).filters.map((f) => f.field)).size;
}

const PARAM_PREFIX = 'f.';

/** `f.bedrooms.gte=2&f.property_type.in=flat,house`: shareable, and what a listing page reads back. */
export function filtersToSearchParams(filters: readonly RawFieldFilter[]): URLSearchParams {
  const params = new URLSearchParams();
  for (const filter of filters)
    params.append(`${PARAM_PREFIX}${filter.field}.${filter.op}`, filter.value);
  return params;
}

/** The reverse, into filter UI state; unknown fields and operators are ignored. */
export function filterStateFromSearchParams(
  schema: CategoryFieldSchema,
  params: URLSearchParams,
): FilterState {
  const state: FilterState = {};
  const keys = new Set(filterFieldKeys(schema));
  for (const [name, value] of params) {
    if (!name.startsWith(PARAM_PREFIX)) continue;
    const dot = name.lastIndexOf('.');
    const field = name.slice(PARAM_PREFIX.length, dot);
    const op = name.slice(dot + 1);
    const property = schema.jsonSchema.properties[field];
    if (!keys.has(field) || property === undefined) continue;

    switch (filterControlOf(property)) {
      case 'range': {
        const range = (state[field] as RangeState | undefined) ?? {};
        if (op === 'gte') range.min = value;
        if (op === 'lte') range.max = value;
        state[field] = range;
        break;
      }
      case 'chips':
        if (op === 'eq' || op === 'in' || op === 'any') state[field] = value.split(',');
        break;
      case 'toggle':
        if (op === 'eq' && value === 'true') state[field] = true;
        break;
      case 'text':
        if (op === 'eq') state[field] = value;
        break;
      default:
        break;
    }
  }
  return state;
}
