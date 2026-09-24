import { sql } from 'drizzle-orm';
import { boolean, customType, integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Shared column builders. Column names are explicit snake_case so the mirror
 * reads exactly like the SQL migrations (docs/specs/schema.md §0.1).
 * Constraints, indexes and triggers live only in the SQL migrations.
 */

export const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`uuid_generate_v7()`);

export const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export const auditColumns = () => ({
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export const softDeleteColumns = () => ({
  ...auditColumns(),
  deletedAt: timestamptz('deleted_at'),
});

/** PostGIS `geography(Point,4326)`; read/written as EWKT/WKB hex strings. */
export const geographyPoint = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'geography(Point,4326)';
  },
});

/** PostGIS `geography(MultiPolygon,4326)`; admin-area boundaries (§3.1). */
export const geographyMultiPolygon = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'geography(MultiPolygon,4326)';
  },
});

/** Postgres `xid8`: a 64-bit transaction id, read/written as a decimal string. */
export const xid8 = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'xid8';
  },
});

/** Shape shared by every enum table (§0.3). */
export const enumTableColumns = () => ({
  code: text('code').primaryKey(),
  labelKey: text('label_key').notNull(),
  sortOrder: integer('sort_order')
    .notNull()
    .default(sql`0`),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns(),
});
