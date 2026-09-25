'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { filtersToSearchParams, type FilterState, type RawFieldFilter } from '../filters';
import type { CategoryFieldSchema, FieldValues, LocalizedText } from '../schema';
import { DynamicFilters } from './dynamic-filters';
import { DynamicForm } from './dynamic-form';
import { ToggleChip } from './primitives';

/** A category as GET /categories serves it (fixtures/<slug>.json has the same shape). */
export interface PreviewCategory {
  slug: string;
  name: LocalizedText;
  fieldSchema: CategoryFieldSchema;
}

/**
 * Dev/QA screen: pick a category, fill its form and play with its filters,
 * and see exactly what would be sent to the API. Used by both Next apps'
 * preview pages, and by the admin as a schema preview.
 */
export function SchemaPreview({ categories }: { categories: PreviewCategory[] }) {
  const t = useTranslations('dynamicForm.preview');
  const [slug, setSlug] = useState(categories[0]?.slug);
  const [submitted, setSubmitted] = useState<FieldValues | null>(null);
  const [filterState, setFilterState] = useState<FilterState>({});
  const [filters, setFilters] = useState<RawFieldFilter[]>([]);
  const category = categories.find((c) => c.slug === slug);

  const select = (next: string) => {
    setSlug(next);
    setSubmitted(null);
    setFilterState({});
    setFilters([]);
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('categories')}>
          {categories.map((c) => (
            <ToggleChip key={c.slug} pressed={c.slug === slug} onClick={() => select(c.slug)}>
              {c.name.bn}
            </ToggleChip>
          ))}
        </div>
      </header>

      {category && (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <section aria-labelledby="preview-form" className="space-y-4">
            <h2 id="preview-form" className="text-lg font-semibold">
              {t('form', { name: category.name.bn })}
            </h2>
            <div className="rounded-lg border border-border bg-card p-5">
              <DynamicForm
                key={category.slug}
                schema={category.fieldSchema}
                onSubmit={(values) => setSubmitted(values)}
              />
            </div>
            <Output title={t('submitted')} empty={t('nothingYet')}>
              {submitted && JSON.stringify(submitted, null, 2)}
            </Output>
          </section>

          <section aria-labelledby="preview-filters" className="space-y-4">
            <h2 id="preview-filters" className="text-lg font-semibold">
              {t('filters')}
            </h2>
            <div className="rounded-lg border border-border bg-card p-5">
              <DynamicFilters
                key={category.slug}
                schema={category.fieldSchema}
                value={filterState}
                onChange={(state, result) => {
                  setFilterState(state);
                  setFilters(result.filters);
                }}
              />
            </div>
            <Output title={t('apiFilters')} empty={t('nothingYet')}>
              {filters.length > 0 &&
                `${JSON.stringify(filters, null, 2)}\n\n?${filtersToSearchParams(filters).toString()}`}
            </Output>
          </section>
        </div>
      )}
    </div>
  );
}

function Output({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: string | false | null;
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <pre
        aria-live="polite"
        className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed"
      >
        {children || empty}
      </pre>
    </div>
  );
}
