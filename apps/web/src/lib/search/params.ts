/**
 * /search's state lives in its URL (ADR 042): shareable, bookmarkable and
 * safe with the back button, because every change is a plain navigation to
 * a new URL — no client state to lose. The parameters:
 *
 *   q            the text, in any script (Bengali, Banglish, English)
 *   category     a category slug
 *   f.<field>.<op>  the category's filters, as the category page writes them
 *                (`f.condition.in=used`; repeats and comma lists both work)
 *   price_min    money in taka, inclusive; price_max exclusive (a price range)
 *   sort         relevance | newest | price_asc | price_desc
 *   page         1-based
 *
 * Parsing never throws: anything malformed is dropped, so a hand-edited or
 * truncated URL still shows a search.
 */

export type Query = Record<string, string | string[] | undefined>;

export const SORTS = ['relevance', 'newest', 'price_asc', 'price_desc'] as const;
export type Sort = (typeof SORTS)[number];

export interface SearchParams {
  q: string;
  category: string | null;
  /** `f.<field>.<op>` → values (a field's options, or a range bound). */
  filters: Record<string, string[]>;
  priceMin: string | null;
  priceMax: string | null;
  sort: Sort;
  page: number;
}

// The API's own input caps (search.dto.ts): longer text is cut, not refused.
const Q_MAX_CHARS = 200;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FILTER_PARAM = /^f\.[a-z][a-z0-9_]*\.(eq|in|any|gte|lte|gt|lt)$/;
const MONEY = /^\d{1,10}(\.\d{1,2})?$/;
const FILTER_VALUE_MAX_CHARS = 100;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

const all = (value: string | string[] | undefined) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

export function parseSearchParams(query: Query): SearchParams {
  const q = [...(first(query.q) ?? '').trim()].slice(0, Q_MAX_CHARS).join('');
  const category = first(query.category) ?? '';
  const filters: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(query)) {
    if (!FILTER_PARAM.test(name)) continue;
    const values = all(value)
      .flatMap((v) => v.split(','))
      .map((v) => v.trim())
      .filter((v) => v !== '' && v.length <= FILTER_VALUE_MAX_CHARS);
    if (values.length > 0) filters[name] = [...new Set(values)];
  }
  const money = (value: string | undefined) => (value && MONEY.test(value) ? value : null);
  let priceMin = money(first(query.price_min));
  let priceMax = money(first(query.price_max));
  if (priceMin !== null && priceMax !== null && Number(priceMin) >= Number(priceMax)) {
    priceMin = null;
    priceMax = null;
  }
  const sortRaw = first(query.sort);
  const sort = (SORTS as readonly string[]).includes(sortRaw ?? '')
    ? (sortRaw as Sort)
    : 'relevance';
  const page = Number(first(query.page) ?? '1');
  return {
    q,
    category: SLUG.test(category) ? category : null,
    // Filters belong to a category's fields: without one they mean nothing.
    filters: SLUG.test(category) ? filters : {},
    priceMin,
    priceMax,
    sort,
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/**
 * The URL for [params], with [patch] applied. Any change but the page goes
 * back to page 1; a new category drops the old one's filters. Parameters
 * come out in a fixed order, so the same search is always the same URL.
 */
export function searchHref(params: SearchParams, patch: Partial<SearchParams> = {}): string {
  const next: SearchParams = { ...params, ...patch };
  if (!('page' in patch)) next.page = 1;
  if ('category' in patch && patch.category !== params.category && !('filters' in patch)) {
    next.filters = {};
  }
  const out = new URLSearchParams();
  if (next.q) out.set('q', next.q);
  if (next.category) out.set('category', next.category);
  for (const name of Object.keys(next.filters).sort()) {
    const values = next.filters[name]!;
    if (values.length > 0) out.set(name, values.join(','));
  }
  if (next.priceMin) out.set('price_min', next.priceMin);
  if (next.priceMax) out.set('price_max', next.priceMax);
  if (next.sort !== 'relevance') out.set('sort', next.sort);
  if (next.page > 1) out.set('page', String(next.page));
  const search = out.toString();
  return search ? `/search?${search}` : '/search';
}

/** Adds or removes one option of a select-type field (`f.<field>.in`). */
export function toggleValue(params: SearchParams, field: string, value: string): SearchParams {
  const name = `f.${field}.in`;
  const current = params.filters[name] ?? [];
  const values = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  const filters = { ...params.filters, [name]: values };
  if (values.length === 0) delete filters[name];
  return { ...params, filters, page: 1 };
}

/** Is [value] of [field] chosen (in any of the chip operators)? */
export function isChosen(params: SearchParams, field: string, value: string): boolean {
  return ['eq', 'in', 'any'].some((op) => params.filters[`f.${field}.${op}`]?.includes(value));
}

/** The field keys that have a filter set, each once. */
export function filteredFields(params: SearchParams): string[] {
  return [...new Set(Object.keys(params.filters).map((name) => name.split('.')[1]!))];
}

export function withoutField(params: SearchParams, field: string): SearchParams {
  const filters = Object.fromEntries(
    Object.entries(params.filters).filter(([name]) => name.split('.')[1] !== field),
  );
  return { ...params, filters, page: 1 };
}

export function hasFilters(params: SearchParams): boolean {
  return (
    params.category !== null ||
    params.priceMin !== null ||
    params.priceMax !== null ||
    Object.keys(params.filters).length > 0
  );
}

/** The `f.*` entries as the query object the shared filter parser reads. */
export function filterQuery(params: SearchParams): Query {
  return Object.fromEntries(Object.entries(params.filters).map(([k, v]) => [k, v.join(',')]));
}
