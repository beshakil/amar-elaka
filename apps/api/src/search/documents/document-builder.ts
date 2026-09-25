import {
  MONEY_PATTERN,
  toPoisha,
  type FieldSchema,
  type UiSchema,
} from '../../categories/field-schema';
import type { IndexedFieldValue, SearchDocument } from '../search.types';
import { cleanDisplayText, type SearchTerms } from '../text/search-terms';

/**
 * Database rows → search documents. Pure, so the exact shape Meilisearch
 * receives is unit-tested; the SQL that loads the rows is in
 * search-documents.repository.ts.
 */

/** Columns every document type shares, as the repository selects them. */
export interface BaseRow {
  id: string;
  tenant_id: string;
  description: string | null;
  category_id: string | null;
  category_slug: string | null;
  category_name_bn: string | null;
  category_name_en: string | null;
  locality_id: string | null;
  area_name_bn: string | null;
  area_name_en: string | null;
  lat: number | null;
  lng: number | null;
  published_at: number;
  is_boosted: boolean;
  cover_thumb_key: string | null;
  cover_thumbhash: string | null;
  rating_avg: string | null;
  /** Pinned field-schema version, when the row has custom fields. */
  json_schema: FieldSchema | null;
  ui_schema: UiSchema | null;
  filterable_fields: string[];
  searchable_fields: string[];
  fields: Record<string, unknown>;
}

export interface PostRow extends BaseRow {
  title: string;
  price: string | null;
}

export interface StoreRow extends BaseRow {
  name_bn: string;
  name_en: string | null;
  slug: string;
  is_verified: boolean;
}

export interface PlaceRow extends BaseRow {
  name_bn: string;
  name_en: string | null;
  slug: string;
  is_landmark: boolean;
}

// settings-exempt: keeps each document small (index size); the full text stays in Postgres
const DESCRIPTION_MAX_CHARS = 2_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Custom-field values in the forms Meilisearch filters on. Money never becomes a float. */
export function indexedFields(row: Pick<BaseRow, 'json_schema' | 'filterable_fields' | 'fields'>) {
  const result: Record<string, IndexedFieldValue> = {};
  const properties = row.json_schema?.properties ?? {};
  for (const key of row.filterable_fields) {
    const property = properties[key];
    const value = row.fields[key];
    if (property === undefined || value === undefined || value === null) continue;
    const indexed = indexValue(property['x-field-type'], value);
    if (indexed !== undefined) result[key] = indexed;
  }
  return result;
}

function indexValue(type: string, value: unknown): IndexedFieldValue | undefined {
  switch (type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    case 'money':
      return typeof value === 'string' && MONEY_PATTERN.test(value)
        ? Number(toPoisha(value))
        : undefined;
    case 'date': {
      return typeof value === 'string' && DATE.test(value)
        ? Number(value.replace(/-/g, ''))
        : undefined;
    }
    case 'bool':
      return typeof value === 'boolean' ? value : undefined;
    case 'select':
    case 'text':
      return typeof value === 'string' && value !== '' ? value : undefined;
    case 'multiselect':
      return Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string')
        : undefined;
    default:
      return undefined;
  }
}

/** `searchable_fields` as text: option labels in both languages, short text as written. */
export function fieldText(
  row: Pick<BaseRow, 'json_schema' | 'ui_schema' | 'searchable_fields' | 'fields'>,
): string | null {
  const properties = row.json_schema?.properties ?? {};
  const parts: string[] = [];
  for (const key of row.searchable_fields) {
    const property = properties[key];
    const value = row.fields[key];
    if (property === undefined || value === undefined || value === null) continue;
    const type = property['x-field-type'];
    if (type === 'select' || type === 'multiselect') {
      const codes = Array.isArray(value) ? value : [value];
      for (const code of codes) {
        if (typeof code !== 'string') continue;
        const label = row.ui_schema?.options?.[key]?.[code];
        parts.push(...(label ? [label.bn, label.en] : [code]));
      }
    } else if (type === 'text' && typeof value === 'string') {
      parts.push(value);
    }
  }
  return cleanDisplayText(parts.join(' '));
}

/** Values of the list-card fields, exactly as stored (money stays a string). */
export function cardFields(row: Pick<BaseRow, 'ui_schema' | 'fields'>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of row.ui_schema?.card ?? []) {
    const value = row.fields[key];
    if (value !== undefined && value !== null) result[key] = value;
  }
  return result;
}

function moneyToPoisha(money: string | null): number | null {
  return money !== null && MONEY_PATTERN.test(money) ? Number(toPoisha(money)) : null;
}

function base(row: BaseRow, terms: SearchTerms) {
  const description = cleanDisplayText(row.description)?.slice(0, DESCRIPTION_MAX_CHARS) ?? null;
  const text = fieldText(row);
  const categoryBn = cleanDisplayText(row.category_name_bn);
  const areaBn = cleanDisplayText(row.area_name_bn);
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    description,
    field_text: text,
    text_translit: terms.bengaliTranslit([text, description].filter((t) => t !== null).join(' ')),
    category_id: row.category_id,
    category_slug: row.category_slug,
    category_name_bn: categoryBn,
    category_name_en: cleanDisplayText(row.category_name_en),
    category_translit: terms.translit(categoryBn),
    locality_id: row.locality_id,
    area_name_bn: areaBn,
    area_name_en: cleanDisplayText(row.area_name_en),
    area_translit: terms.translit(areaBn),
    _geo: row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null,
    is_boosted: row.is_boosted ? (1 as const) : (0 as const),
    published_at: row.published_at,
    fields: indexedFields(row),
    card_fields: cardFields(row),
    rating_avg: row.rating_avg === null ? null : Number(row.rating_avg),
    cover_thumb_key: row.cover_thumb_key,
    cover_thumbhash: row.cover_thumbhash,
  };
}

export function postDocument(row: PostRow, terms: SearchTerms): SearchDocument {
  return {
    ...base(row, terms),
    ...terms.nameFields({ title: row.title }),
    price_minor: moneyToPoisha(row.price),
    slug: null,
    is_verified: false,
    is_landmark: false,
  };
}

export function storeDocument(row: StoreRow, terms: SearchTerms): SearchDocument {
  return {
    ...base(row, terms),
    ...terms.nameFields({ bn: row.name_bn, en: row.name_en }),
    price_minor: null,
    slug: row.slug,
    is_verified: row.is_verified,
    is_landmark: false,
  };
}

export function placeDocument(row: PlaceRow, terms: SearchTerms): SearchDocument {
  return {
    ...base(row, terms),
    ...terms.nameFields({ bn: row.name_bn, en: row.name_en }),
    price_minor: null,
    slug: row.slug,
    is_verified: false,
    is_landmark: row.is_landmark,
  };
}
