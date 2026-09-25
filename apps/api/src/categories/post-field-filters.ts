import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { posts } from '../database/schema/content';
import type { FieldFilter, RangeOperator } from './field-schema';

/**
 * Parsed field filters -> SQL conditions on `posts` (schema.md §4.2, §13.13).
 *
 * Storage decision: custom field values live in `posts.fields jsonb`, not in
 * a normalised post_field_values (EAV) table:
 *   - Range filters on the fields that need them (price, bedrooms, seats,
 *     area) use STORED generated columns with btree indexes on
 *     (tenant_id, category_id, <column>), so "bedrooms >= 2 AND rent < 15000"
 *     is an index range scan, not a pivot.
 *   - Equality filters on selects and bools use `fields @> {...}`, which the
 *     GIN (fields jsonb_path_ops) index serves.
 *   - Other ranges run on the rows already narrowed by (tenant_id,
 *     category_id), and Meilisearch stays the primary faceted search.
 *   - EAV would need one join per filter, one row per field per post, a value
 *     column per type, and would lose the pinned-schema-version guarantee.
 *
 * Every non-generated comparison is wrapped in CASE on the stored JSON type,
 * so a post written under an older schema version, where the key may have
 * had another type, never makes a cast fail; it just doesn't match.
 * Field keys and values are always bound parameters, never SQL text.
 */

/** Keys with a generated, indexed column on posts. */
const GENERATED_COLUMNS: Readonly<Record<string, PgColumn>> = {
  price: posts.price,
  bedrooms: posts.bedrooms,
  seats: posts.seats,
  area: posts.area,
};

const COMPARATORS: Readonly<Record<RangeOperator, SQL>> = {
  eq: sql.raw('='),
  gte: sql.raw('>='),
  lte: sql.raw('<='),
  gt: sql.raw('>'),
  lt: sql.raw('<'),
};

const MONEY_SQL_PATTERN = '^[0-9]{1,10}\\.[0-9]{2}$';
const DATE_SQL_PATTERN = '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';

/**
 * `::text::jsonb`, not `::jsonb`: with a bare jsonb cast postgres-js types the
 * parameter as jsonb and JSON-encodes the (already JSON) string a second
 * time, so the containment compares against a JSON *string* and never matches.
 */
function containment(field: string, value: unknown): SQL {
  return sql`${posts.fields} @> ${JSON.stringify({ [field]: value })}::text::jsonb`;
}

function rangeCondition(filter: Extract<FieldFilter, { op: RangeOperator }>): SQL {
  const comparator = COMPARATORS[filter.op];
  const generated = GENERATED_COLUMNS[filter.field];
  if (generated !== undefined && filter.kind !== 'date') {
    return sql`${generated} ${comparator} ${String(filter.value)}::numeric`;
  }

  const text = sql`(${posts.fields} ->> ${filter.field})`;
  switch (filter.kind) {
    case 'number':
      return sql`(case when jsonb_typeof(${posts.fields} -> ${filter.field}) = 'number'
        then ${text}::numeric end) ${comparator} ${String(filter.value)}::numeric`;
    case 'money':
      return sql`(case when ${text} ~ ${MONEY_SQL_PATTERN}
        then ${text}::numeric end) ${comparator} ${filter.value}::numeric`;
    case 'date':
      return sql`(case when ${text} ~ ${DATE_SQL_PATTERN}
        then ${text} end) ${comparator} ${filter.value}::text`;
  }
}

export function postFieldFilterCondition(filter: FieldFilter): SQL {
  switch (filter.kind) {
    case 'number':
    case 'money':
    case 'date':
      return rangeCondition(filter);
    case 'equals':
      return containment(filter.field, filter.value);
    case 'one_of': {
      const alternatives = filter.values.map((value) =>
        containment(filter.field, filter.multiselect ? [value] : value),
      );
      return sql`(${sql.join(alternatives, sql` or `)})`;
    }
  }
}

/** All filters ANDed; the caller adds tenant, category and status scoping. */
export function postFieldFilterConditions(filters: readonly FieldFilter[]): SQL[] {
  return filters.map(postFieldFilterCondition);
}
