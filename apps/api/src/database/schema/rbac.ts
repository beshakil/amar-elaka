import { boolean, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { auditColumns, id, timestamptz } from './columns';
import { tenants } from './tenancy';

/** Built-in role templates (tenant_id NULL) + one tenant's custom roles. */
export const roles = pgTable('roles', {
  id: id(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  name: text('name').notNull(),
  isBuiltin: boolean('is_builtin').notNull().default(false),
  ...auditColumns(),
});

/** The module -> action matrix for a role. module/action = '*' means "all". */
export const rolePermissions = pgTable('role_permissions', {
  id: id(),
  roleId: uuid('role_id')
    .notNull()
    .references(() => roles.id, { onDelete: 'cascade' }),
  module: text('module').notNull(),
  action: text('action').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});
