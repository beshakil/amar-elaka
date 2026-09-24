import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import type { Sql } from 'postgres';
import * as schema from '../src/database/schema';
import { testSqlClient } from './db/test-database';

/**
 * Migrations are hand-written SQL; src/database/schema mirrors them for typed
 * queries. This keeps the two from drifting: every table and column must match
 * in name, type and nullability, in both directions.
 */

type ColumnShape = Record<string, { type: string; notNull: boolean }>;

/**
 * Same underlying type, different string from the two formatters — not real
 * drift, so normalise both sides the same way before comparing:
 *  - `numeric(p, s)` (drizzle) vs `numeric(p,s)` (Postgres): space after comma.
 *  - `char(n)` (drizzle) vs `character(n)` (Postgres): short vs long name.
 *  - `time` (drizzle, no precision/timezone given) vs `time without time zone`
 *    (Postgres, which always spells out the timezone-less case).
 */
const normalizeType = (type: string) =>
  type
    .replace(/,\s+/g, ',')
    .replace(/^char\(/, 'character(')
    .replace(/^time$/, 'time without time zone');

function drizzleTables(): Map<string, ColumnShape> {
  const tables = new Map<string, ColumnShape>();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    const columns: ColumnShape = {};
    for (const column of config.columns) {
      columns[column.name] = {
        type: normalizeType(column.getSQLType()),
        notNull: column.notNull,
      };
    }
    tables.set(config.name, columns);
  }
  return tables;
}

async function databaseTables(sql: Sql): Promise<Map<string, ColumnShape>> {
  const rows = await sql<
    {
      table_name: string;
      column_name: string;
      type: string;
      not_null: boolean;
    }[]
  >`
    select c.relname as table_name, a.attname as column_name,
           format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
      and not exists (
        select 1 from pg_depend d
        where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'
      )`;
  const tables = new Map<string, ColumnShape>();
  for (const row of rows) {
    const columns = tables.get(row.table_name) ?? {};
    columns[row.column_name] = { type: normalizeType(row.type), notNull: row.not_null };
    tables.set(row.table_name, columns);
  }
  return tables;
}

describe('Drizzle schema mirrors the migrated database', () => {
  let sql: Sql;

  beforeAll(() => {
    sql = testSqlClient(1);
  });

  afterAll(async () => {
    await sql.end();
  });

  it('has exactly the same tables, columns, types and nullability', async () => {
    const mirror = drizzleTables();
    const database = await databaseTables(sql);

    expect([...mirror.keys()].sort()).toEqual([...database.keys()].sort());
    for (const [table, columns] of database) {
      expect({ table, columns: mirror.get(table) }).toEqual({ table, columns });
    }
  });
});
