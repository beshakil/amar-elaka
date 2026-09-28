import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { localizeDigits } from '@amar-elaka/dynamic-form';
import { NoCoverage } from '@/components/no-coverage';
import { AreaLinks } from '@/components/listings/area-links';
import { Breadcrumbs } from '@/components/listings/breadcrumbs';
import { ListingGrid } from '@/components/listings/listing-grid';
import { cardFromHit, type PriceWords } from '@/lib/listings/format';
import { breadcrumbJsonLd, jsonLdScript } from '@/lib/seo/json-ld';
import { itemListJsonLd } from '@/lib/seo/listing-jsonld';
import { areaListings, categoryAreas } from '@/lib/search/load';
import { currentOrigin, currentTenantConfig } from '@/lib/tenant';

type Query = Record<string, string | string[] | undefined>;
interface Props {
  params: Promise<{ slug: string; area: string }>;
  searchParams: Promise<Query>;
}

const pageOf = (query: Query) => {
  const raw = Array.isArray(query.page) ? query.page[0] : query.page;
  const page = Number(raw ?? '1');
  return Number.isInteger(page) && page >= 1 ? page : 1;
};

/**
 * A category in one area (ADR 042): the long-tail Bengali pages we want to
 * rank for ("মিরপুর ১০-এ বাসা ভাড়া"). They exist only where the area has
 * seo_area_page_min_listings listings in the category (GET
 * /seo/category-areas, counted with the same search this page runs) — the
 * gate 404s the rest, so there is never a thin page to index.
 */
async function load(props: Props) {
  const [{ slug, area }, query] = await Promise.all([props.params, props.searchParams]);
  const tenant = await currentTenantConfig();
  if (!tenant) return null;
  const pairs = await categoryAreas(tenant);
  const pair = pairs.items.find((i) => i.category.slug === slug && i.area.slug === area);
  if (!pair) notFound();
  const page = pageOf(query);
  const results = await areaListings(tenant, slug, area, page);
  const totalPages = Math.max(1, Math.ceil(results.totalHits / Math.max(results.limit, 1)));
  if (page > totalPages) notFound();
  const siblings = pairs.items.filter((i) => i.category.slug === slug && i.area.slug !== area);
  return { tenant, slug, area, pair, page, results, totalPages, siblings };
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const loaded = await load(props);
  if (!loaded) return {};
  const { tenant, slug, area, pair, page, results } = loaded;
  const t = await getTranslations('seo');
  const names = { category: pair.category.name.bn, area: pair.area.name.bn, tenant: tenant.nameBn };
  const title =
    page > 1
      ? t('categoryAreaTitlePage', { ...names, page: localizeDigits(String(page), 'bn') })
      : t('categoryAreaTitle', names);
  const description = t('categoryAreaDescription', {
    ...names,
    count: localizeDigits(String(results.totalHits), 'bn'),
  });
  const base = `/category/${slug}/${area}`;
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: page === 1 ? base : `${base}?page=${page}` },
    robots: { index: true, follow: true },
    openGraph: { type: 'website', title, description, url: base, locale: 'bn_BD' },
  };
}

export default async function CategoryAreaPage(props: Props) {
  const loaded = await load(props);
  if (!loaded) return <NoCoverage />;
  const { slug, area, pair, page, results, totalPages, siblings } = loaded;
  const origin = await currentOrigin();
  const [t, tl] = await Promise.all([getTranslations('category'), getTranslations('listing')]);
  const words: PriceWords = {
    free: tl('free'),
    priceOnRequest: tl('priceOnRequest'),
    negotiable: tl('negotiable'),
    perMonth: tl('perMonth'),
  };
  const cards = results.hits.map((hit) => cardFromHit(hit, words));
  const base = `/category/${slug}/${area}`;
  const heading = t('areaHeading', { area: pair.area.name.bn, category: pair.category.name.bn });
  const crumbs = [
    { name: tl('home'), path: '/' },
    { name: pair.category.name.bn, path: `/category/${slug}` },
    { name: pair.area.name.bn, path: base },
  ];
  const pageHref = (n: number) => (n > 1 ? `${base}?page=${n}` : base);

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
              (page - 1) * results.limit + 1,
            ),
            breadcrumbJsonLd(crumbs, origin),
          ),
        }}
      />
      <Breadcrumbs items={crumbs} />
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">{heading}</h1>
        <p className="text-sm text-muted-foreground">
          {t('count', { count: localizeDigits(String(results.totalHits), 'bn') })}
        </p>
      </div>

      <ListingGrid
        cards={cards}
        badgeLabel={(code) => (tl.has(`badges.${code}`) ? tl(`badges.${code}`) : null)}
        soldLabel={tl('sold')}
        titleLevel={2}
      />

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

      {siblings.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 text-lg font-semibold">
            {t('otherAreas', { category: pair.category.name.bn })}
          </h2>
          <AreaLinks slug={slug} items={siblings} />
        </section>
      )}
    </>
  );
}
