import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { MessageCircle } from 'lucide-react';
import { localizeDigits } from '@amar-elaka/dynamic-form';
import { NoCoverage } from '@/components/no-coverage';
import { priceLabel, type PriceWords } from '@/lib/listings/format';
import { storeCatalog } from '@/lib/listings/load';
import { currentTenantConfig } from '@/lib/tenant';

interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ order?: string }>;
}

/** The order route's refusals the page explains (?order=…); anything else reads as "failed". */
const ORDER_ERRORS = ['limit', 'off', 'own', 'gone', 'failed'] as const;
type OrderError = (typeof ORDER_ERRORS)[number];

async function load(params: Props['params']) {
  const { slug } = await params;
  const tenant = await currentTenantConfig();
  if (!tenant) return null;
  const catalog = await storeCatalog(tenant, slug);
  if (!catalog) notFound();
  return { tenant, catalog };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const loaded = await load(params);
  if (!loaded) return {};
  const { store, products } = loaded.catalog;
  const t = await getTranslations('catalog');
  const name = store.name.bn ?? store.name.en ?? store.slug;
  const title = t('seoTitle', { store: name });
  const description = t('seoDescription', {
    store: name,
    count: localizeDigits(String(products.length), 'bn'),
  });
  const path = `/store/${store.slug}/catalog`;
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
      // The share card (ADR 056): drawn by the API, served from this host.
      images: [{ url: `/og/store/${store.slug}`, width: 1200, height: 630 }],
    },
  };
}

/**
 * A store's WhatsApp catalog (ADR 056): photo, price and an order button per
 * live product, light enough for a phone on a slow connection. No phone
 * number is ever in this HTML — each button posts to the order route, which
 * records the lead and only then redirects to WhatsApp.
 */
export default async function StoreCatalogPage({ params, searchParams }: Props) {
  const loaded = await load(params);
  if (!loaded) return <NoCoverage />;
  const { store, products } = loaded.catalog;
  const t = await getTranslations('catalog');
  const tl = await getTranslations('listing');
  const words: PriceWords = {
    free: tl('free'),
    priceOnRequest: tl('priceOnRequest'),
    negotiable: tl('negotiable'),
    perMonth: tl('perMonth'),
  };
  const name = store.name.bn ?? store.name.en ?? store.slug;
  const flag = (await searchParams).order;
  const orderError: OrderError | null =
    flag === undefined ? null : (ORDER_ERRORS.find((e) => e === flag) ?? 'failed');

  return (
    <div className="mx-auto max-w-xl">
      <header className="flex items-center gap-3">
        {store.logo && (
          // eslint-disable-next-line @next/next/no-img-element -- storage host is not known at build time
          <img
            src={store.logo.url}
            alt=""
            width={56}
            height={56}
            className="size-14 rounded-lg object-cover"
          />
        )}
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{t('title', { store: name })}</h1>
          <p className="text-sm text-muted-foreground">
            {t('count', { count: localizeDigits(String(products.length), 'bn') })}
            {' · '}
            <Link href={`/store/${store.slug}`} className="underline">
              {t('storePage')}
            </Link>
          </p>
        </div>
      </header>

      {orderError && (
        <p role="alert" className="mt-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {t(`errors.${orderError}`)}
        </p>
      )}
      {!store.orderable && products.length > 0 && (
        <p className="mt-4 rounded-md bg-muted p-3 text-sm">{t('notOrderable')}</p>
      )}

      {products.length === 0 ? (
        <p className="mt-6 text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="mt-4 grid grid-cols-2 gap-3">
          {products.map((product, i) => (
            <li
              key={product.postId}
              id={`p-${product.postId}`}
              className="flex flex-col overflow-hidden rounded-lg border bg-card"
            >
              {product.photo ? (
                // eslint-disable-next-line @next/next/no-img-element -- storage host is not known at build time
                <img
                  src={product.photo.url}
                  alt={product.title}
                  width={product.photo.width}
                  height={product.photo.height}
                  // The first row is above the fold; the rest wait for the scroll.
                  loading={i < 2 ? 'eager' : 'lazy'}
                  decoding="async"
                  className="aspect-square w-full object-cover"
                />
              ) : (
                <div className="aspect-square w-full bg-muted" aria-hidden />
              )}
              <div className="flex flex-1 flex-col gap-1 p-2">
                <h2 className="line-clamp-2 text-sm font-medium">{product.title}</h2>
                <p className="font-semibold">
                  {priceLabel(product.price, product.priceType, words)}
                </p>
                {store.orderable && (
                  <form
                    method="post"
                    action={`/store/${store.slug}/catalog/order/${product.postId}`}
                    className="mt-auto pt-1"
                  >
                    <button
                      type="submit"
                      className="inline-flex w-full items-center justify-center gap-1 rounded-md bg-[#25D366] px-2 py-2 text-sm font-medium text-white"
                    >
                      <MessageCircle className="size-4" aria-hidden />
                      {t('order')}
                    </button>
                  </form>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
