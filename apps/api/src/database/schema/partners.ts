import { boolean, date, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { id, softDeleteColumns, timestamptz } from './columns';
import { partnerStatuses, payoutMethods } from './enums';
import { users } from './identity';

/** §2.1 The legal entity (person or company) operating one or more tenants. */
export const partners = pgTable('partners', {
  id: id(),
  legalName: text('legal_name').notNull(),
  displayName: text('display_name').notNull(),
  contactUserId: uuid('contact_user_id').references(() => users.id, { onDelete: 'set null' }),
  phoneE164: text('phone_e164').notNull(),
  email: text('email'),
  tradeLicenseNo: text('trade_license_no'),
  tin: text('tin'),
  address: text('address'),
  statusCode: text('status_code')
    .notNull()
    .default('prospect')
    .references(() => partnerStatuses.code, { onDelete: 'restrict' }),
  contractSignedOn: date('contract_signed_on'),
  contractEndsOn: date('contract_ends_on'),
  notes: text('notes'),
  ...softDeleteColumns(),
});

/** §2.2 Where a partner receives settlement payouts. */
export const partnerPayoutAccounts = pgTable('partner_payout_accounts', {
  id: id(),
  partnerId: uuid('partner_id')
    .notNull()
    .references(() => partners.id, { onDelete: 'restrict' }),
  methodCode: text('method_code')
    .notNull()
    .references(() => payoutMethods.code, { onDelete: 'restrict' }),
  accountName: text('account_name').notNull(),
  accountNumberCiphertext: text('account_number_ciphertext').notNull(),
  accountNumberLast4: text('account_number_last4').notNull(),
  bankName: text('bank_name'),
  branchName: text('branch_name'),
  routingNumber: text('routing_number'),
  isDefault: boolean('is_default').notNull().default(false),
  verifiedAt: timestamptz('verified_at'),
  verifiedByUserId: uuid('verified_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  ...softDeleteColumns(),
});
