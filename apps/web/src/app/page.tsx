import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Phone } from 'lucide-react';
import { formatMoney, localizeDigits } from '@amar-elaka/dynamic-form';
import { NoCoverage } from '@/components/no-coverage';
import { ListingGrid } from '@/components/listings/listing-grid';
import { cardFromHit, type PriceWords } from '@/lib/listings/format';
import { infoCards, recentListings } from '@/lib/listings/load';
import {
  breadcrumbJsonLd,
  jsonLdScript,
  organizationJsonLd,
  webSiteJsonLd,
} from '@/lib/seo/json-ld';
import { currentOrigin, currentTenantConfig, tenantConfigForChrome } from '@/lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  const tenant = await tenantConfigForChrome();
  if (!tenant) return {};
  const t = await getTranslations('seo');
  const title = t('homeTitle', { tenant: tenant.nameBn });
  const description = t('homeDescription', { tenant: tenant.nameBn });
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: '/' },
    openGraph: { type: 'website', url: '/', title, description, locale: 'bn_BD' },
  };
}

/**
 * The tenant's home (ADR 039): categories, the newest listings, today's
 * bazar prices and the emergency numbers — every listing a crawlable link.
 */
export default async function HomePage() {
  const tenant = await currentTenantConfig();
  if (!tenant) return <NoCoverage />;

  const origin = await currentOrigin();
  const t = await getTranslations('home');
  const tl = await getTranslations('listing');
  // The info cards are a nicety: the page stands without them.
  const [recent, info] = await Promise.all([
    recentListings(tenant),
    infoCards(tenant).catch(() => ({ bazar: undefined, emergency: undefined })),
  ]);
  const words: PriceWords = {
    free: tl('free'),
    priceOnRequest: tl('priceOnRequest'),
    negotiable: tl('negotiable'),
    perMonth: tl('perMonth'),
  };
  const { bazar, emergency } = info;

  return (
    <>
      <script
        type="application/ld+json"
        // JSON-LD has no other supported form; jsonLdScript escapes the payload.
        dangerouslySetInnerHTML={{
          __html: jsonLdScript(
            organizationJsonLd(tenant, origin),
            webSiteJsonLd(tenant, origin),
            breadcrumbJsonLd([{ name: tl('home'), path: '/' }], origin),
          ),
        }}
      />

      <section>
        <h1 className="text-3xl font-semibold">{t('heading', { tenant: tenant.nameBn })}</h1>
        <p className="mt-3 text-muted-foreground">{t('body')}</p>
      </section>

      {tenant.enabledCategories.length > 0 && (
        <section className="mt-8" aria-labelledby="categories">
          <h2 id="categories" className="text-xl font-semibold">
            {t('categoriesHeading')}
          </h2>
          <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {tenant.enabledCategories.map((category) => (
              <li key={category.slug}>
                <a
                  href={`/category/${category.slug}`}
                  className="block rounded-lg border border-border bg-card px-4 py-3 hover:bg-muted"
                >
                  {category.nameBn}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-10" aria-labelledby="recent">
        <h2 id="recent" className="mb-4 text-xl font-semibold">
          {t('recentHeading')}
        </h2>
        {recent.hits.length === 0 ? (
          <p className="text-muted-foreground">{t('noRecent')}</p>
        ) : (
          <ListingGrid
            cards={recent.hits.map((hit) => cardFromHit(hit, words))}
            badgeLabel={(code) => (tl.has(`badges.${code}`) ? tl(`badges.${code}`) : null)}
            soldLabel={tl('sold')}
          />
        )}
      </section>

      {(bazar ?? emergency) && (
        <div className="mt-10 grid gap-4 md:grid-cols-2">
          {bazar && (
            <section aria-labelledby="bazar" className="rounded-lg border border-border p-4">
              <h2 id="bazar" className="mb-3 font-semibold">
                {t('bazarHeading')}
              </h2>
              <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-sm">
                {bazar.items.map((item) => (
                  <div key={item.commodity} className="contents">
                    <dt>{item.name.bn ?? item.commodity}</dt>
                    <dd className="font-medium">
                      {t('bazarRange', {
                        min: formatMoney(item.minPrice, 'bn'),
                        max: formatMoney(item.maxPrice, 'bn'),
                        unit: t.has(`units.${item.unit}`) ? t(`units.${item.unit}`) : item.unit,
                      })}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
          {emergency && (
            <section aria-labelledby="emergency" className="rounded-lg border border-border p-4">
              <h2 id="emergency" className="mb-3 font-semibold">
                {t('emergencyHeading')}
              </h2>
              <ul className="flex flex-wrap gap-2">
                {emergency.hotlines.map((hotline) => (
                  <li key={hotline.dial}>
                    <a
                      href={`tel:${hotline.dial}`}
                      className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-sm hover:bg-muted"
                    >
                      <Phone className="size-4" aria-hidden />
                      {hotline.name.bn ?? hotline.serviceType} {localizeDigits(hotline.dial, 'bn')}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </>
  );
}
