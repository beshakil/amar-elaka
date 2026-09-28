import {
  filterStateFromSearchParams,
  toRawFilters,
  type CategoryFieldSchema,
  type FilterState,
} from '@amar-elaka/dynamic-form';

/**
 * A category page's `f.<field>.<op>` query parameters → the filter form's
 * state and the API's `filters` JSON (`{"field": {"op": "value"}}`).
 * Several ticked options of one field arrive as repeated parameters; they
 * are joined first, as the shared parser expects one comma list.
 */
export function filtersFromQuery(
  schema: CategoryFieldSchema,
  query: Record<string, string | string[] | undefined>,
): { state: FilterState; json: string | null } {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (!name.startsWith('f.') || value === undefined) continue;
    const joined = (Array.isArray(value) ? value : [value])
      .filter((v) => v.trim() !== '')
      .join(',');
    if (joined) params.set(name, joined);
  }
  const state = filterStateFromSearchParams(schema, params);
  const { filters, issues } = toRawFilters(schema, state);
  if (filters.length === 0 || issues.length > 0) return { state, json: null };
  const grouped: Record<string, Record<string, string>> = {};
  for (const f of filters) (grouped[f.field] ??= {})[f.op] = f.value;
  return { state, json: JSON.stringify(grouped) };
}
