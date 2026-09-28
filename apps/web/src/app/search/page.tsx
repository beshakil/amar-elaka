import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { X } from 'lucide-react';
import { formatMoney, labelOf, localizeDigits, optionLabel } from '@amar-elaka/dynamic-form';
import type { CategoryFieldSchema } from '@amar-elaka/dynamic-form';
import { NoCoverage } from '@/components/no-coverage';
import { ListingGrid } from '@/components/listings/listing-grid';
import { SaveSearch } from '@/components/search/save-search';
import { SearchFacets } from '@/components/search/search-facets';
import { readSession } from '@/lib/auth/session';
import { cardFromHit, type PriceWords } from '@/lib/listings/format';
import { catalog } from '@/lib/listings/load';
import {
  filteredFields,
  parseSearchParams,
  searchHref,
  SORTS,
  withoutField,
  type Query,
  type SearchParams,
} from '@/lib/search/params';
import { runSearch } from '@/lib/search/load';
import { currentTenantConfig } from '@/lib/tenant';
import { cn } from '@/lib/utils';

interface Props {
  searchParams: Promise<Query>;
}

/**
 * Search results can't be a good landing page: endless, thin and near
 * duplicates of each other and of the category pages. noindex keeps them
 * out of the index; `follow` still lets a crawler reach the listings. The
 * pages built to rank are the category + area pages (ADR 042).
 */
export async function generateMetadata(props: Props): Promise<Metadata> {
  const [tenant, query] = await Promise.all([currentTenantConfig(), props.searchParams]);
  if (!tenant) return {};
  const t = await getTranslations('seo');
  const params = parseSearchParams(query);
  return {
    title: {
      absolute: params.q
        ? t('searchTitle', { query: params.q, tenant: tenant.nameBn })
        : t('searchTitleNoQuery', { tenant: tenant.nameBn }),
    },
    robots: { index: false, follow: true },
  };
}

export default async function SearchPage(props: Props) {
  const [tenant, query] = await Promise.all([currentTenantConfig(), props.searchParams]);
  if (!tenant) return <NoCoverage />;
  const params = parseSearchParams(query);
  const categories = await catalog(tenant);
  const category = categories.find((c) => c.slug === params.category);
  const schema = (category?.fieldSchema as CategoryFieldSchema | null | undefined) ?? null;
  const [result, session, t, tl] = await Promise.all([
    runSearch(tenant, params, schema),
    readSession(),
    getTranslations('search'),
    getTranslations('listing'),
  ]);

  const words: PriceWords = {
    free: tl('free'),
    priceOnRequest: tl('priceOnRequest'),
    negotiable: tl('negotiable'),
    perMonth: tl('perMonth'),
  };
  const cards = result.hits.map((hit) => cardFromHit(hit, words));
  const count = (n: number) => localizeDigits(String(n), 'bn');
  const categoryName = (slug: string) =>
    categories.find((c) => c.slug === slug)?.name.bn ??
    tenant.enabledCategories.find((c) => c.slug === slug)?.nameBn ??
    slug;
  const priceRange = (min: string | null, max: string | null) =>
    max === null
      ? t('priceFrom', { min: formatMoney(min ?? '0', 'bn') })
      : t('priceRange', { min: formatMoney(min ?? '0', 'bn'), max: formatMoney(max, 'bn') });

  // Each active filter, with the search without it.
  const active: { label: string; href: string; key: string }[] = [
    ...(params.category
      ? [
          {
            key: 'category',
            label: categoryName(params.category),
            href: searchHref(params, { category: null }),
          },
        ]
      : []),
    ...(params.priceMin || params.priceMax
      ? [
          {
            key: 'price',
            label: priceRange(params.priceMin, params.priceMax),
            href: searchHref(params, { priceMin: null, priceMax: null }),
          },
        ]
      : []),
    ...filteredFields(params).map((field) => ({
      key: `field-${field}`,
      label: fieldLabel(params, field, schema),
      href: searchHref(withoutField(params, field)),
    })),
  ];
  const here = searchHref(params, { page: params.page });
  const totalPages = Math.max(1, Math.ceil(result.totalHits / Math.max(result.limit, 1)));
  const flash =
    typeof query.saved === 'string'
      ? 'saved'
      : typeof query.saveError === 'string'
        ? query.saveError
        : null;
  const saveLabels = {
    save: t('save'),
    title: t('saveTitle'),
    name: t('saveName'),
    frequency: t('saveFrequency'),
    frequencies: {
      instant: t('frequency.instant'),
      daily: t('frequency.daily'),
      off: t('frequency.off'),
    },
    submit: t('saveSubmit'),
    login: t('saveLogin'),
  };
  const saveSearch = (
    <SaveSearch
      signedIn={session !== null}
      searchPath={here}
      defaultName={params.q || (params.category ? categoryName(params.category) : '')}
      radiusKm={result.radiusKm}
      labels={saveLabels}
    />
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
      <aside aria-label={t('filters')} className="order-last lg:order-first">
        {!result.facets || result.hits.length + result.facets.categories.length === 0 ? null : (
          <SearchFacets
            params={params}
            facets={result.facets}
            schema={schema}
            labels={{
              category: t('category'),
              allCategories: t('allCategories'),
              price: t('price'),
              anyPrice: t('anyPrice'),
              facet: (label, n) => t('facet', { label, count: n }),
              priceRange: (min, max) =>
                max === null ? t('priceFrom', { min }) : t('priceRange', { min, max }),
              categoryName,
            }}
          />
        )}
      </aside>

      <div className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl font-semibold">
            {params.q ? t('heading', { query: params.q }) : t('headingNoQuery')}
          </h1>
          <p className="text-sm text-muted-foreground" data-testid="search-summary">
            {[
              t('count', { count: count(result.totalHits) }),
              result.radiusKm === null ? null : t('radius', { km: count(result.radiusKm) }),
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>

        {flash && (
          <p
            role="status"
            className={cn(
              'rounded-md p-3 text-sm',
              flash === 'saved' ? 'bg-brand/10 text-brand' : 'bg-destructive/10 text-destructive',
            )}
          >
            {flash === 'saved'
              ? t('saved')
              : flash === 'limit'
                ? t('saveLimit', { max: count(Number(query.max ?? 0) || 0) })
                : t('saveFailed')}
          </p>
        )}
        {result.degraded && (
          <p role="status" className="rounded-md bg-muted p-3 text-sm">
            {t('degraded')}
          </p>
        )}

        <nav aria-label={t('sort')} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('sort')}:</span>
          {SORTS.map((sort) => (
            <a
              key={sort}
              href={searchHref(params, { sort })}
              rel="nofollow"
              aria-current={params.sort === sort ? 'true' : undefined}
              className={cn(
                'rounded-md px-2 py-1',
                params.sort === sort ? 'bg-muted font-medium' : 'hover:bg-muted',
              )}
            >
              {t(`sorts.${sort}`)}
            </a>
          ))}
        </nav>

        {active.length > 0 && (
          <ul aria-label={t('activeFilters')} className="flex flex-wrap gap-2">
            {active.map((f) => (
              <li key={f.key}>
                <a
                  href={f.href}
                  rel="nofollow"
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-sm hover:bg-muted/70"
                  aria-label={t('remove', { filter: f.label })}
                >
                  {f.label}
                  <X className="size-3.5" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        )}

        {cards.length === 0 ? (
          <section className="space-y-3 py-6" data-testid="search-empty">
            <h2 className="text-lg font-semibold">
              {params.q ? t('emptyTitle', { query: params.q }) : t('emptyTitleNoQuery')}
            </h2>
            <p className="text-muted-foreground">{t('emptyBody')}</p>
            <ul className="space-y-2">
              {active.map((f) => (
                <li key={f.key}>
                  <a href={f.href} rel="nofollow" className="text-brand hover:underline">
                    {t('emptyRemove', { filter: f.label })}
                  </a>
                </li>
              ))}
              {params.q && params.category && (
                <li>
                  <a
                    href={searchHref(params, { category: null })}
                    rel="nofollow"
                    className="text-brand hover:underline"
                  >
                    {t('emptyEverywhere', { query: params.q })}
                  </a>
                </li>
              )}
            </ul>
            <div className="pt-2">{saveSearch}</div>
          </section>
        ) : (
          <>
            <div>{saveSearch}</div>
            <ListingGrid
              cards={cards}
              badgeLabel={(code) => (tl.has(`badges.${code}`) ? tl(`badges.${code}`) : null)}
              soldLabel={tl('sold')}
              titleLevel={2}
            />
          </>
        )}

        {totalPages > 1 && (
          <nav aria-label={t('pagination')} className="flex items-center justify-between pt-4">
            {params.page > 1 ? (
              <a
                rel="prev nofollow"
                href={searchHref(params, { page: params.page - 1 })}
                className="text-brand hover:underline"
              >
                {t('previous')}
              </a>
            ) : (
              <span />
            )}
            <span className="text-sm text-muted-foreground">
              {t('page', { page: count(params.page) })}
            </span>
            {params.page < totalPages ? (
              <a
                rel="next nofollow"
                href={searchHref(params, { page: params.page + 1 })}
                className="text-brand hover:underline"
              >
                {t('next')}
              </a>
            ) : (
              <span />
            )}
          </nav>
        )}
      </div>
    </div>
  );
}

/** "অবস্থা: ব্যবহৃত, নতুন" — a field filter as the visitor reads it. */
function fieldLabel(
  params: SearchParams,
  field: string,
  schema: CategoryFieldSchema | null,
): string {
  const values = Object.entries(params.filters)
    .filter(([name]) => name.split('.')[1] === field)
    .flatMap(([, v]) => v);
  if (!schema) return `${field}: ${values.join(', ')}`;
  return `${labelOf(schema, field, 'bn')}: ${values
    .map((v) => optionLabel(schema, field, v, 'bn'))
    .join(', ')}`;
}
