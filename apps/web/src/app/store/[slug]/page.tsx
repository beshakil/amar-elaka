import type { Metadata, Route } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import { BadgeCheck, MapPin, ShieldCheck } from 'lucide-react';
import { localizeDigits } from '@amar-elaka/dynamic-form';
import { NoCoverage } from '@/components/no-coverage';
import { Breadcrumbs } from '@/components/listings/breadcrumbs';
import { ListingGrid } from '@/components/listings/listing-grid';
import { ReviewItem, ReviewSummary, TierBadge } from '@/components/reviews/review-display';
import { ReviewReportButton } from '@/components/reviews/review-report-button';
import { buttonVariants } from '@/components/ui/button';
import { pickMessages } from '@/lib/i18n-messages';
import { cardFromPost, type PriceWords } from '@/lib/listings/format';
import { storePage } from '@/lib/listings/load';
import { reviewLabels } from '@/lib/reviews/labels';
import { storeReviews } from '@/lib/reviews/load';
import { breadcrumbJsonLd, jsonLdScript } from '@/lib/seo/json-ld';
import { localBusinessJsonLd } from '@/lib/seo/listing-jsonld';
import { currentOrigin, currentTenantConfig } from '@/lib/tenant';

interface Props {
  params: Promise<{ slug: string }>;
}

async function load(params: Props['params']) {
  const { slug } = await params;
  const tenant = await currentTenantConfig();
  if (!tenant) return null;
  const store = await storePage(tenant, slug);
  if (!store) notFound();
  return { tenant, store };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const loaded = await load(params);
  if (!loaded) return {};
  const { tenant, store } = loaded;
  const t = await getTranslations('seo');
  const name = store.name.bn ?? store.name.en ?? store.slug;
  const area = store.area?.bn ?? tenant.nameBn;
  const title = t('storeTitle', { store: name, area, tenant: tenant.nameBn });
  const description =
    store.description?.slice(0, 155) ??
    t('storeDescription', {
      store: name,
      area,
      count: localizeDigits(String(store.posts.length), 'bn'),
    });
  const path = `/store/${store.slug}`;
  const image = store.cover ?? store.logo;
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: path },
    openGraph: {
      type: 'website',
      url: path,
      title,
      description,
      locale: 'bn_BD',
      ...(image ? { images: [{ url: image.url }] } : {}),
    },
  };
}

/** A store's public page (ADR 039): who, where, its seller tier and reviews (ADR 061), its listings; LocalBusiness JSON-LD. */
export default async function StorePage({ params }: Props) {
  const loaded = await load(params);
  if (!loaded) return <NoCoverage />;
  const { tenant, store } = loaded;
  const origin = await currentOrigin();
  const t = await getTranslations('store');
  const tl = await getTranslations('listing');
  const words: PriceWords = {
    free: tl('free'),
    priceOnRequest: tl('priceOnRequest'),
    negotiable: tl('negotiable'),
    perMonth: tl('perMonth'),
  };
  const name = store.name.bn ?? store.name.en ?? store.slug;
  const path = `/store/${store.slug}`;
  const [reviews, labels, tr, messages] = await Promise.all([
    storeReviews(tenant, store.id),
    reviewLabels(),
    getTranslations('reviews'),
    getMessages(),
  ]);
  const crumbs = [
    { name: tl('home'), path: '/' },
    { name, path },
  ];

  return (
    <>
      <script
        type="application/ld+json"
        // JSON-LD has no other supported form; jsonLdScript escapes the payload.
        dangerouslySetInnerHTML={{
          __html: jsonLdScript(
            localBusinessJsonLd(store, new URL(path, origin).toString(), tenant),
            breadcrumbJsonLd(crumbs, origin),
          ),
        }}
      />
      <Breadcrumbs items={crumbs} />
      <header className="flex items-center gap-4">
        {store.logo && (
          // eslint-disable-next-line @next/next/no-img-element -- storage host is not known at build time
          <img
            src={store.logo.url}
            alt=""
            width={72}
            height={72}
            className="size-18 rounded-lg object-cover"
          />
        )}
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            {name}
            {store.isVerified ? (
              <BadgeCheck className="size-6 text-brand" aria-label={t('verified')} />
            ) : (
              store.verification.badge === 'identity' && (
                <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground">
                  <ShieldCheck className="size-3.5" aria-hidden />
                  {t('ownerIdentityChecked')}
                </span>
              )
            )}
            {store.sellerTier !== 'none' && (
              <TierBadge
                tier={store.sellerTier}
                label={labels.tier(store.sellerTier)}
                explain={labels.tierExplain}
              />
            )}
          </h1>
          <p className="flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
            {(store.addressText ?? store.area?.bn) && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="size-4" aria-hidden />
                {[store.addressText, store.area?.bn ?? tenant.nameBn].filter(Boolean).join(', ')}
              </span>
            )}
            <span>
              {t('followers', { count: localizeDigits(String(store.followerCount), 'bn') })}
            </span>
          </p>
        </div>
      </header>
      {store.description && <p className="mt-4 whitespace-pre-line">{store.description}</p>}

      <section
        aria-labelledby="store-reviews"
        className="mt-8 space-y-4"
        data-testid="store-reviews"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="store-reviews" className="text-lg font-semibold">
            {tr('title')}
          </h2>
          {/* Sign-in and the contact rule are checked on the next page, which explains a "not yet". */}
          <Link
            href={`/reviews/write?store=${store.id}&back=${encodeURIComponent(path)}` as Route}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
            rel="nofollow"
            data-testid="review-write"
          >
            {tr('write')}
          </Link>
        </div>
        {reviews && <ReviewSummary summary={reviews.summary} labels={labels} />}
        {!reviews || reviews.items.length === 0 ? (
          <p className="text-muted-foreground">{tr('none')}</p>
        ) : (
          <NextIntlClientProvider messages={pickMessages(messages, ['reviews'])}>
            <div className="divide-y divide-border">
              {reviews.items.map((review) => (
                <ReviewItem
                  key={review.id}
                  review={review}
                  labels={labels}
                  actions={
                    <ReviewReportButton
                      storeId={store.id}
                      reviewId={review.id}
                      loginPath={`/login?next=${encodeURIComponent(path)}`}
                    />
                  }
                />
              ))}
            </div>
          </NextIntlClientProvider>
        )}
      </section>

      <section aria-labelledby="store-listings" className="mt-8">
        <h2 id="store-listings" className="mb-3 text-lg font-semibold">
          {t('listings')}
        </h2>
        {store.posts.length === 0 ? (
          <p className="text-muted-foreground">{t('empty')}</p>
        ) : (
          <ListingGrid
            cards={store.posts.map((card) => cardFromPost(card, words))}
            badgeLabel={(code) => (tl.has(`badges.${code}`) ? tl(`badges.${code}`) : null)}
            soldLabel={tl('sold')}
          />
        )}
      </section>
    </>
  );
}
