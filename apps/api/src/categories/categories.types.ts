import type { CATEGORY_KINDS, MODULE_CODES, MONETIZATION_MODES } from './dto/category-requests.dto';

export type CategoryKind = (typeof CATEGORY_KINDS)[number];
export type ModuleCode = (typeof MODULE_CODES)[number];
export type MonetizationMode = (typeof MONETIZATION_MODES)[number];

/** Kinds whose categories take posts (not places, not module tiles). */
export const POSTABLE_KINDS: ReadonlySet<CategoryKind> = new Set([
  'marketplace',
  'service',
  'job',
  'rental',
]);

/** Kinds that have a custom-field schema. */
export const KINDS_WITH_FIELDS: ReadonlySet<CategoryKind> = new Set([
  'marketplace',
  'service',
  'job',
  'rental',
  'place',
]);
