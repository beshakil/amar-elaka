import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { ArrowDown, ArrowUp, Droplet, Moon, Phone } from 'lucide-react';
import { formatMoney, localizeDigits } from '@amar-elaka/dynamic-form';
import { InfoCardList } from '@/components/info/info-card-list';
import { NoCoverage } from '@/components/no-coverage';
import type { PrayerSettings } from '@/lib/api/schemas';
import { prayerSettings } from '@/lib/info/engine';
import { clock } from '@/lib/info/engine-format';
import { localDate, nextPrayer, prayerTimes } from '@/lib/info/prayer';
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
 * bazar prices, the emergency numbers and the info engine's cards (ADR 065)
 * — every listing a crawlable link.
 */
export default async function HomePage() {
  const tenant = await currentTenantConfig();
  if (!tenant) return <NoCoverage />;

  const origin = await currentOrigin();
  const t = await getTranslations('home');
  const tl = await getTranslations('listing');
  const ti = await getTranslations('infoEngine');
  // The info cards are a nicety: the page stands without them.
  const [recent, info] = await Promise.all([
    recentListings(tenant),
    infoCards(tenant).catch(() => ({
      bazar: undefined,
      emergency: undefined,
      blood: undefined,
      info: [],
      prayer: false,
    })),
  ]);
  const words: PriceWords = {
    free: tl('free'),
    priceOnRequest: tl('priceOnRequest'),
    negotiable: tl('negotiable'),
    perMonth: tl('perMonth'),
  };
  const { bazar, emergency, blood } = info;
  // The info engine's cards need the area's clock; a failure only drops them.
  const settings = await prayerSettings(tenant).catch(() => null);
  const next = settings && info.prayer ? upcomingPrayer(settings, tenant.mapCenter) : null;

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

      {settings && (info.info.length > 0 || next) ? (
        <section aria-labelledby="local-info" className="mt-10">
          <h2 id="local-info" className="text-xl font-semibold">
            <Link href="/info" className="hover:underline">
              {t('infoHeading')}
            </Link>
          </h2>
          {next ? (
            <Link
              href="/info/prayer"
              className="mt-4 flex items-center gap-3 rounded-lg border border-border p-4 hover:bg-muted"
            >
              <Moon className="size-6 text-brand" aria-hidden />
              <span>
                <span className="block font-semibold">{ti('hub.prayer')}</span>
                <span className="text-sm">
                  {ti('prayer.next', {
                    name: ti(`prayer.names.${next.prayer}`),
                    time: clock(next.at.toISOString(), settings.timezone),
                  })}
                </span>
              </span>
            </Link>
          ) : null}
          <InfoCardList cards={info.info} timeZone={settings.timezone} showType />
        </section>
      ) : null}

      {(bazar ?? emergency ?? blood) && (
        <div className="mt-10 grid gap-4 md:grid-cols-2">
          {blood && (
            <section
              aria-labelledby="blood"
              className="rounded-lg border border-red-200 bg-red-50 p-4 md:col-span-2 dark:border-red-900 dark:bg-red-950"
            >
              <h2
                id="blood"
                className="flex items-center gap-2 font-semibold text-red-700 dark:text-red-300"
              >
                <Droplet className="size-5" aria-hidden />
                {t('bloodHeading')}
              </h2>
              <p className="mt-1 text-sm">
                {t('bloodBody', {
                  count: localizeDigits(String(blood.openRequests), 'bn'),
                  groups: blood.groups.map(bloodSymbol).join(', '),
                })}
              </p>
            </section>
          )}
          {bazar && (
            <section aria-labelledby="bazar" className="rounded-lg border border-border p-4">
              <h2 id="bazar" className="mb-1 font-semibold">
                <Link href="/info/bazar" className="hover:underline">
                  {t('bazarHeading')}
                </Link>
              </h2>
              {bazar.isStale ? (
                <p className="mb-2 text-xs text-amber-700 dark:text-amber-300">{t('bazarStale')}</p>
              ) : null}
              <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-sm">
                {bazar.items.map((item) => (
                  <div key={item.commodity} className="contents">
                    <dt>{item.name.bn ?? item.commodity}</dt>
                    <dd className="inline-flex items-center gap-1 font-medium">
                      {t('bazarRange', {
                        min: formatMoney(item.minPrice, 'bn'),
                        max: formatMoney(item.maxPrice, 'bn'),
                        unit: t.has(`units.${item.unit}`) ? t(`units.${item.unit}`) : item.unit,
                      })}
                      {item.direction === 'up' ? (
                        <ArrowUp className="size-4 text-red-600" aria-label={t('bazarUp')} />
                      ) : item.direction === 'down' ? (
                        <ArrowDown className="size-4 text-green-700" aria-label={t('bazarDown')} />
                      ) : null}
                    </dd>
                  </div>
                ))}
              </dl>
              {bazar.sponsor ? (
                <p className="mt-2 text-xs text-brand">
                  {t('bazarSponsor', {
                    name: bazar.sponsor.name.bn ?? bazar.sponsor.name.en ?? '',
                  })}
                </p>
              ) : null}
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

/** "B+": the ABO/Rh symbol, the same in every language. */
function bloodSymbol(code: string): string {
  const [abo = '', rh] = code.split('_');
  return `${abo.toUpperCase()}${rh === 'pos' ? '+' : '-'}`;
}

// settings-exempt: one day in milliseconds — a calendar fact
const DAY_MS = 86_400_000;

/** The next prayer at the area's centre (calculated here, ADR 065). */
function upcomingPrayer(s: PrayerSettings, fallback: { lat: number; lng: number }) {
  const at = s.center ?? fallback;
  const now = new Date();
  const options = { method: s.method, asrSchool: s.asrSchool };
  return nextPrayer(
    prayerTimes(localDate(now, s.timezone), at.lat, at.lng, options),
    prayerTimes(localDate(new Date(now.getTime() + DAY_MS), s.timezone), at.lat, at.lng, options),
    now,
  );
}
