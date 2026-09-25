import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/exceptions/domain-exception';
import type { CategoryFieldDefinition } from './field-schema.flatten';
import { DATE_PATTERN, isCalendarDay } from './fields-validator';

/**
 * Custom-field filters ("bedrooms >= 2 AND price < 15000"), checked against a
 * category's resolved definition before any SQL or search query is built:
 * only `filterable_fields` may be filtered, each with the operators its type
 * supports, and every value is parsed to the field's type. The SQL side is
 * apps/api/src/categories/post-field-filters.ts.
 */

export const RANGE_OPERATORS = ['eq', 'gte', 'lte', 'gt', 'lt'] as const;
export type RangeOperator = (typeof RANGE_OPERATORS)[number];

export interface RawFieldFilter {
  field: string;
  op: string;
  /** As received (query string); lists are comma-separated. */
  value: string;
}

export type FieldFilter =
  | { kind: 'number'; field: string; op: RangeOperator; value: number }
  | { kind: 'money'; field: string; op: RangeOperator; value: string }
  | { kind: 'date'; field: string; op: RangeOperator; value: string }
  /** Exact match on a select, bool or short text value. */
  | { kind: 'equals'; field: string; value: string | boolean }
  /** Select `in` or multiselect "has any of". */
  | { kind: 'one_of'; field: string; multiselect: boolean; values: string[] };

export const FILTER_ISSUES = {
  notFilterable: 'filter.not_filterable',
  badOperator: 'filter.bad_operator',
  badValue: 'filter.bad_value',
} as const;

export interface FilterIssue {
  field: string;
  code: string;
}

export class InvalidFieldFilterException extends DomainException {
  readonly code = 'FIELD_FILTER_INVALID';
  readonly httpStatus = HttpStatus.BAD_REQUEST;

  constructor(readonly issues: FilterIssue[]) {
    super('One or more field filters are invalid.');
  }
}

/** Filter values may omit the decimals ("15000"); stored money always has two. */
// settings-exempt: the scale of numeric(12,2), a column type, not a business number.
const MONEY_DECIMALS = 2;
const MONEY_FILTER_PATTERN = /^(\d{1,10})(?:\.(\d{1,2}))?$/;

function normalizeMoney(value: string): string | undefined {
  const match = MONEY_FILTER_PATTERN.exec(value);
  if (!match) return undefined;
  const [, whole, fraction = ''] = match;
  return `${whole}.${fraction.padEnd(MONEY_DECIMALS, '0')}`;
}

const isRangeOperator = (op: string): op is RangeOperator =>
  (RANGE_OPERATORS as readonly string[]).includes(op);

function parseOne(
  definition: CategoryFieldDefinition,
  raw: RawFieldFilter,
): FieldFilter | FilterIssue {
  const issue = (code: string): FilterIssue => ({ field: raw.field, code });
  const property = definition.jsonSchema.properties[raw.field];
  if (property === undefined || !definition.filterableFields.includes(raw.field)) {
    return issue(FILTER_ISSUES.notFilterable);
  }

  switch (property['x-field-type']) {
    case 'number': {
      if (!isRangeOperator(raw.op)) return issue(FILTER_ISSUES.badOperator);
      const value = raw.value.trim() === '' ? Number.NaN : Number(raw.value);
      const valid =
        Number.isFinite(value) && (property.type === 'number' || Number.isInteger(value));
      return valid
        ? { kind: 'number', field: raw.field, op: raw.op, value }
        : issue(FILTER_ISSUES.badValue);
    }
    case 'money': {
      if (!isRangeOperator(raw.op)) return issue(FILTER_ISSUES.badOperator);
      const value = normalizeMoney(raw.value);
      return value === undefined
        ? issue(FILTER_ISSUES.badValue)
        : { kind: 'money', field: raw.field, op: raw.op, value };
    }
    case 'date': {
      if (!isRangeOperator(raw.op)) return issue(FILTER_ISSUES.badOperator);
      return DATE_PATTERN.test(raw.value) && isCalendarDay(raw.value)
        ? { kind: 'date', field: raw.field, op: raw.op, value: raw.value }
        : issue(FILTER_ISSUES.badValue);
    }
    case 'bool': {
      if (raw.op !== 'eq') return issue(FILTER_ISSUES.badOperator);
      if (raw.value !== 'true' && raw.value !== 'false') return issue(FILTER_ISSUES.badValue);
      return { kind: 'equals', field: raw.field, value: raw.value === 'true' };
    }
    case 'select':
    case 'multiselect': {
      const multiselect = property['x-field-type'] === 'multiselect';
      const offered = multiselect ? property.items.enum : property.enum;
      const allowedOp = multiselect ? 'any' : raw.op === 'eq' ? 'eq' : 'in';
      if (raw.op !== allowedOp) return issue(FILTER_ISSUES.badOperator);
      const values = [...new Set(raw.value.split(',').map((v) => v.trim()))];
      const tooMany = raw.op === 'eq' && values.length > 1;
      if (tooMany || values.some((v) => !offered.includes(v))) {
        return issue(FILTER_ISSUES.badValue);
      }
      return raw.op === 'eq'
        ? { kind: 'equals', field: raw.field, value: values[0]! }
        : { kind: 'one_of', field: raw.field, multiselect, values };
    }
    case 'text': {
      if (raw.op !== 'eq') return issue(FILTER_ISSUES.badOperator);
      const value = raw.value.trim();
      return value === '' || value.length > property.maxLength
        ? issue(FILTER_ISSUES.badValue)
        : { kind: 'equals', field: raw.field, value };
    }
    case 'textarea':
    case 'phone':
      return issue(FILTER_ISSUES.notFilterable);
  }
}

/** Parses every filter, collecting all problems before throwing. */
export function parseFieldFilters(
  definition: CategoryFieldDefinition,
  raw: readonly RawFieldFilter[],
): FieldFilter[] {
  const parsed = raw.map((filter) => parseOne(definition, filter));
  const issues = parsed.filter((p): p is FilterIssue => 'code' in p);
  if (issues.length > 0) throw new InvalidFieldFilterException(issues);
  return parsed.filter((p): p is FieldFilter => !('code' in p));
}
