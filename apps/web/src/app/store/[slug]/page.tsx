import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { BadgeCheck, MapPin } from 'lucide-react';
import { localizeDigits } from '@amar-elaka/dynamic-form';
import { NoCoverage } from '@/components/no-coverage';
import { Breadcrumbs } from '@/components/listings/breadcrumbs';
import { ListingGrid } from '@/components/listings/listing-grid';
import { cardFromPost, type PriceWords } from '@/lib/listings/format';
import { storePage } from '@/lib/listings/load';
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

/** A store's public page (basic, ADR 039): who, where, its listings; LocalBusiness JSON-LD. */
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
            {store.isVerified && (
              <BadgeCheck className="size-6 text-brand" aria-label={t('verified')} />
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
