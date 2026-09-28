import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { localizeDigits, type CategoryFieldSchema } from '@amar-elaka/dynamic-form';
import { NoCoverage } from '@/components/no-coverage';
import { Breadcrumbs } from '@/components/listings/breadcrumbs';
import { CategoryFilters } from '@/components/listings/category-filters';
import { ListingGrid } from '@/components/listings/listing-grid';
import { filtersFromQuery } from '@/lib/listings/filters';
import { cardFromHit, type PriceWords } from '@/lib/listings/format';
import { catalog, categoryListings } from '@/lib/listings/load';
import { breadcrumbJsonLd, jsonLdScript } from '@/lib/seo/json-ld';
import { itemListJsonLd } from '@/lib/seo/listing-jsonld';
import { currentOrigin, currentTenantConfig } from '@/lib/tenant';

type Query = Record<string, string | string[] | undefined>;
interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Query>;
}

const pageOf = (query: Query) => {
  const raw = Array.isArray(query.page) ? query.page[0] : query.page;
  const page = Number(raw ?? '1');
  return Number.isInteger(page) && page >= 1 ? page : 1;
};

async function load(props: Props) {
  const [{ slug }, query] = await Promise.all([props.params, props.searchParams]);
  const tenant = await currentTenantConfig();
  if (!tenant) return null;
  const enabled = tenant.enabledCategories.find((c) => c.slug === slug);
  if (!enabled) notFound();
  const category = (await catalog(tenant)).find((c) => c.slug === slug);
  const schema = (category?.fieldSchema as CategoryFieldSchema | null | undefined) ?? null;
  const filters = schema ? filtersFromQuery(schema, query) : { state: {}, json: null };
  const page = pageOf(query);
  const results = await categoryListings(tenant, slug, page, filters.json);
  const totalPages = Math.max(1, Math.ceil(results.totalHits / Math.max(results.limit, 1)));
  if (page > totalPages) notFound();
  return { tenant, slug, name: enabled.nameBn, schema, filters, page, results, totalPages };
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const loaded = await load(props);
  if (!loaded) return {};
  const { tenant, slug, name, page, results, filters } = loaded;
  const t = await getTranslations('seo');
  const pageText = localizeDigits(String(page), 'bn');
  const title =
    page > 1
      ? t('categoryTitlePage', { category: name, tenant: tenant.nameBn, page: pageText })
      : t('categoryTitle', { category: name, tenant: tenant.nameBn });
  const description = t('categoryDescription', {
    category: name,
    tenant: tenant.nameBn,
    count: localizeDigits(String(results.totalHits), 'bn'),
  });
  const base = `/category/${slug}`;
  const filtered = filters.json !== null;
  return {
    title: { absolute: title },
    description,
    // Filtered views are many and thin: not indexed, canonical to the category.
    alternates: { canonical: filtered || page === 1 ? base : `${base}?page=${page}` },
    robots: { index: !filtered, follow: true },
    openGraph: { type: 'website', title, description, url: base, locale: 'bn_BD' },
  };
}

/**
 * A category's listings (ADR 039): newest first within the area's radius,
 * numbered pages (each its own URL), filters as a plain form, ItemList and
 * BreadcrumbList JSON-LD.
 */
export default async function CategoryPage(props: Props) {
  const loaded = await load(props);
  if (!loaded) return <NoCoverage />;
  const { slug, name, schema, filters, page, results, totalPages } = loaded;
  const origin = await currentOrigin();
  const t = await getTranslations('category');
  const tl = await getTranslations('listing');
  const words: PriceWords = {
    free: tl('free'),
    priceOnRequest: tl('priceOnRequest'),
    negotiable: tl('negotiable'),
    perMonth: tl('perMonth'),
  };
  const cards = results.hits.map((hit) => cardFromHit(hit, words));
  const base = `/category/${slug}`;
  const crumbs = [
    { name: tl('home'), path: '/' },
    { name, path: base },
  ];
  // Page links keep the filters.
  const query = await props.searchParams;
  const pageHref = (n: number) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (key === 'page' || value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value]) params.append(key, v);
    }
    if (n > 1) params.set('page', String(n));
    const search = params.toString();
    return search ? `${base}?${search}` : base;
  };
  const firstPosition = (page - 1) * results.limit + 1;

  return (
    <>
      <script
        type="application/ld+json"
        // JSON-LD has no other supported form; jsonLdScript escapes the payload.
        dangerouslySetInnerHTML={{
          __html: jsonLdScript(
            itemListJsonLd(
              cards.map((card) => ({
                url: new URL(card.href, origin).toString(),
                name: card.title,
              })),
              firstPosition,
            ),
            breadcrumbJsonLd(crumbs, origin),
          ),
        }}
      />
      <Breadcrumbs items={crumbs} />
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t('heading', { category: name })}</h1>
        <p className="text-sm text-muted-foreground">
          {t('count', { count: localizeDigits(String(results.totalHits), 'bn') })}
        </p>
      </div>

      {schema && (
        <div className="mb-6">
          <CategoryFilters
            schema={schema}
            state={filters.state}
            labels={{
              filters: t('filters'),
              apply: t('apply'),
              clear: t('clear'),
              min: t('min'),
              max: t('max'),
              clearHref: base,
            }}
          />
        </div>
      )}

      {cards.length === 0 ? (
        <p className="py-10 text-center text-muted-foreground">
          {filters.json ? t('emptyFiltered') : t('empty')}
        </p>
      ) : (
        <ListingGrid
          cards={cards}
          badgeLabel={(code) => (tl.has(`badges.${code}`) ? tl(`badges.${code}`) : null)}
          soldLabel={tl('sold')}
          titleLevel={2}
        />
      )}

      {totalPages > 1 && (
        <nav aria-label={t('pagination')} className="mt-8 flex items-center justify-between">
          {page > 1 ? (
            <a rel="prev" href={pageHref(page - 1)} className="text-brand hover:underline">
              {t('previous')}
            </a>
          ) : (
            <span />
          )}
          <span className="text-sm text-muted-foreground">
            {t('page', {
              page: localizeDigits(String(page), 'bn'),
              total: localizeDigits(String(totalPages), 'bn'),
            })}
          </span>
          {page < totalPages ? (
            <a rel="next" href={pageHref(page + 1)} className="text-brand hover:underline">
              {t('next')}
            </a>
          ) : (
            <span />
          )}
        </nav>
      )}
    </>
  );
}
