/**
 * The search index contract (ADR 025, docs/specs/schema.md §13.26).
 *
 * One Meilisearch index per document type, shared by every tenant, with
 * `tenant_id` filterable: discovery is by radius and crosses tenant
 * boundaries, so a per-tenant index would need a merge across neighbours on
 * every query. Only public-state rows are indexed, and only public fields —
 * never a phone number.
 */

export const SEARCH_TYPES = ['posts', 'stores', 'places'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

/** Custom-field values as indexed: numbers (money in poisha, dates as yyyymmdd), strings, bools, string lists. */
export type IndexedFieldValue = number | string | boolean | string[];

export interface SearchDocument {
  id: string;
  tenant_id: string;

  /** Bengali-script name/title, as written (NFC, zero-width characters removed). */
  name_bn: string | null;
  /** Latin-script name/title (English or Banglish), as written. */
  name_en: string | null;
  /** Primary Banglish transliteration of the name (transliterate.ts). */
  name_translit: string;
  /** Other spellings and English equivalents; searchable, never displayed. */
  name_variants: string[];
  description: string | null;
  /** Labels of `searchable_fields` values (select options in both languages, short text). */
  field_text: string | null;
  /**
   * Banglish of every Bengali word in `field_text` and `description`. With
   * name/category/area translits, every Bengali word a document contains is
   * also present in Latin — which the query expansion (Banglish first,
   * search-terms.ts) relies on.
   */
  text_translit: string | null;

  category_id: string | null;
  category_slug: string | null;
  category_name_bn: string | null;
  category_name_en: string | null;
  category_translit: string | null;

  locality_id: string | null;
  area_name_bn: string | null;
  area_name_en: string | null;
  area_translit: string | null;

  /** From PostGIS: the row's point, else its locality's centre, else its area's centroid. */
  _geo: { lat: number; lng: number } | null;
  /** 1 while a boost is active (ranking rule `is_boosted:desc`). */
  is_boosted: 0 | 1;
  /** Unix seconds: last bump or publication (ranking rule `published_at:desc`). */
  published_at: number;

  /** Filterable custom fields (`filterable_fields` of the pinned schema version). */
  fields: Record<string, IndexedFieldValue>;
  /** The category's list-card fields (`ui_schema.card`) as stored, for display only. */
  card_fields: Record<string, unknown>;
  /** Posts: `price` in poisha, for sorting (never a float). */
  price_minor: number | null;
  rating_avg: number | null;

  /** Stores and places: URL slug. */
  slug: string | null;
  /** First ready photo: storage key of its thumb variant, and its ThumbHash. */
  cover_thumb_key: string | null;
  cover_thumbhash: string | null;
  is_verified: boolean;
  is_landmark: boolean;
}

/** Attributes, in priority order, that full-text search reads. */
export const SEARCHABLE_ATTRIBUTES = [
  'name_bn',
  'name_en',
  'name_translit',
  'name_variants',
  'category_name_bn',
  'category_name_en',
  'category_translit',
  'field_text',
  'area_name_bn',
  'area_name_en',
  'area_translit',
  'description',
  'text_translit',
] as const;

export const FILTERABLE_ATTRIBUTES = [
  'tenant_id',
  'category_id',
  'category_slug',
  'locality_id',
  '_geo',
  'is_boosted',
  'price_minor',
  'rating_avg',
  'is_verified',
  'is_landmark',
  // Declaring the object makes every nested `fields.<key>` filterable and facetable.
  'fields',
] as const;

export const SORTABLE_ATTRIBUTES = ['_geo', 'published_at', 'price_minor', 'rating_avg'] as const;

/**
 * Relevance first, then the business order the product asked for:
 * exact match > boosted > nearby > recent.
 *
 *   words, typo, proximity, attribute, exactness — how well the text matches
 *     (all query words, fewest typos, words close together, in the name rather
 *     than the description, spelled exactly);
 *   is_boosted:desc — paid boosts, among equally good matches;
 *   sort — the request's sort: distance (`_geoPoint`) when the caller sent a
 *     location, or price/rating when asked;
 *   published_at:desc — newest last tie-breaker.
 *
 * With an empty query (browsing) the text rules tie, so the order is boosted
 * > nearby > recent.
 */
export const RANKING_RULES = [
  'words',
  'typo',
  'proximity',
  'attribute',
  'exactness',
  'is_boosted:desc',
  'sort',
  'published_at:desc',
] as const;

export function indexUid(prefix: string, type: SearchType): string {
  return `${prefix}${type}`;
}
