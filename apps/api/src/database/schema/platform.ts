import { bigint, date, jsonb, numeric, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { auditColumns, id } from './columns';
import { counterTypes, revenueStreams, settingOverrideScopes, settingValueTypes } from './enums';
import { users } from './identity';

/**
 * §2.16 Every number that governs behaviour, as a typed, bounded key-value
 * row (CLAUDE.md rule 9). `value`'s shape varies with `valueTypeCode`, so it
 * stays `unknown` here — apps/api/src/settings/settings.registry.ts is the
 * typed boundary.
 */
export const platformSettings = pgTable('platform_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  valueTypeCode: text('value_type_code')
    .notNull()
    .references(() => settingValueTypes.code, { onDelete: 'restrict' }),
  unit: text('unit'),
  minValue: numeric('min_value'),
  maxValue: numeric('max_value'),
  tenantOverrideScopeCode: text('tenant_override_scope_code')
    .notNull()
    .default('none')
    .references(() => settingOverrideScopes.code, { onDelete: 'restrict' }),
  description: text('description').notNull(),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  ...auditColumns(),
});

/** §2.17 Gapless platform-level sequences (e.g. tax invoice numbers). */
export const platformCounters = pgTable(
  'platform_counters',
  {
    counterCode: text('counter_code')
      .notNull()
      .references(() => counterTypes.code, { onDelete: 'restrict' }),
    periodKey: text('period_key').notNull(),
    lastValue: bigint('last_value', { mode: 'number' }).notNull().default(0),
    ...auditColumns(),
  },
  (table) => [primaryKey({ columns: [table.counterCode, table.periodKey] })],
);

/** §2.18 Dated VAT rates per revenue stream. */
export const vatRates = pgTable('vat_rates', {
  id: id(),
  revenueStreamCode: text('revenue_stream_code')
    .notNull()
    .references(() => revenueStreams.code, { onDelete: 'restrict' }),
  rate: numeric('rate', { precision: 5, scale: 4 }).notNull(),
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
  legalReference: text('legal_reference'),
  ...auditColumns(),
});
