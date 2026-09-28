import {
  filterControlOf,
  filterFieldKeys,
  labelOf,
  optionCodes,
  optionLabel,
  type CategoryFieldSchema,
  type FilterState,
  type RangeState,
} from '@amar-elaka/dynamic-form';

/**
 * The category's filters as a plain GET form (ADR 039): works without
 * JavaScript, and every filtered view is a shareable URL
 * (`f.<field>.<op>=<value>`, the same parameters the web and app use).
 * Filtered pages are noindex; the category page itself is the canonical one.
 */
export function CategoryFilters({
  schema,
  state,
  labels,
}: {
  schema: CategoryFieldSchema;
  state: FilterState;
  labels: {
    filters: string;
    apply: string;
    clear: string;
    min: string;
    max: string;
    clearHref: string;
  };
}) {
  const keys = filterFieldKeys(schema);
  if (keys.length === 0) return null;
  const active = Object.keys(state).length > 0;
  return (
    <details className="rounded-lg border border-border p-3" open={active}>
      <summary className="cursor-pointer font-medium">{labels.filters}</summary>
      <form method="get" className="mt-3 space-y-4">
        {keys.map((key) => {
          const property = schema.jsonSchema.properties[key]!;
          const label = labelOf(schema, key, 'bn');
          const control = filterControlOf(property);
          if (control === 'range') {
            const range = (state[key] as RangeState | undefined) ?? {};
            return (
              <fieldset key={key}>
                <legend className="mb-1 text-sm font-medium">{label}</legend>
                <div className="flex gap-2">
                  <input
                    name={`f.${key}.gte`}
                    defaultValue={range.min ?? ''}
                    placeholder={labels.min}
                    aria-label={`${label} ${labels.min}`}
                    inputMode="numeric"
                    className="w-full rounded-md border border-border bg-background px-2 py-1"
                  />
                  <input
                    name={`f.${key}.lte`}
                    defaultValue={range.max ?? ''}
                    placeholder={labels.max}
                    aria-label={`${label} ${labels.max}`}
                    inputMode="numeric"
                    className="w-full rounded-md border border-border bg-background px-2 py-1"
                  />
                </div>
              </fieldset>
            );
          }
          if (control === 'chips') {
            const selected = new Set((state[key] as string[] | undefined) ?? []);
            const op = property['x-field-type'] === 'multiselect' ? 'any' : 'in';
            return (
              <fieldset key={key}>
                <legend className="mb-1 text-sm font-medium">{label}</legend>
                <div className="flex flex-wrap gap-2">
                  {optionCodes(property).map((code) => (
                    <label
                      key={code}
                      className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-sm has-[:checked]:border-brand has-[:checked]:bg-brand/10"
                    >
                      <input
                        type="checkbox"
                        name={`f.${key}.${op}`}
                        value={code}
                        defaultChecked={selected.has(code)}
                        className="accent-brand"
                      />
                      {optionLabel(schema, key, code, 'bn')}
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          }
          if (control === 'toggle') {
            return (
              <label key={key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name={`f.${key}.eq`}
                  value="true"
                  defaultChecked={state[key] === true}
                  className="accent-brand"
                />
                {label}
              </label>
            );
          }
          return null;
        })}
        <div className="flex gap-3">
          <button
            type="submit"
            className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground"
          >
            {labels.apply}
          </button>
          {active && (
            <a
              href={labels.clearHref}
              className="px-2 py-2 text-sm text-muted-foreground hover:underline"
            >
              {labels.clear}
            </a>
          )}
        </div>
      </form>
    </details>
  );
}
